import { describe, expect, it } from "vitest";
import Value from "typebox/value";

import {
  AgentPluginBindingSchema,
  CompatibilityReportSchema,
  ContributionsSchema,
  ManifestV1Schema,
  NormalizedPluginManifestSchema,
  PermissionRequestSchema,
  PluginExecutionSnapshotSchema,
  PluginGrantSchema,
  PluginRpcRequestSchema,
  PluginRpcResponseSchema,
  PluginSourceRefSchema,
} from "@opencolorful/plugin-protocol";

function validManifest(): unknown {
  return {
    manifestVersion: 1,
    id: "example.sdk-showcase",
    name: "SDK Showcase",
    version: "1.0.0",
    description: "OpenColorful plugin SDK example",
    author: { name: "OpenColorful" },
    license: "MIT",
    compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
    trust: "restricted",
    runtime: { kind: "bundle" },
    permissions: [{ capability: "tool.register", reason: "注册示例工具" }],
    contributions: {
      tool: [{ id: "showcase.echo", name: "Echo", description: "回显", riskLevel: "low" }],
      "skill-bundle": [{ id: "showcase.skills", name: "示例技能目录", skillsDir: "skills" }],
    },
    config: { type: "object", properties: { greeting: { type: "string" } } },
    dev: { sourceDir: "src" },
  };
}

describe("Phase 12 Manifest v1 契约（T1 冻结）", () => {
  it("接受完整合法 Manifest", () => {
    expect(Value.Check(ManifestV1Schema, validManifest())).toBe(true);
  });

  it("未知字段拒绝（additionalProperties: false）", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), smuggled: "x" };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
  });

  it("manifestVersion 必须为 1", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), manifestVersion: 2 };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
  });

  it("id 必须匹配稳定格式（小写开头）", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), id: "Bad_Plugin!" };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
  });

  it("version 必须为 SemVer", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), version: "not-a-version" };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
  });

  it("trust 只允许 restricted / full-access", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), trust: "sandboxed" };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
  });

  it("runtime.kind 只允许四种运行形态", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), runtime: { kind: "wasm" } };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
  });

  it("permissions 使用能力族枚举", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), permissions: [{ capability: "sudo.all" }] };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
  });

  it("contributions 只能声明受支持的扩展点种类", () => {
    const bad = { ...(validManifest() as Record<string, unknown>), contributions: { brain: [{ id: "x", name: "x" }] } };
    expect(Value.Check(ManifestV1Schema, bad)).toBe(false);
    expect(Value.Check(ContributionsSchema, { brain: [{ id: "x", name: "x" }] })).toBe(false);
  });
});

describe("Phase 12 权限 / 绑定 / 快照 / 来源契约（T1 冻结）", () => {
  it("PermissionRequest 只接受能力族", () => {
    expect(Value.Check(PermissionRequestSchema, { capability: "secret.read-own", reason: "读取自身密钥" })).toBe(true);
    expect(Value.Check(PermissionRequestSchema, { capability: "read-root-fs" })).toBe(false);
  });

  it("PluginGrant 带 revision 与决策枚举", () => {
    expect(Value.Check(PluginGrantSchema, {
      pluginId: "example.sdk-showcase", capability: "network.connect", decision: "allowed",
      revision: 1, grantedAt: "2026-08-04T00:00:00.000Z", grantedBy: "user:web",
    })).toBe(true);
    expect(Value.Check(PluginGrantSchema, {
      pluginId: "example.sdk-showcase", capability: "network.connect", decision: "maybe",
      revision: 1, grantedAt: "2026-08-04T00:00:00.000Z", grantedBy: "user:web",
    })).toBe(false);
  });

  it("AgentPluginBinding 引用 grant revision，不替代授权", () => {
    expect(Value.Check(AgentPluginBindingSchema, {
      agentId: "a1", pluginId: "example.sdk-showcase", contributions: ["showcase.echo"],
      grantRevision: 1, enabled: true, updatedAt: "2026-08-04T00:00:00.000Z", revision: 1,
    })).toBe(true);
  });

  it("PluginExecutionSnapshot 冻结版本与贡献集合", () => {
    expect(Value.Check(PluginExecutionSnapshotSchema, {
      version: 1, snapshotId: "snap-1", pluginId: "example.sdk-showcase", pluginVersion: "1.0.0",
      runtimeKind: "bundle", runtimeInstanceId: "ri-1", grantRevision: 1, bindingRevision: 1,
      contributions: ["showcase.echo"], createdAt: "2026-08-04T00:00:00.000Z",
    })).toBe(true);
    expect(Value.Check(PluginExecutionSnapshotSchema, {
      version: 2, snapshotId: "snap-1", pluginId: "example.sdk-showcase", pluginVersion: "1.0.0",
      runtimeKind: "bundle", runtimeInstanceId: "ri-1", grantRevision: 1, bindingRevision: 1,
      contributions: ["showcase.echo"], createdAt: "2026-08-04T00:00:00.000Z",
    })).toBe(false);
  });

  it("PluginSourceRef 只接受受支持来源类型", () => {
    expect(Value.Check(PluginSourceRefSchema, { sourceType: "git", ref: "https://example.com/repo.git", version: "v1.0.0" })).toBe(true);
    expect(Value.Check(PluginSourceRefSchema, { sourceType: "apt", ref: "pkg" })).toBe(false);
  });
});

describe("Phase 12 IPC 契约（T1 冻结）", () => {
  it("RPC 请求携带版本化 JSON-RPC 与可选 carrier", () => {
    expect(Value.Check(PluginRpcRequestSchema, { jsonrpc: "2.0", id: 1, method: "tool.invoke" })).toBe(true);
    expect(Value.Check(PluginRpcRequestSchema, { jsonrpc: "1.0", id: 1, method: "tool.invoke" })).toBe(false);
  });

  it("RPC 响应 result 与 error 二选一（error 需稳定 code/message）", () => {
    expect(Value.Check(PluginRpcResponseSchema, { jsonrpc: "2.0", id: 1, result: { ok: true } })).toBe(true);
    expect(Value.Check(PluginRpcResponseSchema, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } })).toBe(true);
    expect(Value.Check(PluginRpcResponseSchema, { jsonrpc: "2.0", id: 1, result: 1, error: { code: -1, message: "both" } })).toBe(true);
  });
});

describe("Phase 12 兼容报告 / 规范化清单契约（T1 冻结）", () => {
  it("CompatibilityReport 区分 supported/unsupported/degraded/blocked", () => {
    expect(Value.Check(CompatibilityReportSchema, {
      pluginId: "example.sdk-showcase", version: "1.0.0", level: "L4", supported: true,
      missingCapabilities: [], contributions: [{ id: "c1", kind: "tool", status: "supported" }],
      blockedReasons: [], requiresFullAccess: false,
    })).toBe(true);
    expect(Value.Check(CompatibilityReportSchema, {
      pluginId: "example.sdk-showcase", version: "1.0.0", level: "L4", supported: true,
      missingCapabilities: [], contributions: [{ id: "c1", kind: "tool", status: "partial" }],
      blockedReasons: [], requiresFullAccess: false,
    })).toBe(false);
  });

  it("NormalizedPluginManifest 携带来源校验与 provenance", () => {
    const normalized = {
      id: "example.sdk-showcase", name: "SDK Showcase", version: "1.0.0",
      compatibility: { opencolorful: ">=1.0.0", pluginApi: 1 },
      trust: "restricted", runtime: { kind: "bundle" }, permissions: [],
      contributions: {},
      source: {
        sourceRef: { sourceType: "zip", ref: "showcase.zip" },
        verification: { sha256: "a".repeat(64), sizeBytes: 123 },
        provenance: { raw: "原始 Manifest 原文" },
      },
      normalizedAt: "2026-08-04T00:00:00.000Z",
    };
    expect(Value.Check(NormalizedPluginManifestSchema, normalized)).toBe(true);
    // hash 必须是 64 位 hex
    const bad = { ...normalized, source: { ...normalized.source, verification: { sha256: "short", sizeBytes: 1 } } };
    expect(Value.Check(NormalizedPluginManifestSchema, bad)).toBe(false);
  });
});
