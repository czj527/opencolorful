import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

import Value from "typebox/value";

import { describe, expect, it } from "vitest";

import { CompatibilityReportSchema, NormalizedPluginManifestSchema } from "../../src/contracts/plugin-protocol.js";
import { ContributionRegistry } from "../../src/runtime/plugins/contributions/contribution-registry.js";
import { computeArtifactHash } from "../../src/runtime/plugins/sources/source-adapter.js";
import {
  OpenClawCompatError,
  convertOpenClawPlugin,
  toToolContribution,
  type CompatibilityReportMirror,
  type NormalizedPluginManifestMirror,
} from "../../src/runtime/plugins/compat/openclaw-compat.js";

// ═══════════════════════════════════════════════════════════════
// OpenClaw → OpenColorful 兼容转换（tests/fixtures/plugins/openclaw/ 离线 fixture）
//
// 验收：L1-L4 映射与报告一致；OpenClaw 专属能力 blocked/degraded 精确诊断；
// 不把 OpenClaw allow/deny 直接当作 OpenColorful 授权；
// 不支持 contribution 不安装、不启用、不静默丢弃（supported=false → 安装被阻断）。
// ═══════════════════════════════════════════════════════════════

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/plugins/openclaw", import.meta.url));

const HOST_VERSION = "1.0.0";

function fixtureDir(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}

function fixtureManifest(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir(name), "openclaw.plugin.json"), "utf8")) as unknown;
}

function convert(name: string): {
  normalized: NormalizedPluginManifestMirror;
  compatibility: CompatibilityReportMirror;
} {
  const sourceRef = { sourceType: "openclaw" as const, ref: fixtureDir(name) };
  const verification = computeArtifactHash(fixtureDir(name));
  return convertOpenClawPlugin({
    manifest: fixtureManifest(name),
    sourceRef,
    verification,
    hostVersion: HOST_VERSION,
  });
}

describe("Phase 12 OpenClaw 兼容转换 L1（最小插件，仅发现元数据）", () => {
  const { normalized, compatibility } = convert("minimal");

  it("规范化清单映射 L1 元数据与来源", () => {
    expect(normalized.id).toBe("claw.minimal");
    expect(normalized.name).toBe("Claw Minimal");
    expect(normalized.version).toBe("1.0.0");
    expect(normalized.description).toContain("最小 OpenClaw 插件");
    expect(normalized.author).toEqual({ name: "ClawHub Fixture Team", email: "fixtures@clawhub.test" });
    expect(normalized.license).toBe("MIT");
    expect(normalized.runtime).toEqual({ kind: "bundle" });
    expect(normalized.trust).toBe("restricted");
    expect(normalized.permissions).toEqual([]);
    expect(normalized.source.sourceRef.sourceType).toBe("openclaw");
    expect(normalized.source.verification.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Value.Check(NormalizedPluginManifestSchema, normalized)).toBe(true);
  });

  it("兼容报告：L1、supported、无 contribution", () => {
    expect(compatibility.level).toBe("L1");
    expect(compatibility.supported).toBe(true);
    expect(compatibility.pluginId).toBe("claw.minimal");
    expect(compatibility.contributions).toEqual([]);
    expect(compatibility.blockedReasons).toEqual([]);
    expect(compatibility.requiresFullAccess).toBe(false);
    expect(compatibility.requiresRuntime).toBeUndefined();
    expect(Value.Check(CompatibilityReportSchema, compatibility)).toBe(true);
  });
});

describe("Phase 12 OpenClaw 兼容转换 L4（工具插件：工具 + MCP + 命令 + Skills）", () => {
  const { normalized, compatibility } = convert("tools");

  it("运行时映射为 node-process + full-access（OpenClaw 工具是 Node 代码）", () => {
    expect(normalized.runtime).toEqual({ kind: "node-process", entry: "./plugin/dist/index.js" });
    expect(normalized.trust).toBe("full-access");
    expect(compatibility.requiresFullAccess).toBe(true);
    expect(compatibility.requiresRuntime).toBe("node-process");
  });

  it("工具映射为 OpenColorful ToolContribution（名称/Schema/描述/风险）", () => {
    const tools = normalized.contributions.tool as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    const search = tools.find((tool) => tool.id === "claw-web-search");
    expect(search).toBeDefined();
    expect((search as Record<string, unknown>).name).toBe("claw-web-search");
    expect((search as Record<string, unknown>).description).toBe("搜索网页并返回结果摘要");
    expect((search as Record<string, unknown>).riskLevel).toBe("medium");
    expect((search as Record<string, unknown>).inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    });
    expect((search as Record<string, unknown>).outputSchema).toMatchObject({ required: ["results"] });
    const fileRead = tools.find((tool) => tool.id === "claw-file-read");
    expect((fileRead as Record<string, unknown>).riskLevel).toBe("high");
  });

  it("命令、静态 Skills、config 按映射登记（Skills 只登记不激活）", () => {
    const commands = normalized.contributions.command as Array<Record<string, unknown>>;
    expect(commands.map((command) => command.id)).toEqual(["claw-scan"]);
    const skills = normalized.contributions["skill-bundle"] as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: "web-navigation", skillsDir: "./skills/web-navigation" });
  });

  it("MCP 描述进报告（L3），权限请求由映射能力推导", () => {
    expect(compatibility.level).toBe("L4");
    const mcp = compatibility.contributions.find((entry) => entry.kind === "mcp");
    expect(mcp).toMatchObject({ id: "claw-filesystem-mcp", status: "supported" });
    const capabilities = normalized.permissions.map((permission) => permission.capability);
    expect(capabilities).toContain("tool.register");
    expect(capabilities).toContain("process.spawn");
  });

  it("兼容报告：L4、supported、全部 contribution 逐项声明", () => {
    expect(compatibility.level).toBe("L4");
    expect(compatibility.supported).toBe(true);
    const statuses = new Map(compatibility.contributions.map((entry) => [entry.id, entry.status]));
    expect(statuses.get("claw-web-search")).toBe("supported");
    expect(statuses.get("claw-file-read")).toBe("supported");
    expect(statuses.get("claw-filesystem-mcp")).toBe("supported");
    expect(statuses.get("claw-scan")).toBe("supported");
    expect(statuses.get("web-navigation")).toBe("supported");
    expect(compatibility.blockedReasons).toEqual([]);
    expect(Value.Check(CompatibilityReportSchema, compatibility)).toBe(true);
  });

  it("映射后的 contributions 可直接被 T5 ContributionRegistry 登记", () => {
    const { normalized } = convert("tools");
    const registry = new ContributionRegistry();
    const set = registry.register({
      pluginId: normalized.id,
      version: normalized.version,
      contributions: normalized.contributions,
      manifestPermissions: normalized.permissions,
      trust: normalized.trust,
    });
    expect(set.contributions.map((entry) => entry.kind).sort()).toEqual(
      expect.arrayContaining(["tool", "command", "skill-bundle"]),
    );
    const search = registry.get(normalized.id, "claw-web-search");
    expect(search?.kind).toBe("tool");
    expect(search?.spec.inputSchema).toMatchObject({ required: ["query"] });
    expect(registry.get(normalized.id, "claw-scan")?.kind).toBe("command");
    expect(registry.get(normalized.id, "web-navigation")?.kind).toBe("skill-bundle");
  });
});

describe("Phase 12 OpenClaw 专属能力精确诊断（不兼容 contribution 不静默丢弃）", () => {
  const { normalized, compatibility } = convert("unsupported");

  it("Gateway / Channel / ACP / Hook / 内部 API 全部 blocked 且带中文诊断", () => {
    expect(compatibility.supported).toBe(false);
    const blocked = compatibility.contributions.filter((entry) => entry.status === "blocked");
    const ids = blocked.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "openclaw.gateway",
        "openclaw.channel.telegram",
        "openclaw.channel.slack",
        "openclaw.acp",
        "openclaw.hooks",
        "openclaw.internal.@openclaw/core",
      ]),
    );
    for (const entry of blocked) {
      expect(entry.reason).toContain("OpenClaw 专属能力，OpenColorful 不支持");
    }
    expect(compatibility.blockedReasons.length).toBeGreaterThanOrEqual(blocked.length);
    expect(compatibility.blockedReasons[0]).toContain("OpenClaw 专属能力，OpenColorful 不支持");
  });

  it("OpenClaw 调度/事件能力降级提示，命令仍映射为 supported", () => {
    const schedules = compatibility.contributions.find((entry) => entry.id === "openclaw.schedules");
    expect(schedules?.status).toBe("degraded");
    const command = compatibility.contributions.find((entry) => entry.id === "claw-status");
    expect(command).toMatchObject({ status: "supported" });
    expect(compatibility.level).toBe("L2");
  });

  it("OpenClaw allow/deny 不直接成为 OpenColorful 授权", () => {
    // OpenClaw permissions.allow = ["filesystem.write", "network"]，不得进入 normalized.permissions
    const capabilities = normalized.permissions.map((permission) => permission.capability);
    expect(capabilities).not.toContain("filesystem.write");
    expect(capabilities).not.toContain("network");
    expect(capabilities).toEqual([]);
    const permissionEntry = compatibility.contributions.find((entry) => entry.id === "openclaw.permissions");
    expect(permissionEntry?.status).toBe("degraded");
    expect(permissionEntry?.reason).toContain("不会被直接当作 OpenColorful 授权");
  });

  it("整体 supported=false，安装应被阻断（不支持贡献不安装、不启用）", () => {
    expect(compatibility.supported).toBe(false);
    expect(Value.Check(CompatibilityReportSchema, compatibility)).toBe(true);
  });
});

describe("Phase 12 toToolContribution（L4 工具 Schema 与调用适配映射）", () => {
  it("合法工具映射为 supported，Schema/风险默认值正确", () => {
    const mapped = toToolContribution({
      name: "echo",
      description: "回显",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    expect(mapped.status).toBe("supported");
    expect(mapped.contribution).toMatchObject({
      id: "echo",
      name: "echo",
      description: "回显",
      riskLevel: "medium",
    });
    expect(mapped.contribution.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("非法 Schema 的工具降级为 degraded，仍保留映射（不静默丢弃）", () => {
    const mapped = toToolContribution({ name: "bad-schema", schema: "not-an-object" });
    expect(mapped.status).toBe("degraded");
    expect(mapped.reason).toContain("工具输入 Schema 不是对象");
    expect(mapped.contribution.inputSchema).toBeUndefined();
  });

  it("声明 high 风险的工具保留风险等级", () => {
    const mapped = toToolContribution({ name: "danger", schema: {}, risk: "high" });
    expect(mapped.status).toBe("supported");
    expect(mapped.contribution.riskLevel).toBe("high");
  });
});

describe("Phase 12 OpenClaw 兼容转换错误面", () => {
  it("版本不是 SemVer 时抛出精确错误", () => {
    const dir = fixtureDir("minimal");
    const manifest = fixtureManifest("minimal") as Record<string, unknown>;
    expect(() =>
      convertOpenClawPlugin({
        manifest: { ...manifest, version: "latest" },
        sourceRef: { sourceType: "openclaw", ref: dir },
        verification: computeArtifactHash(dir),
        hostVersion: HOST_VERSION,
      }),
    ).toThrow(OpenClawCompatError);
  });

  it("id 无法归一化为合法插件 ID 时抛出精确错误", () => {
    const dir = fixtureDir("minimal");
    const manifest = fixtureManifest("minimal") as Record<string, unknown>;
    expect(() =>
      convertOpenClawPlugin({
        manifest: { ...manifest, id: "_" },
        sourceRef: { sourceType: "openclaw", ref: dir },
        verification: computeArtifactHash(dir),
        hostVersion: HOST_VERSION,
      }),
    ).toThrow(OpenClawCompatError);
  });

  it("重复工具名抛 OpenClawCompatError", () => {
    const dir = fixtureDir("minimal");
    const manifest = fixtureManifest("minimal") as Record<string, unknown>;
    expect(() =>
      convertOpenClawPlugin({
        manifest: {
          ...manifest,
          tools: [
            { name: "dup" },
            { name: "dup" },
          ],
        },
        sourceRef: { sourceType: "openclaw", ref: dir },
        verification: computeArtifactHash(dir),
        hostVersion: HOST_VERSION,
      }),
    ).toThrow(OpenClawCompatError);
  });

  it("engines.opencolorful 范围不满足时报告 blocked", () => {
    const dir = fixtureDir("minimal");
    const manifest = fixtureManifest("minimal") as Record<string, unknown>;
    const result = convertOpenClawPlugin({
      manifest: { ...manifest, engines: { opencolorful: ">=9.0.0" } },
      sourceRef: { sourceType: "openclaw", ref: dir },
      verification: computeArtifactHash(dir),
      hostVersion: HOST_VERSION,
    });
    expect(result.compatibility.supported).toBe(false);
    expect(result.compatibility.blockedReasons[0]).toContain("engines.opencolorful 范围不满足");
  });

  it("纯 MCP 插件映射为 L3，运行时 kind = mcp", () => {
    const dir = fixtureDir("minimal");
    const manifest = fixtureManifest("minimal") as Record<string, unknown>;
    const result = convertOpenClawPlugin({
      manifest: {
        ...manifest,
        mcp: [{ id: "remote-mcp", description: "远程 MCP", url: "https://mcp.test/sse" }],
      },
      sourceRef: { sourceType: "openclaw", ref: dir },
      verification: computeArtifactHash(dir),
      hostVersion: HOST_VERSION,
    });
    expect(result.normalized.runtime).toEqual({ kind: "mcp" });
    expect(result.normalized.trust).toBe("restricted");
    expect(result.compatibility.level).toBe("L3");
    expect(result.normalized.permissions.map((permission) => permission.capability)).toEqual(["network.connect"]);
    const mcpEntry = result.compatibility.contributions.find((entry) => entry.id === "remote-mcp");
    expect(mcpEntry).toMatchObject({ kind: "mcp", status: "supported" });
  });
});
