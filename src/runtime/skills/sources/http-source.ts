import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceCandidate, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { peekSkillManifest } from "../validator.js";
import {
  inspectLocalDirectory,
  type SkillResolvedVersion,
  type SkillSourceAdapter,
  type SkillSourceDiscoveryScope,
  type SkillSourceInspection,
  type SkillStageOptions,
} from "./skill-source-adapter.js";
import { buildStagedPackage, copyPackageTree, locateSkillPackageRoot, toSkillSourceError } from "./stage-utils.js";
import { extractSkillZip, locateEndOfCentralDirectory, parseCentralDirectory } from "./zip-extract.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 HTTP Skill Source（plans/phase-13.md §8.3 / §12.2）
//
// - sourceRef = 可下载的 .zip/.skill 归档 URL；
// - downloader 可注入（默认 curl --silent --location --fail --max-filesize，
//   保证无阻塞同步语义；真实网络接线在 T9），单元测试用 mock；
// - 大小限制（maxPackageBytes）、Content-Type 检查、下载失败明确诊断——
//   网络失败绝不伪装成"没有 Skill"；
// - 解包复用 zip-extract（ZIP Slip/重复路径/大小/文件类型一律 fail-closed）。
// ═══════════════════════════════════════════════════════════════

export interface HttpDownloadResult {
  readonly ok: boolean;
  readonly status: number;
  /** 响应 Content-Type（可空） */
  readonly contentType: string | null;
  /** 失败时为空 Buffer */
  readonly body: Buffer;
  /** 重定向后的最终 URL */
  readonly finalUrl: string;
}

export interface HttpDownloader {
  (url: string, options: { readonly maxBytes: number }): HttpDownloadResult;
}

const DEFAULT_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;

/** 默认下载器：curl（Windows 10+/macOS/Linux 均内置），同步且支持 --max-filesize。 */
function defaultDownloader(): HttpDownloader {
  return (url, options) => {
    const outFile = path.join(fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "ocf-http-")), "download.bin");
    try {
      const stdout = execFileSync(
        "curl",
        [
          "--silent", "--show-error", "--location", "--fail",
          "--max-time", String(Math.floor(HTTP_TIMEOUT_MS / 1000)),
          "--max-filesize", String(options.maxBytes),
          "--output", outFile,
          "--write-out", "%{http_code}|%{content_type}",
          url,
        ],
        { encoding: "utf8", timeout: HTTP_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
      );
      const [statusText, contentType] = stdout.trim().split("|", 2);
      const status = Number(statusText);
      const body = fs.readFileSync(outFile);
      return {
        ok: status >= 200 && status < 300,
        status,
        contentType: contentType !== undefined && contentType !== "" ? contentType : null,
        body,
        finalUrl: url,
      };
    } catch {
      return { ok: false, status: 0, contentType: null, body: Buffer.alloc(0), finalUrl: url };
    } finally {
      fs.rmSync(outFile, { recursive: true, force: true });
    }
  };
}

export class HttpSkillSource implements SkillSourceAdapter {
  readonly kind = "http" as const;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly deps: { readonly downloader?: HttpDownloader; readonly maxBytes?: number } = {},
  ) {}

  discover(_query?: string, _scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[] {
    return [];
  }

  inspect(sourceRef: string): SkillSourceInspection {
    const packageRoot = this.downloadToCache(sourceRef);
    return inspectLocalDirectory(packageRoot);
  }

  stage(sourceRef: string, options?: SkillStageOptions): SkillStagedPackage {
    const stagingRoot = options?.stagingRoot ?? this.tempStagingDir();
    try {
      const downloaded = this.download(sourceRef);
      const unpackRoot = safeStagingJoin(stagingRoot, "unpacked");
      this.unpackDownloaded(downloaded.body, unpackRoot);
      const packageRoot = locateSkillPackageRoot(unpackRoot);
      const stagedRoot = safeStagingJoin(stagingRoot, "package");
      copyPackageTree(packageRoot, stagedRoot, { exclude: [".git"] });
      return buildStagedPackage(stagedRoot, { sourceRef, originalUrl: sourceRef });
    } catch (error) {
      if (error instanceof SkillSourceError) {
        throw error;
      }
      throw new SkillSourceError("skill_source_not_found", error instanceof Error ? error.message : "HTTP 暂存失败");
    }
  }

  resolveVersion(sourceRef: string): SkillResolvedVersion {
    const packageRoot = this.downloadToCache(sourceRef);
    const staged = buildStagedPackage(packageRoot, { sourceRef });
    const peek = peekSkillManifest(packageRoot);
    return { version: peek.version ?? "0.0.0", contentHash: staged.contentHash };
  }

  capabilities(): { search: false; install: true; update: false; offline: false } {
    return { search: false, install: true, update: false, offline: false };
  }

  private downloader(): HttpDownloader {
    return this.deps.downloader ?? defaultDownloader();
  }

  private maxBytes(): number {
    return this.deps.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  }

  private download(url: string): HttpDownloadResult {
    if (!/^https?:\/\//i.test(url.trim())) {
      throw new SkillSourceError("skill_source_not_found", "HTTP 来源必须是 http/https URL");
    }
    const result = this.downloader()(url, { maxBytes: this.maxBytes() });
    if (!result.ok) {
      throw new SkillSourceError(
        "skill_source_not_found",
        `下载失败（HTTP ${result.status === 0 ? "传输错误" : result.status}），请检查来源是否可达`,
      );
    }
    if (result.body.length === 0) {
      throw new SkillSourceError("skill_not_a_complete_package", "下载内容为空，不是完整 Skill 包");
    }
    const contentType = result.contentType ?? "";
    const isTextMarkdown =
      contentType.startsWith("text/plain") ||
      contentType.startsWith("text/markdown") ||
      contentType.startsWith("application/markdown");
    if (isTextMarkdown) {
      throw new SkillSourceError("skill_not_a_complete_package", "下载内容为纯文本/Markdown，不接受裸 Markdown 冒充完整 Skill");
    }
    if (!isZipMagic(result.body)) {
      throw new SkillSourceError("skill_not_a_complete_package", "下载内容不是 ZIP/.skill 归档（不接受裸 skill_content）");
    }
    return result;
  }

  private unpackDownloaded(buffer: Buffer, unpackRoot: string): void {
    if (buffer.length === 0) {
      throw new SkillSourceError("skill_not_a_complete_package", "下载内容为空");
    }
    const eocdOffset = locateEndOfCentralDirectory(buffer);
    const entries = parseCentralDirectory(buffer, eocdOffset);
    if (entries.length === 0) {
      throw new SkillSourceError("skill_not_a_complete_package", "归档为空，不是完整 Skill 包");
    }
    try {
      extractSkillZip(buffer, entries, unpackRoot, { maxFileBytes: 256 * 1024, maxPackageBytes: this.maxBytes(), maxFiles: 4096, allowedExtensions: ALLOWED });
    } catch (error) {
      throw toSkillSourceError(error);
    }
  }

  private downloadToCache(sourceRef: string): string {
    const cacheDir = safeStagingJoin(this.paths.skillsCache, "http");
    fs.mkdirSync(cacheDir, { recursive: true });
    const unpackRoot = safeStagingJoin(cacheDir, `dl-${crypto.createHash("sha1").update(sourceRef).digest("hex").slice(0, 16)}`);
    if (!fs.existsSync(path.join(unpackRoot, "SKILL.md"))) {
      fs.rmSync(unpackRoot, { recursive: true, force: true });
      const downloaded = this.download(sourceRef);
      this.unpackDownloaded(downloaded.body, unpackRoot);
    }
    return unpackRoot;
  }

  private tempStagingDir(): string {
    fs.mkdirSync(this.paths.skillsStaging, { recursive: true });
    return fs.mkdtempSync(path.join(this.paths.skillsStaging, "http-"));
  }
}

function isZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function safeStagingJoin(root: string, ...segments: string[]): string {
  const joined = path.join(root, ...segments);
  const relative = path.relative(path.resolve(root), path.resolve(joined));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SkillSourceError("skill_path_escape", "暂存路径逃逸，已拒绝");
  }
  return joined;
}

const ALLOWED = [
  ".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".csv", ".tsv",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".pdf",
  ".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts",
  ".hbs", ".mustache", ".liquid", ".jinja", ".jinja2", ".tmpl", ".ipynb",
];
