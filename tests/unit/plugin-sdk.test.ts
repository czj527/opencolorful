import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPlugin,
  defineActivity,
  defineAttachment,
  defineBackground,
  defineCommand,
  defineConfig,
  defineHook,
  definePlugin,
  defineRoute,
  defineSecret,
  defineSkillBundle,
  defineSurface,
  defineTool,
  PluginSdkError,
} from "../../packages/plugin-sdk/src/index.js";

// ═══════════════════════════════════════════════════════════════
// T9 plugin-sdk 辅助函数单测（plans/phase-12.md §15 / §19.1）
// - define* 正例：返回合法 Manifest/Contribution，默认值正确；
// - define* 反例：非法字段立即抛 PluginSdkError（fail-closed）；
// - createPlugin 脚手架：生成当前 Manifest 版本的目录结构。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sdk-"));
  temporaryDirectories.push(dir);
  return dir;
}

describe("definePlugin", () => {
  it("返回合法 Manifest v1 并填充默认值", () => {
    const manifest = definePlugin({
      id: "example.sdk-unit",
      name: "Unit",
      version: "1.0.0",
      permissions: [{ capability: "tool.register" }],
      contributions: { tool: [{ id: "echo", name: "Echo", riskLevel: "low" }] },
    });
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.trust).toBe("restricted");
    expect(manifest.runtime).toEqual({ kind: "bundle" });
    expect(manifest.compatibility).toEqual({ opencolorful: ">=0.1.0", pluginApi: 1 });
    expect(manifest.contributions.tool).toHaveLength(1);
  });

  it("接受显式 trust / runtime / config / dev", () => {
    const manifest = definePlugin({
      id: "example.node",
      name: "Node",
      version: "0.2.0",
      trust: "full-access",
      runtime: { kind: "node-process", entry: "src/index.js" },
      config: { type: "object", properties: { x: { type: "number" } } },
      dev: { sourceDir: ".", engines: { node: ">=18" } },
    });
    expect(manifest.trust).toBe("full-access");
    expect(manifest.runtime.kind).toBe("node-process");
    expect(manifest.config).toBeDefined();
    expect(manifest.dev).toEqual({ sourceDir: ".", engines: { node: ">=18" } });
  });

  it("非法 id 抛 PluginSdkError", () => {
    expect(() => definePlugin({ id: "Bad ID", name: "x", version: "1.0.0" })).toThrow(PluginSdkError);
  });

  it("非法版本抛 PluginSdkError", () => {
    expect(() => definePlugin({ id: "a.b", name: "x", version: "not-semver" })).toThrow(PluginSdkError);
  });

  it("未知 contribution 字段默认拒绝（Schema 校验）", () => {
    expect(() =>
      definePlugin({
        id: "a.b",
        name: "x",
        version: "1.0.0",
        contributions: { tool: [{ id: "t", name: "T", riskLevel: "high", bogus: 1 } as never] } as never,
      }),
    ).toThrow(PluginSdkError);
  });
});

describe("define* contribution 辅助函数", () => {
  it("defineTool 正反例", () => {
    expect(defineTool({ id: "t", name: "T", riskLevel: "low" })).toMatchObject({ id: "t", riskLevel: "low" });
    expect(() => defineTool({ id: "", name: "T" })).toThrow(PluginSdkError);
  });

  it("defineCommand 正例", () => {
    expect(defineCommand({ id: "cmd", name: "Cmd" }).id).toBe("cmd");
  });

  it("defineRoute 缺少 path 抛错", () => {
    expect(() => defineRoute({ id: "r", name: "R" } as never)).toThrow(PluginSdkError);
    expect(defineRoute({ id: "r", name: "R", path: "info" }).path).toBe("info");
  });

  it("defineSurface 校验 kind 且校验 Schema", () => {
    expect(defineSurface({ id: "s", name: "S", entry: "ui/s.html" }, "page").id).toBe("s");
    expect(() => defineSurface({ id: "s", name: "S" }, "bogus" as never)).toThrow(/surface kind/);
    expect(() => defineSurface({ id: "", name: "S" }, "widget")).toThrow(PluginSdkError);
  });

  it("defineConfig / defineSecret / defineBackground / defineHook 正反例", () => {
    expect(defineConfig({ id: "c", name: "C", schema: { type: "object" } }).id).toBe("c");
    expect(() => defineSecret({ id: "k", name: "K" } as never)).toThrow(PluginSdkError);
    expect(defineSecret({ id: "k", name: "K", secretName: "api_key" }).secretName).toBe("api_key");
    expect(defineBackground({ id: "b", name: "B", maxConcurrency: 2 }).maxConcurrency).toBe(2);
    expect(() => defineHook({ id: "h", name: "H" } as never)).toThrow(PluginSdkError);
    expect(defineHook({ id: "h", name: "H", point: "session.started" }).point).toBe("session.started");
  });

  it("defineAttachment / defineActivity / defineSkillBundle 正反例", () => {
    expect(defineAttachment({ id: "at", name: "At", schema: { type: "object" } }).id).toBe("at");
    expect(() => defineActivity({ id: "ev", name: "Ev" } as never)).toThrow(PluginSdkError);
    expect(defineActivity({ id: "ev", name: "Ev", eventNamespace: "plugin.a.b.events" }).eventNamespace).toBe("plugin.a.b.events");
    expect(defineSkillBundle({ id: "sk", name: "Sk", skillsDir: "skills" }).skillsDir).toBe("skills");
  });
});

describe("createPlugin 脚手架", () => {
  it("生成 manifest.json + skills + README + 标记文件", () => {
    const dir = path.join(tempDir(), "my-plugin");
    const result = createPlugin({ id: "my.org-plugin", name: "My Plugin", outDir: dir });
    expect(result.manifest.id).toBe("my.org-plugin");
    expect(result.files).toContain("manifest.json");
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "skills", "example.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".opencolorful-scaffold"))).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { manifestVersion: number };
    expect(parsed.manifestVersion).toBe(1);
  });

  it("includeTool 生成 echo 工具与 dev scenario", () => {
    const dir = path.join(tempDir(), "with-tool");
    const result = createPlugin({ id: "my.org-plugin", name: "My Plugin", outDir: dir, includeTool: true });
    expect(result.manifest.contributions.tool?.[0]?.id).toBe("echo");
    expect(fs.existsSync(path.join(dir, "dev", "scenarios", "echo.json"))).toBe(true);
    expect(result.files).toContain("dev/scenarios/echo.json");
  });

  it("runtimeKind=node-process 生成 src/index.js worker 骨架", () => {
    const dir = path.join(tempDir(), "node-plugin");
    const result = createPlugin({
      id: "my.org-plugin",
      name: "My Plugin",
      outDir: dir,
      runtimeKind: "node-process",
      trust: "full-access",
    });
    expect(result.manifest.runtime).toEqual({ kind: "node-process", entry: "src/index.js" });
    expect(fs.existsSync(path.join(dir, "src", "index.js"))).toBe(true);
  });

  it("非空且非脚手架目录默认拒绝（overwrite 可覆盖）", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "foreign.txt"), "x", "utf8");
    expect(() => createPlugin({ id: "a.b", name: "N", outDir: dir })).toThrow(/非空/);
    const ok = createPlugin({ id: "a.b", name: "N", outDir: dir, overwrite: true });
    expect(ok.manifest.id).toBe("a.b");
  });
});
