import { describe, expect, it } from "vitest";

import { buildSubagentRunToolExecutor } from "../../src/server/routes/subagent-ability-tools.js";
import type { EffectiveSnapshot } from "../../src/runtime/subagents/delegation-policy.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 复审 P0-1（第二轮）：run-scoped 执行器的快照隔离
//
// 复审指控：messages.ts 把 Session 级共享可变 Map（lastFrozenPluginSnapshots）
// 直接交给 Run 执行器；下一次 parentSnapshot() clear/refill 后，旧 Run 的
// 执行器会读到新 Run 的插件版本/实例/授权（快照不可变契约失效）。
//
// 修复：执行器工厂内部复制并冻结（Object.freeze(new Map(...))）——即使调用方
// 误传共享缓存，执行器也只消费创建时内容。本测试直接验证该隔离语义。
// ═══════════════════════════════════════════════════════════════

const SNAPSHOT: EffectiveSnapshot = {
  ceilingHash: "hash-0000000000000000000000000000000000000000000000000000000000000000",
  workspaceAccess: "read",
  network: "inherit",
  toolIds: ["pluginA.toolA"],
  pluginContributions: [
    {
      pluginId: "pluginA",
      pluginVersion: "1.0.0",
      runtimeInstanceId: "instance-a",
      contributionId: "pluginA.toolA",
      grantRevision: 1,
      sideEffectClass: "none",
    },
  ],
  skills: [],
  fixedDenials: [],
};

describe("subagent-ability-tools（复审 P0-1 快照隔离）", () => {
  it("执行器只消费创建时冻结的插件快照（共享 Map 后续变更不影响活动 Run）", async () => {
    const shared = new Map<string, { snapshot: unknown; state: unknown }>([
      ["pluginA.toolA", { snapshot: { marker: "old", version: "1.0.0" }, state: { grantRevision: 1 } }],
    ]);
    const invokes: unknown[] = [];
    const executor = buildSubagentRunToolExecutor({
      workspaceCwd: "/ws",
      ownerAgentId: "agent-a",
      sessionId: "sess-main",
      runId: "sar_run00000001",
      snapshot: SNAPSHOT,
      spawnTurnId: "turn-1",
      frozenPlugins: shared,
      pluginInvoke: async (input) => {
        invokes.push(input.snapshot);
        return { ok: true, result: {} };
      },
    });

    await executor({ name: "pluginA.toolA", args: {} });
    expect(invokes[0]).toEqual({ marker: "old", version: "1.0.0" });

    // 模拟第二次 spawn 的 parentSnapshot() clear/refill（Session 级缓存被复用）
    shared.clear();
    shared.set("pluginA.toolA", { snapshot: { marker: "new", version: "2.0.0" }, state: { grantRevision: 2 } });

    await executor({ name: "pluginA.toolA", args: {} });
    // 旧 Run 仍消费创建时快照——不漂移到新 Run 的插件状态
    expect(invokes[1]).toEqual({ marker: "old", version: "1.0.0" });
  });

  it("快照中缺失的插件贡献 → fail-closed（不静默执行）", async () => {
    const executor = buildSubagentRunToolExecutor({
      workspaceCwd: "/ws",
      ownerAgentId: "agent-a",
      sessionId: "sess-main",
      runId: "sar_run00000002",
      snapshot: SNAPSHOT,
      spawnTurnId: "turn-1",
      frozenPlugins: new Map(),
      pluginInvoke: async () => ({ ok: true, result: {} }),
    });
    const outcome = await executor({ name: "pluginA.toolA", args: {} });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("subagent_plugin_snapshot_missing");
  });
});
