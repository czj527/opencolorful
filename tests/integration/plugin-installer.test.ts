import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginRegistryStore } from "../../src/storage/plugin-registry-store.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import { LocalSourceAdapter } from "../../src/runtime/plugins/sources/local-source.js";
import { ZipSourceAdapter } from "../../src/runtime/plugins/sources/zip-source.js";
import { GitSourceAdapter } from "../../src/runtime/plugins/sources/git-source.js";
import { NpmSourceAdapter } from "../../src/runtime/plugins/sources/npm-source.js";
import { PluginSourceError, SourceIntegrityError } from "../../src/runtime/plugins/sources/source-adapter.js";
import { PluginInstallError, PluginInstaller, satisfiesOpenColorfulRange } from "../../src/runtime/plugins/installer/plugin-installer.js";
import { PluginRegistry } from "../../src/runtime/plugins/registry/plugin-registry.js";
import { pluginVersionDir } from "../../src/runtime/plugins/paths.js";

const temporaryDirectories: string[] = [];
const openDatabases: Array<ReturnType<typeof openMetadataDatabase>> = [];

function createEnvironment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-plugin-installer-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  fs.mkdirSync(paths.pluginsCache, { recursive: true });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const producer: ProducerContext = {
    component: "agent-server",
    processType: "server",
    processId: "1",
    bootId: "boot",
    appVersion: "test",
    hostPlatform: process.platform,
  };
  const context = new ObservabilityContext({
    database,
    producer,
    logsRoot: path.join(paths.logs, "runtime", "server"),
    spoolRoot: path.join(paths.logs, "emergency"),
  });
  instrument.init(context);
  const adapters = [new LocalSourceAdapter(), new ZipSourceAdapter(), new GitSourceAdapter(), new NpmSourceAdapter()];
  const installer = new PluginInstaller({ paths, adapters, hostVersion: "1.0.0" });
  const store = new PluginRegistryStore(database);
  const registry = new PluginRegistry({ store, installer, paths, audit: context.audit });
  return { dir, paths, database, context, installer, store, registry };
}

function validManifest(version = "1.0.0", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "example.installer",
    name: "Installer Fixture",
    version,
    description: "Phase 12 安装器夹具",
    author: { name: "OpenColorful" },
    license: "MIT",
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: "restricted",
    runtime: { kind: "bundle" },
    permissions: [{ capability: "tool.register", reason: "注册示例工具" }],
    contributions: { tool: [{ id: "installer.echo", name: "Echo", riskLevel: "low" }] },
    ...overrides,
  };
}

function writePluginDir(parent: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(parent, "plugin-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n", "utf8");
  for (const [name, content] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

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

function createZip(entries: ReadonlyArray<{ path: string; content: Buffer | string }>): Buffer {
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
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
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
    central.writeUInt32LE(0, 38);
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

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterEach(() => {
  instrument.reset();
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

describe("Phase 12 兼容范围判定（satisfiesOpenColorfulRange）", () => {
  it("常见范围表达式", () => {
    expect(satisfiesOpenColorfulRange("1.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesOpenColorfulRange("1.0.0", ">=1.1.0")).toBe(false);
    expect(satisfiesOpenColorfulRange("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesOpenColorfulRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfiesOpenColorfulRange("1.5.0", "^1.0.0")).toBe(true);
    expect(satisfiesOpenColorfulRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesOpenColorfulRange("1.2.5", "~1.2.0")).toBe(true);
    expect(satisfiesOpenColorfulRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesOpenColorfulRange("1.4.0", "1.x")).toBe(true);
    expect(satisfiesOpenColorfulRange("2.0.0", "1.x")).toBe(false);
    expect(satisfiesOpenColorfulRange("1.0.0", ">=1.0.0 || >=2.0.0")).toBe(true);
    expect(satisfiesOpenColorfulRange("1.0.0", "2.0.0")).toBe(false);
  });
});

describe("Phase 12 Installer prepare（staging → 校验 → normalize → 兼容报告）", () => {
  it("本地来源 prepare 返回规范化清单与支持级报告", () => {
    const { paths, installer } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("1.0.0"));
    const prepared = installer.prepare({ sourceType: "local", ref: pluginDir });
    expect(prepared.normalized.id).toBe("example.installer");
    expect(prepared.normalized.version).toBe("1.0.0");
    expect(prepared.normalized.source.sourceRef.ref).toBe(pluginDir);
    expect(prepared.compatibility.supported).toBe(true);
    expect(prepared.compatibility.level).toBe("L4"); // tool contribution
    expect(prepared.compatibility.requiresFullAccess).toBe(false);
    expect(prepared.verification.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("未知字段的 manifest 被拒绝（Value.Check(ManifestV1Schema)）", () => {
    const { paths, installer } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, { ...validManifest(), smuggled: "x" });
    expect(() => installer.prepare({ sourceType: "local", ref: pluginDir })).toThrow(PluginInstallError);
  });

  it("opencolorful 版本范围不满足 → 阻断", () => {
    const { paths, installer } = createEnvironment();
    const pluginDir = writePluginDir(
      paths.pluginsCache,
      validManifest("1.0.0", { compatibility: { opencolorful: ">=999.0.0", pluginApi: 1 } }),
    );
    expect(() => installer.prepare({ sourceType: "local", ref: pluginDir })).toThrow(
      /插件不兼容|版本范围/,
    );
  });

  it("代码运行时未声明 full-access → 阻断", () => {
    const { paths, installer } = createEnvironment();
    const pluginDir = writePluginDir(
      paths.pluginsCache,
      validManifest("1.0.0", { trust: "restricted", runtime: { kind: "node-process", entry: "worker.js" } }),
    );
    expect(() => installer.prepare({ sourceType: "local", ref: pluginDir })).toThrow(/full-access/);
  });

  it("full-access 代码运行时 → 支持但 requiresFullAccess=true", () => {
    const { paths, installer } = createEnvironment();
    const pluginDir = writePluginDir(
      paths.pluginsCache,
      validManifest("1.0.0", { trust: "full-access", runtime: { kind: "node-process", entry: "worker.js" } }),
    );
    const prepared = installer.prepare({ sourceType: "local", ref: pluginDir });
    expect(prepared.compatibility.supported).toBe(true);
    expect(prepared.compatibility.requiresFullAccess).toBe(true);
  });

  it("ZIP Slip zip 经 installer.prepare 被拒绝", () => {
    const { paths, installer } = createEnvironment();
    const zipPath = path.join(paths.pluginsCache, "slip.zip");
    fs.writeFileSync(
      zipPath,
      createZip([
        { path: "../evil.txt", content: "pwned" },
        { path: "manifest.json", content: JSON.stringify(validManifest()) },
      ]),
    );
    expect(() => installer.prepare({ sourceType: "zip", ref: zipPath })).toThrow(SourceIntegrityError);
  });

  it("fetch 失败自动记录 plugin.source.fetch_failed", () => {
    const { paths, installer, database } = createEnvironment();
    expect(() => installer.prepare({ sourceType: "local", ref: path.join(paths.pluginsCache, "missing-dir") })).toThrow(
      PluginSourceError,
    );
    const rows = database
      .prepare("SELECT event_name FROM activity_events WHERE event_name = 'plugin.source.fetch_failed'")
      .all() as Array<{ event_name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("完整性失败自动记录 plugin.integrity.failed", () => {
    const { paths, installer, database } = createEnvironment();
    const zipPath = path.join(paths.pluginsCache, "slip2.zip");
    fs.writeFileSync(
      zipPath,
      createZip([{ path: "../evil.txt", content: "pwned" }, { path: "manifest.json", content: JSON.stringify(validManifest()) }]),
    );
    expect(() => installer.prepare({ sourceType: "zip", ref: zipPath })).toThrow(SourceIntegrityError);
    const rows = database
      .prepare("SELECT event_name FROM activity_events WHERE event_name = 'plugin.integrity.failed'")
      .all() as Array<{ event_name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("本地来源含符号链接/Junction 被拒绝", () => {
    const { paths, installer } = createEnvironment();
    const externalDir = fs.mkdtempSync(path.join(paths.pluginsCache, "external-"));
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("1.0.0"));
    let created = false;
    try {
      fs.symlinkSync(externalDir, path.join(pluginDir, "evil-link"), "junction");
      created = true;
    } catch {
      created = false;
    }
    if (!created) {
      // 当前环境无法创建 Junction（需要权限）时跳过
      return;
    }
    expect(() => installer.prepare({ sourceType: "local", ref: pluginDir })).toThrow(SourceIntegrityError);
  });
});

describe("Phase 12 安装 → 不可变版本目录", () => {
  it("本地安装复制到 plugins/installed/<id>/<version>", async () => {
    const { paths, registry } = createEnvironment();
    const pluginDir = writePluginDir(paths.pluginsCache, validManifest("1.0.0"));
    const result = await registry.install(
      { sourceType: "local", ref: pluginDir },
      { actor: { kind: "user", id: "test" } },
    );
    expect(result.version).toBe("1.0.0");
    const versionDir = pluginVersionDir(paths, "example.installer", "1.0.0");
    expect(fs.existsSync(path.join(versionDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(versionDir, "README.md"))).toBe(true);
    // 安装后源目录变化不影响已安装副本（不可变）
    fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(validManifest("9.9.9")), "utf8");
    const stored = JSON.parse(fs.readFileSync(path.join(versionDir, "manifest.json"), "utf8")) as { version: string };
    expect(stored.version).toBe("1.0.0");
  });

  it("git 来源安装排除 .git 目录", async () => {
    const { paths, registry } = createEnvironment();
    const repo = path.join(paths.pluginsCache, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@e.com"]);
    git(repo, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(repo, "manifest.json"), JSON.stringify(validManifest("1.0.0")), "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["tag", "1.0.0"]);
    await registry.install(
      { sourceType: "git", ref: repo, version: "1.0.0" },
      { actor: { kind: "user", id: "test" } },
    );
    const versionDir = pluginVersionDir(paths, "example.installer", "1.0.0");
    expect(fs.existsSync(path.join(versionDir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(versionDir, "manifest.json"))).toBe(true);
  });

  it("健康检查失败 → 安装失败且不留半状态（补偿）", async () => {
    const { paths, registry, store } = createEnvironment();
    // node-process 插件声明入口但缺少入口文件：prepare 通过，healthCheck 失败
    const pluginDir = writePluginDir(
      paths.pluginsCache,
      validManifest("1.0.0", { trust: "full-access", runtime: { kind: "node-process", entry: "worker.js" } }),
    );
    await expect(
      registry.install({ sourceType: "local", ref: pluginDir }, { actor: { kind: "user", id: "test" } }),
    ).rejects.toThrow(/健康检查失败/);
    const versionDir = pluginVersionDir(paths, "example.installer", "1.0.0");
    expect(fs.existsSync(versionDir)).toBe(false);
    expect(store.getInstallation("example.installer", "1.0.0")).toBeUndefined();
    const operations = store.listOperations("example.installer");
    expect(operations.some((op) => op.operation === "install" && op.status === "compensated")).toBe(true);
  });
});
