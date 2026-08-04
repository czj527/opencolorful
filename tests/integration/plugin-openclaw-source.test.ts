import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SourceResolveError, computeArtifactHash } from "../../src/runtime/plugins/sources/source-adapter.js";
import { OpenClawSourceAdapter, createOpenClawSourceAdapter, parseOpenClawManifest } from "../../src/runtime/plugins/sources/openclaw-source.js";

// ═══════════════════════════════════════════════════════════════
// OpenClaw Source Adapter（tests/fixtures/plugins/openclaw/ 固定版本离线 fixture）
//
// 规则：固定版本/hash，不访问真实 ClawHub；sourceType = "openclaw"。
// ═══════════════════════════════════════════════════════════════

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/plugins/openclaw", import.meta.url));
const FIXTURE_NAMES = ["minimal", "unsupported", "tools"];

function fixtureDir(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}

function readFixtureManifest(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir(name), "openclaw.plugin.json"), "utf8")) as Record<string, unknown>;
}

describe("Phase 12 OpenClaw Source Adapter（识别 openclaw.plugin.json 与兼容 bundle）", () => {
  it("识别 openclaw.plugin.json：fetch/verify/readProvenance 返回固定版本与哈希", () => {
    const adapter = new OpenClawSourceAdapter();
    const artifact = adapter.fetchArtifact({ sourceType: "openclaw", ref: fixtureDir("minimal") });
    expect(artifact.sourceType).toBe("openclaw");
    expect(artifact.version).toBe("1.0.0");
    expect(artifact.lock).toBeNull();
    expect(artifact.contentRoot).toBe(path.resolve(fixtureDir("minimal")));
    const verification = adapter.verifyArtifact(artifact);
    expect(verification.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verification.sizeBytes).toBeGreaterThan(0);
    const provenance = adapter.readProvenance(artifact) as { manifest: Record<string, unknown>; sourceFormat: string };
    expect(provenance.manifest.id).toBe("claw.minimal");
    expect(provenance.sourceFormat).toBe("openclaw.plugin.json@1");
  });

  it("resolve 读取来源元数据：id/name/version/author/描述/依赖", () => {
    const adapter = new OpenClawSourceAdapter();
    const resolved = adapter.resolve({ sourceType: "openclaw", ref: fixtureDir("tools") });
    expect(resolved.sourceType).toBe("openclaw");
    expect(resolved.version).toBe("1.2.0");
    expect(resolved.metadata).toMatchObject({
      id: "claw.tools-basic",
      name: "Claw Tools Basic",
      version: "1.2.0",
    });
    expect((resolved.metadata.author as { name: string }).name).toBe("ClawHub Fixture Team");
    expect(resolved.metadata.dependencies).toMatchObject({ pino: "^8.0.0" });
  });

  it("listVersions 返回 manifest 固定版本，不出现 latest", () => {
    const adapter = new OpenClawSourceAdapter();
    const versions = adapter.listVersions({ sourceType: "openclaw", ref: fixtureDir("unsupported") });
    expect(versions).toEqual([{ version: "0.4.2", lock: null }]);
    expect(versions.some((item) => item.version.toLowerCase() === "latest")).toBe(false);
  });

  it("search 在 baseDir 内发现全部固定 fixture 并按 query 过滤", () => {
    const adapter = new OpenClawSourceAdapter({ baseDir: FIXTURE_ROOT });
    const all = adapter.search("");
    expect(all.map((item) => item.id).sort()).toEqual([...FIXTURE_NAMES.map((name) => (readFixtureManifest(name).id as string))].sort());
    expect(adapter.search("Claw Tools Basic").map((item) => item.id)).toEqual(["claw.tools-basic"]);
    expect(adapter.search("不存在的插件").length).toBe(0);
  });

  it("版本不匹配返回明确错误（禁止静默漂移）", () => {
    const adapter = new OpenClawSourceAdapter();
    expect(() => adapter.fetchArtifact({ sourceType: "openclaw", ref: fixtureDir("minimal"), version: "2.0.0" })).toThrow(
      SourceResolveError,
    );
    expect(() => adapter.resolve({ sourceType: "openclaw", ref: fixtureDir("minimal"), version: "9.9.9" })).toThrow(
      SourceResolveError,
    );
  });

  it("缺少 openclaw.plugin.json 的目录被拒绝", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-empty-"));
    try {
      const adapter = new OpenClawSourceAdapter();
      expect(() => adapter.fetchArtifact({ sourceType: "openclaw", ref: dir })).toThrow(SourceResolveError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("兼容 bundle：单一外层包装目录可被识别为插件根", () => {
    const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundle-"));
    try {
      fs.mkdirSync(path.join(wrapper, "claw-minimal-1.0.0"), { recursive: true });
      fs.copyFileSync(
        path.join(fixtureDir("minimal"), "openclaw.plugin.json"),
        path.join(wrapper, "claw-minimal-1.0.0", "openclaw.plugin.json"),
      );
      const adapter = new OpenClawSourceAdapter();
      const artifact = adapter.fetchArtifact({ sourceType: "openclaw", ref: wrapper });
      expect(artifact.version).toBe("1.0.0");
      expect(artifact.contentRoot).toBe(path.join(wrapper, "claw-minimal-1.0.0"));
    } finally {
      fs.rmSync(wrapper, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("哈希确定性：内容不变两次一致，内容变化后变化", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hash-"));
    try {
      fs.cpSync(fixtureDir("minimal"), path.join(workdir, "plugin"), { recursive: true });
      const adapter = new OpenClawSourceAdapter();
      const first = adapter.verifyArtifact(adapter.fetchArtifact({ sourceType: "openclaw", ref: path.join(workdir, "plugin") }));
      const second = adapter.verifyArtifact(adapter.fetchArtifact({ sourceType: "openclaw", ref: path.join(workdir, "plugin") }));
      expect(second.sha256).toBe(first.sha256);
      fs.writeFileSync(path.join(workdir, "plugin", "README.md"), "# modified\n", "utf8");
      const third = adapter.verifyArtifact(adapter.fetchArtifact({ sourceType: "openclaw", ref: path.join(workdir, "plugin") }));
      expect(third.sha256).not.toBe(first.sha256);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("工厂函数创建同类型 adapter，可被安装器统一接线", () => {
    const adapter = createOpenClawSourceAdapter();
    expect(adapter).toBeInstanceOf(OpenClawSourceAdapter);
    expect(adapter.sourceType).toBe("openclaw");
  });
});

describe("Phase 12 OpenClaw Manifest 解析", () => {
  it("合法 manifest 通过校验，读取 id/version", () => {
    const manifest = parseOpenClawManifest(readFixtureManifest("tools"));
    expect(manifest.id).toBe("claw.tools-basic");
    expect(manifest.version).toBe("1.2.0");
    expect(manifest.tools?.length).toBe(2);
  });

  it("非法 manifest（缺少 name）被拒绝", () => {
    expect(() => parseOpenClawManifest({ id: "claw.bad", version: "1.0.0" })).toThrow();
  });

  it("依赖与 engines 进入 provenance 记录", () => {
    const adapter = new OpenClawSourceAdapter();
    const artifact = adapter.fetchArtifact({ sourceType: "openclaw", ref: fixtureDir("unsupported") });
    const provenance = adapter.readProvenance(artifact) as { dependencies: Record<string, string>; engines: Record<string, string> };
    expect(provenance.dependencies["@openclaw/core"]).toBe("^0.2.0");
    expect(provenance.engines.openclaw).toBe(">=0.2.0");
  });
});
