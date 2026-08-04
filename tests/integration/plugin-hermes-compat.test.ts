import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  convertHermesPlugin,
  detectHermesDependencyIssues,
  detectHermesPluginDir,
  detectHermesToolFailure,
  mapHermesToolResult,
  mapHermesToolSchema,
  normalizeHermesPluginId,
  parseHermesYaml,
  readHermesPluginDir,
  scanStaticTools,
  type HermesConversionInput,
} from "../../src/runtime/plugins/compat/hermes-compat.js";
import { HermesSourceAdapter } from "../../src/runtime/plugins/sources/hermes-source.js";
import {
  SourceIntegrityError,
  SourceResolveError,
  computeArtifactHash,
} from "../../src/runtime/plugins/sources/source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// T7 Hermes 来源与兼容适配（plans/phase-12.md §12.4）
// - L1 识别 plugin.yaml / Python 入口 / 版本元数据；
// - L2 静态 Skills 登记不激活；L3/L4 工具 Schema 与调用结果映射；
// - 依赖 Hermes Agent Loop/Gateway/全局单例/内部数据库 → blocked/degraded 诊断；
// - HermesSourceAdapter 六方法（search/resolve/listVersions/fetchArtifact/
//   verifyArtifact/readProvenance）。
// ═══════════════════════════════════════════════════════════════

const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/plugins/hermes", import.meta.url));

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function createTempDir(prefix = "oc-hermes-compat-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function conversionInput(fixtureName: string): HermesConversionInput {
  const pluginDir = path.join(FIXTURES_ROOT, fixtureName);
  const descriptor = readHermesPluginDir(pluginDir);
  const verification = computeArtifactHash(pluginDir, { exclude: [".git", "__pycache__"] });
  return {
    descriptor,
    sourceRef: { sourceType: "hermes", ref: pluginDir },
    verification,
    hostVersion: "0.1.0",
  };
}

describe("Hermes plugin.yaml 解析与目录识别（L1）", () => {
  it("parseHermesYaml 解析 plugin.yaml 子集", () => {
    const parsed = parseHermesYaml(`
# 注释
name: hermes-minimal
version: 1.2.0
description: "带引号的值"
entry: __init__.py
hooks:
  - pre_tool_call
  - on_session_end
nested:
  enabled: true
  count: 3
`);
    expect(parsed).toMatchObject({
      name: "hermes-minimal",
      version: "1.2.0",
      description: "带引号的值",
      entry: "__init__.py",
      hooks: ["pre_tool_call", "on_session_end"],
      nested: { enabled: true, count: 3 },
    });
  });

  it("detectHermesPluginDir 识别含 plugin.yaml 的目录", () => {
    expect(detectHermesPluginDir(path.join(FIXTURES_ROOT, "minimal"))).toBe(true);
    const empty = createTempDir();
    expect(detectHermesPluginDir(empty)).toBe(false);
  });

  it("readHermesPluginDir 读取名称/版本/入口元数据", () => {
    const descriptor = readHermesPluginDir(path.join(FIXTURES_ROOT, "toolset"));
    expect(descriptor.name).toBe("hermes-toolset");
    expect(descriptor.version).toBe("1.0.0");
    expect(descriptor.entry).toBe("__init__.py");
    expect(descriptor.providesTools).toContain("hermes_sum");
    expect(descriptor.hooks).toEqual([]);
    expect(descriptor.rawYaml.name).toBe("hermes-toolset");
  });

  it("readHermesPluginDir 缺 plugin.yaml / 缺版本 → 完整性错误", () => {
    const missing = createTempDir();
    expect(() => readHermesPluginDir(missing)).toThrow(SourceIntegrityError);

    const badVersion = path.join(createTempDir(), "plugin.yaml");
    fs.writeFileSync(badVersion, "name: no-version\n", "utf8");
    expect(() => readHermesPluginDir(path.dirname(badVersion))).toThrow(/SemVer|版本/);
  });

  it("readHermesPluginDir 入口缺失 → 完整性错误", () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "plugin.yaml"), "name: hermes-missing-entry\nversion: 1.0.0\n", "utf8");
    expect(() => readHermesPluginDir(dir)).toThrow(/Python 入口不存在/);
  });
});

describe("Hermes 工具 Schema 与静态扫描（L3/L4）", () => {
  it("scanStaticTools 从 register_tool 提取工具与 Schema", () => {
    const tools = scanStaticTools(readHermesPluginDir(path.join(FIXTURES_ROOT, "toolset")));
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["hermes_sum", "hermes_boom", "hermes_slow", "hermes_wait", "hermes_crash"]),
    );
    const sum = tools.find((tool) => tool.name === "hermes_sum");
    expect(sum?.inputSchema).toMatchObject({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    });
    expect(sum?.description).toBe("Hermes 求和工具");
    expect(sum?.riskLevel).toBe("medium");
  });

  it("mapHermesToolSchema 只接受对象，非对象省略", () => {
    expect(mapHermesToolSchema({ type: "object", properties: {} })).toEqual({ type: "object", properties: {} });
    expect(mapHermesToolSchema(undefined)).toBeUndefined();
    expect(mapHermesToolSchema("not-a-schema")).toBeUndefined();
  });
});

describe("Hermes 宿主依赖诊断（blocked/degraded 精确中文）", () => {
  it("unsupported 夹具：Agent Loop / 内部模块 / 环境变量诊断", () => {
    const issues = detectHermesDependencyIssues(readHermesPluginDir(path.join(FIXTURES_ROOT, "unsupported")));
    const blocked = issues.filter((issue) => issue.severity === "blocked");
    const degraded = issues.filter((issue) => issue.severity === "degraded");

    expect(issues.some((issue) => issue.code === "agent-loop-hook" && issue.message.includes("Agent Loop"))).toBe(true);
    expect(issues.some((issue) => issue.code === "internal-module" && issue.message.includes("hermes_cli"))).toBe(true);
    expect(issues.some((issue) => issue.code === "agent-loop-inject" && issue.message.includes("inject_message"))).toBe(true);
    expect(issues.some((issue) => issue.code === "host-env" && issue.message.includes("HERMES_HOME"))).toBe(true);
    expect(blocked.length).toBeGreaterThanOrEqual(3);
    expect(degraded.length).toBeGreaterThanOrEqual(1);
  });

  it("toolset 夹具：无宿主依赖诊断", () => {
    const issues = detectHermesDependencyIssues(readHermesPluginDir(path.join(FIXTURES_ROOT, "toolset")));
    expect(issues).toEqual([]);
  });
});

describe("Hermes → OpenColorful 转换（convertHermesPlugin）", () => {
  it("minimal：L4 工具 + L2 静态 Skills 登记（不激活）", () => {
    const result = convertHermesPlugin(conversionInput("minimal"));
    expect(result.normalized.id).toBe("hermes-minimal");
    expect(result.normalized.version).toBe("1.2.0");
    expect(result.normalized.runtime).toMatchObject({ kind: "python-process", entry: "_ocf/worker.py" });
    expect(result.normalized.trust).toBe("full-access");
    expect(result.normalized.source.sourceRef.sourceType).toBe("hermes");
    const tools = result.normalized.contributions.tool;
    expect(tools?.some((tool) => tool.id === "hermes_greet")).toBe(true);
    const skills = result.normalized.contributions["skill-bundle"];
    expect(skills?.[0]).toMatchObject({ id: "skills", skillsDir: "skills" });
    expect(result.compatibility.supported).toBe(true);
    expect(result.compatibility.level).toBe("L5");
    expect(result.compatibility.requiresRuntime).toBe("python-process");
  });

  it("unsupported：blocked + 精确中文 blockedReasons，supported=false", () => {
    const result = convertHermesPlugin(conversionInput("unsupported"));
    expect(result.compatibility.supported).toBe(false);
    expect(result.compatibility.blockedReasons.length).toBeGreaterThanOrEqual(3);
    expect(result.compatibility.blockedReasons.join("；")).toMatch(/Agent Loop|hermes_cli|inject_message/);
    expect(result.compatibility.contributions.some((c) => c.status === "blocked")).toBe(true);
    // blocked 插件的工具贡献为空，运行形态回退 bundle（不产生可执行贡献）
    expect(result.normalized.contributions.tool).toBeUndefined();
    expect(result.normalized.runtime.kind).toBe("bundle");
  });

  it("toolset：全部工具 supported，等级 L5", () => {
    const result = convertHermesPlugin(conversionInput("toolset"));
    expect(result.compatibility.supported).toBe(true);
    expect(result.compatibility.level).toBe("L5");
    expect(result.compatibility.contributions.filter((c) => c.kind === "tool" && c.status === "supported").length).toBe(5);
    expect(result.staticTools.length).toBe(5);
    expect(result.issues).toEqual([]);
  });

  it("normalizeHermesPluginId 归一化不合法插件名", () => {
    expect(normalizeHermesPluginId("disk-cleanup")).toEqual({ pluginId: "disk-cleanup", changed: false });
    expect(normalizeHermesPluginId("My Plugin!")).toEqual({ pluginId: "my-plugin-", changed: true });
    expect(() => normalizeHermesPluginId("")).toThrow(/插件 ID/);
  });
});

describe("Hermes 工具调用结果/异常映射", () => {
  it("mapHermesToolResult 成功透传", () => {
    expect(mapHermesToolResult({ sum: 5 })).toEqual({ ok: true, result: { sum: 5 } });
  });

  it("detectHermesToolFailure 识别 worker 错误帧", () => {
    const failure = detectHermesToolFailure({
      __ocf_hermes_error__: true,
      type: "ValueError",
      message: "hermes boom failure",
      traceback: "Traceback (most recent call last): ...",
    });
    expect(failure?.code).toBe("tool-error");
    expect(failure?.data?.type).toBe("ValueError");
    expect(failure?.data?.traceback).toContain("Traceback");

    expect(detectHermesToolFailure({ __ocf_hermes_error__: true, type: "ResultNotSerializable", message: "x" })?.code).toBe(
      "result-not-serializable",
    );
    expect(detectHermesToolFailure({ sum: 5 })).toBeNull();
  });
});

describe("HermesSourceAdapter（六方法）", () => {
  const adapter = new HermesSourceAdapter({ baseDir: FIXTURES_ROOT });

  it("search 扫描插件目录并过滤查询", () => {
    const all = adapter.search("");
    expect(all.map((item) => item.id).sort()).toEqual(["hermes-minimal", "hermes-toolset", "hermes-unsupported"]);
    expect(adapter.search("toolset")).toHaveLength(1);
    expect(adapter.search("不存在")).toHaveLength(0);
  });

  it("resolve / listVersions 返回固定版本元数据", () => {
    const minimalDir = path.join(FIXTURES_ROOT, "minimal");
    const resolved = adapter.resolve({ sourceType: "hermes", ref: minimalDir });
    expect(resolved.sourceType).toBe("hermes");
    expect(resolved.version).toBe("1.2.0");
    expect(resolved.metadata.entry).toBe("__init__.py");
    expect(adapter.listVersions({ sourceType: "hermes", ref: minimalDir })).toEqual([{ version: "1.2.0", lock: null }]);
  });

  it("fetchArtifact 返回原始包与固定版本", () => {
    const minimalDir = path.join(FIXTURES_ROOT, "minimal");
    const artifact = adapter.fetchArtifact({ sourceType: "hermes", ref: minimalDir });
    expect(artifact.sourceType).toBe("hermes");
    expect(artifact.version).toBe("1.2.0");
    expect(artifact.lock).toBeNull();
    expect(fs.existsSync(path.join(artifact.contentRoot, "plugin.yaml"))).toBe(true);
  });

  it("verifyArtifact 计算确定性 hash（64 hex + 字节数）", () => {
    const minimalDir = path.join(FIXTURES_ROOT, "minimal");
    const artifact = adapter.fetchArtifact({ sourceType: "hermes", ref: minimalDir });
    const verification = adapter.verifyArtifact(artifact);
    expect(verification.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verification.sizeBytes).toBeGreaterThan(0);
    // 确定性：同一目录两次 hash 一致
    const again = adapter.verifyArtifact(artifact);
    expect(again.sha256).toBe(verification.sha256);
  });

  it("readProvenance 保存 plugin.yaml 原文与入口/hooks", () => {
    const minimalDir = path.join(FIXTURES_ROOT, "minimal");
    const artifact = adapter.fetchArtifact({ sourceType: "hermes", ref: minimalDir });
    const provenance = adapter.readProvenance(artifact) as Record<string, unknown>;
    expect(provenance.sourceType).toBe("hermes");
    expect(provenance.sourceFormat).toBe("plugin.yaml@hermes");
    expect((provenance.pluginYaml as Record<string, unknown>).name).toBe("hermes-minimal");
    expect(provenance.entry).toBe("__init__.py");
  });

  it("版本不匹配 / 目录不存在 / 非 Hermes 目录 → 来源错误", () => {
    const minimalDir = path.join(FIXTURES_ROOT, "minimal");
    expect(() => adapter.resolve({ sourceType: "hermes", ref: minimalDir, version: "9.9.9" })).toThrow(/版本不一致/);
    expect(() => adapter.resolve({ sourceType: "hermes", ref: path.join(os.tmpdir(), "no-such-hermes-plugin") })).toThrow(
      SourceResolveError,
    );
    const plain = createTempDir();
    fs.writeFileSync(path.join(plain, "README.md"), "# not a plugin\n", "utf8");
    expect(() => adapter.resolve({ sourceType: "hermes", ref: plain })).toThrow(/plugin\.yaml/);
  });
});
