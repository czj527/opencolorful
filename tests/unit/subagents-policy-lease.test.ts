import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { WorkspaceLeaseStore } from "../../src/runtime/subagents/stores/workspace-lease-store.js";
import { WorkspaceMutationLeaseService, SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS, PARENT_WRITE_LEASE_DEFAULT_TTL_MS } from "../../src/runtime/subagents/workspace-lease-service.js";
import {
  classifyToolSideEffect,
  computeCapabilityCeilingHash,
  computeEffectiveSnapshot,
  defaultCapabilityCeiling,
  isToolAllowedInReadRun,
  normalizeCapabilityRequest,
  normalizeSubagentRunLimits,
  resolveSubagentModel,
  summarizeEffectiveSnapshot,
  stableSerialize,
  type EffectiveSnapshotInput,
  type ParentModelRef,
} from "../../src/runtime/subagents/delegation-policy.js";
import { SUBAGENT_RUN_LIMITS_MAXIMUM } from "../../src/contracts/subagents.js";
import { skillRefKey, type SkillRef } from "../../src/contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T3 测试：DelegationPolicy + WorkspaceMutationLeaseService
// （plans/phase-14.md §10.2 / §12 / §15.2 / §18.3）
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagent-lease-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const db = openMetadataDatabase(paths.database);
  return { db, paths };
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      /* ignore */
    }
  }
});

const WORKSPACE = "D:\\work\\project";

const FAUX: ParentModelRef = { providerId: "faux", modelId: "faux-1" };

// ── 模型解析（§10.2）────────────────────────────────────────────

describe("resolveSubagentModel 优先级（§10.2）", () => {
  it("user_default 优先；传相同模型允许（source=user_default）；不同模型 → override_denied", () => {
    const resolve = () => true;
    const withUserDefault = resolveSubagentModel({
      userDefault: FAUX,
      parentRequest: FAUX,
      parentInherited: { providerId: "other", modelId: "m" },
      resolveModel: resolve,
    });
    expect(withUserDefault.status).toBe("resolved");
    if (withUserDefault.status === "resolved") {
      expect(withUserDefault.source).toBe("user_default");
    }
    const override = resolveSubagentModel({
      userDefault: FAUX,
      parentRequest: { providerId: "other", modelId: "m" },
      parentInherited: null,
      resolveModel: resolve,
    });
    expect(override.status).toBe("error");
    if (override.status === "error") {
      expect(override.code).toBe("subagent_model_override_denied");
    }
  });

  it("user_default 为空 → parent_request；再空 → parent_inherited", () => {
    const resolve = () => true;
    const request = resolveSubagentModel({ userDefault: null, parentRequest: FAUX, parentInherited: null, resolveModel: resolve });
    expect(request.status).toBe("resolved");
    if (request.status === "resolved") {
      expect(request.source).toBe("parent_request");
    }
    const inherited = resolveSubagentModel({ userDefault: null, parentInherited: FAUX, resolveModel: resolve });
    expect(inherited.status).toBe("resolved");
    if (inherited.status === "resolved") {
      expect(inherited.source).toBe("parent_inherited");
    }
  });

  it("全部为空 → required；模型不可用 → unavailable（不 fallback）", () => {
    const required = resolveSubagentModel({ userDefault: null, parentInherited: null, resolveModel: () => true });
    expect(required.status).toBe("error");
    if (required.status === "error") {
      expect(required.code).toBe("subagent_model_required");
    }
    const unavailable = resolveSubagentModel({ userDefault: null, parentRequest: FAUX, parentInherited: null, resolveModel: () => false });
    expect(unavailable.status).toBe("error");
    if (unavailable.status === "error") {
      expect(unavailable.code).toBe("subagent_model_unavailable");
    }
  });
});

// ── Tool side-effect 分类（§12.4）───────────────────────────────

describe("Tool side-effect 分类", () => {
  it("已知工具分类正确；未知 → unknown", () => {
    expect(classifyToolSideEffect("read")).toBe("workspace-read");
    expect(classifyToolSideEffect("write")).toBe("workspace-write");
    expect(classifyToolSideEffect("bash")).toBe("workspace-write");
    expect(classifyToolSideEffect("spawn_subagent")).toBe("administrative");
    expect(classifyToolSideEffect("search_memory")).toBe("administrative");
    expect(classifyToolSideEffect("no-such-tool")).toBe("unknown");
  });

  it("read Run 拒绝 unknown/workspace-write/administrative", () => {
    expect(isToolAllowedInReadRun("read")).toBe(true);
    expect(isToolAllowedInReadRun("write")).toBe(false);
    expect(isToolAllowedInReadRun("bash")).toBe(false);
    expect(isToolAllowedInReadRun("spawn_subagent")).toBe(false);
    expect(isToolAllowedInReadRun("unknown-tool")).toBe(false);
  });
});

// ── CapabilityCeiling / EffectiveSnapshot（§12）─────────────────

describe("CapabilityCeiling 与 EffectiveSnapshot", () => {
  function makeSkillRef(skillId: string, contentHash: string): SkillRef {
    return { skillId, sourceId: "managed", sourceKind: "managed", version: "1.0.0", contentHash };
  }

  const parentInput: EffectiveSnapshotInput = {
    parentToolIds: ["read", "write", "bash", "spawn_subagent", "search_memory", "report_subagent_result"],
    parentPluginContributions: [
      { pluginId: "p1", pluginVersion: "1.0.0", runtimeInstanceId: "r1", contributionId: "echo", grantRevision: 3, sideEffectClass: "external-read" },
      { pluginId: "p2", pluginVersion: "1.0.0", runtimeInstanceId: "r2", contributionId: "plugin_admin", grantRevision: 1, sideEffectClass: "administrative" },
    ],
    parentSkillEntries: [
      { ref: makeSkillRef("alpha", "hash-alpha"), contentHash: "hash-alpha", selectionMode: "implicit", readiness: "ready", sourceKind: "managed" },
      { ref: makeSkillRef("beta", "hash-beta"), contentHash: "hash-beta", selectionMode: "implicit", readiness: "blocked", sourceKind: "managed" },
    ],
    ceiling: defaultCapabilityCeiling(),
  };

  it("默认 ceiling（read/inherit）→ 只读工具 + 固定禁用剔除 + 非 administrative 插件 + ready Skill", () => {
    const snapshot = computeEffectiveSnapshot(parentInput);
    expect(snapshot.toolIds).toEqual(expect.arrayContaining(["read", "report_subagent_result"]));
    expect(snapshot.toolIds).not.toContain("write");
    expect(snapshot.toolIds).not.toContain("bash");
    expect(snapshot.toolIds).not.toContain("spawn_subagent");
    expect(snapshot.toolIds).not.toContain("search_memory");
    expect(snapshot.pluginContributions.map((entry) => entry.contributionId)).toEqual(["echo"]);
    expect(snapshot.skills.map((entry) => entry.ref.skillId)).toEqual(["alpha"]);
    expect(snapshot.fixedDenials).toContain("spawn_subagent");
  });

  it("allowlist 与父能力求交集；列表为空 → 空（fail-closed）", () => {
    const allowlist = computeEffectiveSnapshot({
      ...parentInput,
      ceiling: normalizeCapabilityRequest({
        tools: { mode: "allowlist", ids: ["read", "not-in-parent"] },
        plugins: { mode: "allowlist", pluginIds: ["p1"], contributionIds: ["echo", "ghost"] },
        skills: { mode: "allowlist", refs: [makeSkillRef("alpha", "hash-alpha"), makeSkillRef("ghost", "hash-ghost")] },
        workspaceAccess: "write",
        network: "inherit",
      }),
    });
    expect(allowlist.toolIds).toEqual(["read"]);
    expect(allowlist.pluginContributions.map((entry) => entry.contributionId)).toEqual(["echo"]);
    expect(allowlist.skills.map((entry) => entry.ref.skillId)).toEqual(["alpha"]);
    const empty = computeEffectiveSnapshot({
      ...parentInput,
      ceiling: normalizeCapabilityRequest({
        tools: { mode: "allowlist", ids: [] },
        plugins: { mode: "allowlist" },
        skills: { mode: "allowlist", refs: [] as SkillRef[] },
        workspaceAccess: "read",
        network: "inherit",
      }),
    });
    expect(empty.toolIds).toHaveLength(0);
    expect(empty.pluginContributions).toHaveLength(0);
  });

  it("ceilingHash 稳定：同一语义对象恒同哈希", () => {
    const a = computeCapabilityCeilingHash(defaultCapabilityCeiling());
    const b = computeCapabilityCeilingHash(defaultCapabilityCeiling());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(stableSerialize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("summarizeEffectiveSnapshot 映射契约形状", () => {
    const summary = summarizeEffectiveSnapshot(computeEffectiveSnapshot(parentInput));
    expect(summary.ceilingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.workspaceAccess).toBe("read");
    expect(summary.toolIds).toContain("read");
    expect(summary.fixedDenials.length).toBeGreaterThan(0);
  });

  it("skill contentHash 不一致剔除（精确快照完整性）", () => {
    const snapshot = computeEffectiveSnapshot({
      ...parentInput,
      parentSkillEntries: [
        { ref: makeSkillRef("alpha", "hash-alpha"), contentHash: "tampered", selectionMode: "implicit", readiness: "ready", sourceKind: "managed" },
      ],
    });
    expect(snapshot.skills).toHaveLength(0);
  });
});

// ── Run limits（§15.2）──────────────────────────────────────────

describe("normalizeSubagentRunLimits", () => {
  it("缺省合并默认值", () => {
    const result = normalizeSubagentRunLimits(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.limits.maxModelIterations).toBe(24);
      expect(result.limits.maxTotalTokens).toBe(200_000);
    }
  });

  it("请求更小限制允许；超过平台最大拒绝", () => {
    const smaller = normalizeSubagentRunLimits({ maxModelIterations: 8, totalRunTimeoutMs: 60_000 });
    expect(smaller.ok).toBe(true);
    const over = normalizeSubagentRunLimits({ totalRunTimeoutMs: SUBAGENT_RUN_LIMITS_MAXIMUM.totalRunTimeoutMs + 1 });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      // 超限可能被 schema maximum 直接拒绝（"Run limits 非法"）或平台最大值
      // 校验拒绝（"超过平台最大值"）——两种都是 fail-closed 拒绝
      expect(over.reason.length).toBeGreaterThan(0);
    }
  });
});

// ── WorkspaceMutationLeaseService（§18.3）───────────────────────

describe("WorkspaceMutationLeaseService", () => {
  it("获取 → 续租 → 释放全流程（compare-and-set）", () => {
    const { db } = createDb();
    const service = new WorkspaceMutationLeaseService(new WorkspaceLeaseStore(db));
    const acquired = service.acquire(WORKSPACE, {
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_12345678",
      bootId: "boot-1",
      ttlMs: SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status === "acquired") {
      expect(acquired.lease.ownerId).toBe("sar_12345678");
    }
    const renewed = service.renew(WORKSPACE, "sar_12345678", "boot-1", SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS);
    expect(renewed.status).toBe("renewed");
    const released = service.release(WORKSPACE, "sar_12345678", "boot-1");
    expect(released.status).toBe("released");
    expect(service.get(WORKSPACE)).toBeNull();
    db.close();
  });

  it("父 Agent 与 Subagent 写互斥：占用中获取 denied（返回 heldBy）", () => {
    const { db } = createDb();
    const service = new WorkspaceMutationLeaseService(new WorkspaceLeaseStore(db));
    service.acquire(WORKSPACE, {
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_12345678",
      bootId: "boot-1",
      ttlMs: SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS,
    });
    const parent = service.acquire(WORKSPACE, {
      leaseKind: "parent_write",
      ownerKind: "parent_agent",
      ownerId: "agent-a",
      bootId: "boot-parent",
      ttlMs: PARENT_WRITE_LEASE_DEFAULT_TTL_MS,
    });
    expect(parent.status).toBe("denied");
    if (parent.status === "denied") {
      expect(parent.heldBy.ownerId).toBe("sar_12345678");
    }
    // 非持有者释放失败
    expect(service.release(WORKSPACE, "agent-a", "boot-parent").status).toBe("not_held");
    db.close();
  });

  it("过期租约可被接管；cleanupExpired 清理", () => {
    const { db } = createDb();
    let now = Date.UTC(2026, 7, 7, 0, 0, 0);
    const service = new WorkspaceMutationLeaseService(new WorkspaceLeaseStore(db), { now: () => now });
    service.acquire(WORKSPACE, {
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_1",
      bootId: "boot-1",
      ttlMs: 1_000,
    });
    now += 5_000; // 过期
    const takeover = service.acquire(WORKSPACE, {
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_2",
      bootId: "boot-2",
      ttlMs: 60_000,
    });
    expect(takeover.status).toBe("acquired");
    if (takeover.status === "acquired") {
      expect(takeover.lease.ownerId).toBe("sar_2");
    }
    // 同 bootId（同一进程重新获取）→ 接管
    const sameBoot = service.acquire(WORKSPACE, {
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_2",
      bootId: "boot-2",
      ttlMs: 60_000,
    });
    expect(sameBoot.status).toBe("acquired");
    expect(service.cleanupExpired()).toBe(0);
    db.close();
  });

  it("跨工作区并行：不同 canonical_workspace 互不阻塞", () => {
    const { db } = createDb();
    const service = new WorkspaceMutationLeaseService(new WorkspaceLeaseStore(db));
    const a = service.acquire("D:\\work\\a", { leaseKind: "subagent_write", ownerKind: "subagent", ownerId: "r1", bootId: "b1", ttlMs: 60_000 });
    const b = service.acquire("D:\\work\\b", { leaseKind: "subagent_write", ownerKind: "subagent", ownerId: "r2", bootId: "b2", ttlMs: 60_000 });
    expect(a.status).toBe("acquired");
    expect(b.status).toBe("acquired");
    db.close();
  });
});

// 引用 skillRefKey 防止未使用告警（EffectiveSnapshot 内部使用）
void skillRefKey;
