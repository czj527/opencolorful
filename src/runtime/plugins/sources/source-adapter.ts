import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Value from "typebox/value";

import { PluginSourceRefSchema, type PluginSourceType } from "../../../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// 本地镜像类型（TypeBox 1.3.6 Static 缺陷 workaround）
//
// T1 冻结的协议 d.ts 中，凡经 `Type.Union(arr.map(...))` 构建的 Schema，
// `Static<typeof Schema>` 会解析为 never（TypeBox 1.3.6 对非 tuple 数组
// 的 TUnion 静态推断缺陷）。冻结的 Schema（值）仍用于运行时 Value.Check，
// 这里用显式结构类型镜像契约形状，仅供内部类型标注。
// ═══════════════════════════════════════════════════════════════

export interface PluginSourceRef {
  readonly sourceType: PluginSourceType;
  readonly ref: string;
  readonly version?: string;
  readonly lock?: string;
}

export interface ArtifactVerification {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly provenance?: unknown;
}

export interface NormalizedSource {
  readonly sourceRef: PluginSourceRef;
  readonly verification: ArtifactVerification;
  readonly provenance?: unknown;
}

// ═══════════════════════════════════════════════════════════════
// Phase 12 Plugin Source Adapter（plans/phase-12.md §12.1 / §6）
//
// - Source Adapter 只负责发现、解析、获取 Artifact 与返回元数据/provenance，
//   不能直接启用或执行插件；
// - 统一接口：search / resolve / listVersions / fetchArtifact /
//   verifyArtifact / readProvenance；
// - Git/npm 来源必须固定版本/commit，禁止自动拉取 latest；
// - fetch/校验失败返回明确错误（PluginSourceError + 稳定 reasonCode），
//   由平台 wrapper 记录 plugin.source.fetch_failed / quarantined。
// ═══════════════════════════════════════════════════════════════

export class PluginSourceError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "PluginSourceError";
    this.reasonCode = reasonCode;
  }
}

export class SourceResolveError extends PluginSourceError {
  constructor(reasonCode: string, message: string) {
    super(reasonCode, message);
    this.name = "SourceResolveError";
  }
}

export class SourceFetchError extends PluginSourceError {
  constructor(reasonCode: string, message: string) {
    super(reasonCode, message);
    this.name = "SourceFetchError";
  }
}

export class SourceIntegrityError extends PluginSourceError {
  constructor(reasonCode: string, message: string) {
    super(reasonCode, message);
    this.name = "SourceIntegrityError";
  }
}

export class SourceUnsupportedError extends PluginSourceError {
  constructor(message: string) {
    super("source_unsupported", message);
    this.name = "SourceUnsupportedError";
  }
}

export interface SourceSearchResult {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly description?: string;
  readonly sourceType: PluginSourceType;
}

export interface SourceVersionInfo {
  readonly version: string;
  readonly lock: string | null;
  readonly publishedAt?: string;
}

export interface ResolvedSource {
  readonly sourceType: PluginSourceType;
  readonly ref: string;
  readonly version: string | null;
  readonly lock: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface FetchedArtifact {
  readonly sourceType: PluginSourceType;
  readonly ref: string;
  /** 固定后的版本（读取 manifest/package 后确定） */
  readonly version: string;
  readonly lock: string | null;
  /** 插件内容根目录（解包后本地目录），由安装器复制进不可变版本目录 */
  readonly contentRoot: string;
  readonly metadata: Record<string, unknown>;
}

export interface PluginSourceAdapter {
  readonly sourceType: PluginSourceType;
  search(query: string): readonly SourceSearchResult[];
  resolve(sourceRef: PluginSourceRef): ResolvedSource;
  listVersions(sourceRef: PluginSourceRef): readonly SourceVersionInfo[];
  fetchArtifact(sourceRef: PluginSourceRef, options?: { readonly stagingDir?: string }): FetchedArtifact;
  verifyArtifact(artifact: FetchedArtifact): ArtifactVerification;
  readProvenance(artifact: FetchedArtifact): unknown;
}

/** 跨进程/用户输入校验：来源引用必须先通过冻结 Schema。 */
export function assertPluginSourceRef(input: unknown): PluginSourceRef {
  if (!Value.Check(PluginSourceRefSchema, input)) {
    throw new PluginSourceError("invalid_source_ref", "来源引用格式非法");
  }
  return input as PluginSourceRef;
}

export function assertSourceTypeSupported(
  adapter: PluginSourceAdapter | undefined,
  sourceType: PluginSourceType,
): asserts adapter is PluginSourceAdapter {
  if (adapter === undefined) {
    throw new PluginSourceError("unsupported_source", `来源类型不受支持：${sourceType}`);
  }
}

/** 读取插件根目录下的原生 manifest.json（原始内容，供 provenance 与校验）。 */
export function readManifestFile(contentRoot: string): unknown {
  const manifestPath = path.join(contentRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new SourceIntegrityError("manifest_missing", "插件包缺少 manifest.json");
  }
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new SourceIntegrityError("manifest_unreadable", "插件包 manifest.json 无法读取");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SourceIntegrityError("manifest_invalid_json", "插件包 manifest.json 不是合法 JSON");
  }
}

/** 提取插件 manifest.version（非空字符串才返回，否则 null）。 */
export function manifestVersion(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const version = (raw as Record<string, unknown>).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/** 提取插件 manifest.id（非空字符串才返回，否则 null）。 */
export function manifestId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const id = (raw as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Artifact 确定性哈希：按相对路径排序，逐文件 sha256（路径 + NUL + 内容 + NUL）。
 * 拒绝符号链接/Junction 与非常规文件类型；.git / node_modules 目录可按需排除。
 */
export function computeArtifactHash(
  contentRoot: string,
  options: { readonly exclude?: readonly string[] } = {},
): ArtifactVerification {
  const root = path.resolve(contentRoot);
  const exclude = new Set((options.exclude ?? []).map((name) => name.replace(/\\/g, "/")));
  const files: Array<{ rel: string; abs: string }> = [];
  const pending = [root];
  let sizeBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop() as string;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new SourceIntegrityError("symlink_in_artifact", "插件内容包含符号链接或 Junction，已拒绝");
    }
    const relative = path.relative(root, current).replace(/\\/g, "/");
    if (relative !== "" && exclude.has(relative)) {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      sizeBytes += stat.size;
      files.push({ rel: relative === "" ? path.basename(current) : relative, abs: current });
    } else {
      throw new SourceIntegrityError("special_file_in_artifact", "插件内容包含非常规文件类型，已拒绝");
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(fs.readFileSync(file.abs));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}
