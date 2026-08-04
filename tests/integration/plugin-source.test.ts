import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import {
  PluginSourceError,
  SourceIntegrityError,
  SourceResolveError,
} from "../../src/runtime/plugins/sources/source-adapter.js";
import { LocalSourceAdapter } from "../../src/runtime/plugins/sources/local-source.js";
import { ZipSourceAdapter } from "../../src/runtime/plugins/sources/zip-source.js";
import { GitSourceAdapter } from "../../src/runtime/plugins/sources/git-source.js";
import { NpmSourceAdapter } from "../../src/runtime/plugins/sources/npm-source.js";

const temporaryDirectories: string[] = [];
const openDatabases: Array<ReturnType<typeof openMetadataDatabase>> = [];

function createHome(): { dir: string; paths: ReturnType<typeof getRuntimePaths> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-plugin-source-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  fs.mkdirSync(paths.pluginsCache, { recursive: true });
  return { dir, paths };
}

function validManifest(version = "1.0.0", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "example.source",
    name: "Source Fixture",
    version,
    description: "Phase 12 来源适配器夹具",
    author: { name: "OpenColorful" },
    license: "MIT",
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: "restricted",
    runtime: { kind: "bundle" },
    permissions: [{ capability: "tool.register", reason: "注册示例工具" }],
    contributions: { tool: [{ id: "source.echo", name: "Echo", riskLevel: "low" }] },
    ...overrides,
  };
}

function writePluginDir(parent: string, manifest: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(parent, "plugin-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n", "utf8");
  return dir;
}

// ── ZIP 夹具生成器（镜像 zip-source.ts 的读取逻辑，纯 Node 实现） ──

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(content: Buffer): number {
  let crc = -1;
  for (let i = 0; i < content.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ content[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ -1) >>> 0;
}

function createZip(entries: ReadonlyArray<{ path: string; content: Buffer | string; symlink?: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const compressed = zlib.deflateRawSync(content);
    const crc = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const externalAttrs = entry.symlink === true ? ((0o120000 << 16) | 0o644) >>> 0 : 0;
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += localHeader.length + name.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ── Git 夹具：初始化本地仓库并提交 ──

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createGitRepo(repo: string, manifest: Record<string, unknown>): string {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(repo, "README.md"), "# git fixture\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return git(repo, ["rev-parse", "HEAD"]);
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("Phase 12 Local Source Adapter", () => {
  it("fetch/verify/readProvenance 返回版本、哈希与 provenance", () => {
    const { paths } = createHome();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("1.0.0"));
    const adapter = new LocalSourceAdapter();
    const artifact = adapter.fetchArtifact({ sourceType: "local", ref: pluginDir });
    expect(artifact.version).toBe("1.0.0");
    expect(artifact.contentRoot).toBe(pluginDir);
    const verification = adapter.verifyArtifact(artifact);
    expect(verification.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verification.sizeBytes).toBeGreaterThan(0);
    const provenance = adapter.readProvenance(artifact) as { manifest: Record<string, unknown> };
    expect(provenance.manifest).toMatchObject({ id: "example.source" });
    const resolved = adapter.resolve({ sourceType: "local", ref: pluginDir });
    expect(resolved.version).toBe("1.0.0");
  });

  it("search 在 baseDir 内发现插件并过滤 query", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-local-search-"));
    temporaryDirectories.push(baseDir);
    writePluginDir(baseDir, validManifest("2.0.0"));
    const adapter = new LocalSourceAdapter({ baseDir });
    expect(adapter.search("").length).toBe(1);
    expect(adapter.search("Source Fixture").length).toBe(1);
    expect(adapter.search("不存在的插件").length).toBe(0);
  });

  it("版本不匹配返回明确错误", () => {
    const { paths } = createHome();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("1.0.0"));
    const adapter = new LocalSourceAdapter();
    expect(() => adapter.fetchArtifact({ sourceType: "local", ref: pluginDir, version: "2.0.0" })).toThrow(
      SourceResolveError,
    );
  });

  it("缺少 manifest.json 返回完整性错误", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-local-empty-"));
    temporaryDirectories.push(dir);
    const adapter = new LocalSourceAdapter();
    expect(() => adapter.fetchArtifact({ sourceType: "local", ref: dir })).toThrow(SourceIntegrityError);
  });

  it("hash 随文件内容变化而变化（不可篡改校验）", () => {
    const { paths } = createHome();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("1.0.0"));
    const adapter = new LocalSourceAdapter();
    const first = adapter.verifyArtifact(adapter.fetchArtifact({ sourceType: "local", ref: pluginDir }));
    fs.writeFileSync(path.join(pluginDir, "README.md"), "# modified\n", "utf8");
    const second = adapter.verifyArtifact(adapter.fetchArtifact({ sourceType: "local", ref: pluginDir }));
    expect(second.sha256).not.toBe(first.sha256);
  });
});

describe("Phase 12 ZIP Source Adapter（含 ZIP Slip/symlink 防护）", () => {
  it("解包合法 zip 并计算哈希", () => {
    const { paths } = createHome();
    const zipPath = path.join(paths.pluginsCache, "fixture.zip");
    const manifest = validManifest("1.0.0");
    fs.writeFileSync(
      zipPath,
      createZip([
        { path: "manifest.json", content: JSON.stringify(manifest) },
        { path: "sub/README.md", content: "# zip\n" },
      ]),
    );
    const adapter = new ZipSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-zip-stage-"));
    temporaryDirectories.push(staging);
    const artifact = adapter.fetchArtifact({ sourceType: "zip", ref: zipPath }, { stagingDir: staging });
    expect(artifact.version).toBe("1.0.0");
    expect(fs.existsSync(path.join(artifact.contentRoot, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifact.contentRoot, "sub", "README.md"))).toBe(true);
    expect(adapter.verifyArtifact(artifact).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ZIP Slip（父目录穿越）条目被拒绝", () => {
    const { paths } = createHome();
    const zipPath = path.join(paths.pluginsCache, "slip.zip");
    fs.writeFileSync(
      zipPath,
      createZip([{ path: "../evil.txt", content: "pwned" }, { path: "manifest.json", content: JSON.stringify(validManifest()) }]),
    );
    const adapter = new ZipSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-zip-slip-"));
    temporaryDirectories.push(staging);
    expect(() => adapter.fetchArtifact({ sourceType: "zip", ref: zipPath }, { stagingDir: staging })).toThrow(
      SourceIntegrityError,
    );
    expect(fs.existsSync(path.join(path.dirname(staging), "evil.txt"))).toBe(false);
  });

  it("绝对路径条目被拒绝", () => {
    const { paths } = createHome();
    const zipPath = path.join(paths.pluginsCache, "abs.zip");
    fs.writeFileSync(
      zipPath,
      createZip([{ path: "/etc/evil", content: "pwned" }, { path: "manifest.json", content: JSON.stringify(validManifest()) }]),
    );
    const adapter = new ZipSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-zip-abs-"));
    temporaryDirectories.push(staging);
    expect(() => adapter.fetchArtifact({ sourceType: "zip", ref: zipPath }, { stagingDir: staging })).toThrow(
      SourceIntegrityError,
    );
  });

  it("Unix 符号链接条目被拒绝", () => {
    const { paths } = createHome();
    const zipPath = path.join(paths.pluginsCache, "symlink.zip");
    fs.writeFileSync(
      zipPath,
      createZip([
        { path: "manifest.json", content: JSON.stringify(validManifest()) },
        { path: "link", content: "target", symlink: true },
      ]),
    );
    const adapter = new ZipSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-zip-link-"));
    temporaryDirectories.push(staging);
    expect(() => adapter.fetchArtifact({ sourceType: "zip", ref: zipPath }, { stagingDir: staging })).toThrow(
      SourceIntegrityError,
    );
  });

  it("缺少 manifest.json 的 zip 被拒绝", () => {
    const { paths } = createHome();
    const zipPath = path.join(paths.pluginsCache, "nomanifest.zip");
    fs.writeFileSync(zipPath, createZip([{ path: "README.md", content: "# x\n" }]));
    const adapter = new ZipSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-zip-empty-"));
    temporaryDirectories.push(staging);
    expect(() => adapter.fetchArtifact({ sourceType: "zip", ref: zipPath }, { stagingDir: staging })).toThrow(
      SourceIntegrityError,
    );
  });
});

describe("Phase 12 Git Source Adapter（固定 commit/tag，禁止 latest）", () => {
  it("固定 tag 检出内容并返回 commit 作为 lock", () => {
    const { paths } = createHome();
    const repo = path.join(paths.pluginsCache, "repo");
    const manifest = validManifest("1.0.0");
    const commit = createGitRepo(repo, manifest);
    git(repo, ["tag", "1.0.0"]);
    const adapter = new GitSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-git-stage-"));
    temporaryDirectories.push(staging);
    const artifact = adapter.fetchArtifact({ sourceType: "git", ref: repo, version: "1.0.0" }, { stagingDir: staging });
    expect(artifact.version).toBe("1.0.0");
    expect(artifact.lock).toMatch(/^[0-9a-f]{40}$/);
    expect(artifact.lock).toBe(commit);
    const provenance = adapter.readProvenance(artifact) as { commit: string };
    expect(provenance.commit).toBe(commit);
  });

  it("不固定 commit/tag 时拒绝（禁止 latest 自动拉取）", () => {
    const { paths } = createHome();
    const repo = path.join(paths.pluginsCache, "repo-no-pin");
    createGitRepo(repo, validManifest("1.0.0"));
    const adapter = new GitSourceAdapter();
    expect(() => adapter.resolve({ sourceType: "git", ref: repo })).toThrow(SourceResolveError);
  });

  it("不存在的 commit/tag 返回明确错误", () => {
    const { paths } = createHome();
    const repo = path.join(paths.pluginsCache, "repo-bad-pin");
    createGitRepo(repo, validManifest("1.0.0"));
    const adapter = new GitSourceAdapter();
    expect(() => adapter.resolve({ sourceType: "git", ref: repo, version: "v999.0.0" })).toThrow(SourceResolveError);
  });

  it("verifyArtifact 排除 .git，hash 稳定", () => {
    const { paths } = createHome();
    const repo = path.join(paths.pluginsCache, "repo-verify");
    createGitRepo(repo, validManifest("1.0.0"));
    git(repo, ["tag", "1.0.0"]);
    const adapter = new GitSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-git-verify-"));
    temporaryDirectories.push(staging);
    const artifact = adapter.fetchArtifact({ sourceType: "git", ref: repo, version: "1.0.0" }, { stagingDir: staging });
    const verification = adapter.verifyArtifact(artifact);
    expect(verification.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("版本与 manifest 不一致返回 version_mismatch", () => {
    const { paths } = createHome();
    const repo = path.join(paths.pluginsCache, "repo-mismatch");
    createGitRepo(repo, validManifest("1.0.0"));
    git(repo, ["tag", "2.0.0"]);
    const adapter = new GitSourceAdapter();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-git-mismatch-"));
    temporaryDirectories.push(staging);
    expect(() => adapter.fetchArtifact({ sourceType: "git", ref: repo, version: "2.0.0" }, { stagingDir: staging })).toThrow(
      SourceResolveError,
    );
  });
});

describe("Phase 12 npm-compatible Source Adapter", () => {
  it("从本地包目录解析并固定版本", () => {
    const { paths } = createHome();
    const packageDir = fs.mkdtempSync(path.join(paths.pluginsCache, "npm-pkg-"));
    temporaryDirectories.push(packageDir);
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@fixture/echo", version: "1.0.0", description: "npm fixture" }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(validManifest("1.0.0")), "utf8");
    const adapter = new NpmSourceAdapter();
    const artifact = adapter.fetchArtifact({ sourceType: "npm", ref: packageDir, version: "1.0.0" });
    expect(artifact.version).toBe("1.0.0");
    expect(adapter.verifyArtifact(artifact).sha256).toMatch(/^[0-9a-f]{64}$/);
    const provenance = adapter.readProvenance(artifact) as { package: { name: string } };
    expect(provenance.package.name).toBe("@fixture/echo");
  });

  it("manifest 版本与 package.json 版本不一致被拒绝", () => {
    const { paths } = createHome();
    const packageDir = fs.mkdtempSync(path.join(paths.pluginsCache, "npm-pkg-bad-"));
    temporaryDirectories.push(packageDir);
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@fixture/bad", version: "1.0.0" }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(validManifest("2.0.0")), "utf8");
    const adapter = new NpmSourceAdapter();
    expect(() => adapter.fetchArtifact({ sourceType: "npm", ref: packageDir })).toThrow(SourceResolveError);
  });

  it("registryRoot 内按包名发现并 search", () => {
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "npm-registry-"));
    temporaryDirectories.push(registryRoot);
    const packageDir = path.join(registryRoot, "echo-fixture");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "echo-fixture", version: "1.2.0", description: "echo" }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(validManifest("1.2.0")), "utf8");
    const adapter = new NpmSourceAdapter({ registryRoot });
    expect(adapter.search("echo").length).toBe(1);
    const artifact = adapter.fetchArtifact({ sourceType: "npm", ref: "echo-fixture", version: "1.2.0" });
    expect(artifact.version).toBe("1.2.0");
  });
});

describe("Phase 12 Source 错误面", () => {
  it("非法来源引用被 Schema 拒绝", () => {
    const adapter = new LocalSourceAdapter();
    expect(() => adapter.resolve({ sourceType: "apt", ref: "pkg" } as never)).toThrow(PluginSourceError);
  });
});
