import { describe, expect, it } from "vitest";

import type { SubagentContextPacketV1, SubagentSteerV1, SubagentTaskBriefV1 } from "../../src/contracts/subagents.js";
import {
  TASK_BRIEF_BLOCK_NAMES,
  parseSteer,
  parseTaskBrief,
  renderContextPacket,
  renderSteer,
  renderTaskBrief,
} from "../../src/runtime/subagents/task-renderer.js";
import type { ContextResolutionSnapshot } from "../../src/runtime/subagents/context-resolver.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T3：Task Renderer 测试（plans/phase-14.md §9.1 / §9.3 / §11.1）
// - TaskBrief 固定区块齐全且顺序稳定；
// - ContextPacket 摘要 + 引用列表（截断标记）；
// - Steer 渲染（queue/interrupt、preserveCompletedWork 语义）；
// - spawn/steer 跨进程输入的 TypeBox 校验。
// ═══════════════════════════════════════════════════════════════

function makeBrief(overrides: Partial<SubagentTaskBriefV1> = {}): SubagentTaskBriefV1 {
  return {
    version: 1,
    title: "审查 Phase 14 计划",
    objective: "检查计划 §9 契约与 §23 T3 交付的一致性。",
    successCriteria: ["区块顺序与计划一致", "渲染不含未标记 JSON"],
    deliverables: ["渲染输出文本"],
    context: ["计划文档 plans/phase-14.md"],
    constraints: ["不修改契约"],
    nonGoals: [],
    executionMode: "verify",
    reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "both" },
    ...overrides,
  };
}

function makeSteer(overrides: Partial<SubagentSteerV1> = {}): SubagentSteerV1 {
  return {
    version: 1,
    targetRunId: "sar_testrun0001",
    action: "add_constraint",
    instruction: "请补充对 Windows 路径的测试覆盖。",
    reason: "目标平台为 Windows。",
    preserveCompletedWork: true,
    deliveryMode: "queue",
    ...overrides,
  };
}

function makePacket(overrides: Partial<SubagentContextPacketV1> = {}): SubagentContextPacketV1 {
  return {
    version: 1,
    userRequest: "帮我实现 T3 交付。",
    parentSummary: "父 Agent 已完成 T1 契约冻结。",
    messageRefs: [],
    resources: [],
    knownFacts: ["T1 契约已冻结"],
    unresolvedQuestions: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ContextResolutionSnapshot> = {}): ContextResolutionSnapshot {
  return {
    messageRefs: [
      {
        ref: { kind: "parent_message", messageId: "parent-msg-1", contentHash: "a".repeat(16) },
        content: "引用消息快照正文",
        bytes: 9,
        truncated: false,
      },
      {
        ref: { kind: "parent_message", messageId: "parent-msg-2", contentHash: "b".repeat(16) },
        content: "超限截断正文",
        bytes: 16384,
        truncated: true,
      },
    ],
    resources: [
      {
        ref: { kind: "workspace_file", relativePath: "docs/plan.md", contentHash: "c".repeat(16) },
        label: "workspace docs/plan.md",
      },
    ],
    truncated: true,
    totalMessageBytes: 16393,
    droppedMessageCount: 1,
    packetHash: "hash12345678",
    ...overrides,
  };
}

describe("TaskBrief 渲染固定区块", () => {
  it("七个固定区块齐全且顺序正确（§9.1）", () => {
    const output = renderTaskBrief(makeBrief());
    const expectedBlocks = TASK_BRIEF_BLOCK_NAMES.map((name) => `[${name}]`);
    let cursor = -1;
    for (const block of expectedBlocks) {
      const index = output.indexOf(block);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("渲染标题、目标、完成标准、交付物与约束内容", () => {
    const output = renderTaskBrief(makeBrief());
    expect(output).toContain("审查 Phase 14 计划");
    expect(output).toContain("检查计划 §9 契约与 §23 T3 交付的一致性。");
    expect(output).toContain("1. 区块顺序与计划一致");
    expect(output).toContain("1. 渲染输出文本");
    expect(output).toContain("1. 不修改契约");
  });

  it("空 context / 非目标渲染为（无）", () => {
    const output = renderTaskBrief(makeBrief());
    expect(output).toContain("[可用上下文]");
    expect(output).toContain("- 计划文档 plans/phase-14.md");
    expect(output).toContain("[非目标]");
    expect(output).toContain("（无）");
  });

  it("汇报规则渲染进度/证据/交付物形式", () => {
    const output = renderTaskBrief(makeBrief());
    expect(output).toContain("- 进度汇报：milestones（按里程碑汇报）");
    expect(output).toContain("- 证据要求：必须提供证据");
    expect(output).toContain("- 交付物形式：both（内联与引用）");
  });

  it("terminal-only 与 evidenceRequired=false 渲染正确", () => {
    const output = renderTaskBrief(
      makeBrief({ reporting: { progress: "terminal-only", evidenceRequired: false, artifactPreference: "inline" } }),
    );
    expect(output).toContain("- 进度汇报：terminal-only（仅终态汇报）");
    expect(output).toContain("- 证据要求：证据可选");
    expect(output).toContain("- 交付物形式：inline（内联文本）");
  });
});

describe("ContextPacket 渲染", () => {
  it("无快照时渲染摘要与引用列表本身", () => {
    const output = renderContextPacket(
      makePacket({
        messageRefs: [{ kind: "parent_message", messageId: "parent-msg-1", contentHash: "a".repeat(16) }],
        resources: [
          { kind: "workspace_file", relativePath: "docs/plan.md", contentHash: "c".repeat(16) },
          { kind: "skill", skillRef: { skillId: "s1", sourceId: "src", sourceKind: "builtin", version: "1.0.0", contentHash: "d".repeat(16) }, contentHash: "d".repeat(16) },
        ],
        unresolvedQuestions: ["是否需要写 Lease？"],
      }),
    );
    expect(output).toContain("[父上下文摘要]");
    expect(output).toContain("父 Agent 已完成 T1 契约冻结。");
    expect(output).toContain("[用户请求]");
    expect(output).toContain("[引用消息（父会话只读快照）]");
    expect(output).toContain("- parent-msg-1");
    expect(output).toContain("[已授权资源]");
    expect(output).toContain("workspace_file");
    expect(output).toContain("- skill: s1@src@1.0.0");
    expect(output).toContain("[已知事实]");
    expect(output).toContain("- T1 契约已冻结");
    expect(output).toContain("[未解决问题]");
    expect(output).toContain("- 是否需要写 Lease？");
  });

  it("带快照时渲染字节数与截断标记", () => {
    const output = renderContextPacket(
      makePacket({
        messageRefs: [
          { kind: "parent_message", messageId: "parent-msg-1", contentHash: "a".repeat(16) },
          { kind: "parent_message", messageId: "parent-msg-2", contentHash: "b".repeat(16) },
        ],
        resources: [{ kind: "workspace_file", relativePath: "docs/plan.md", contentHash: "c".repeat(16) }],
      }),
      { resolution: makeSnapshot() },
    );
    expect(output).toContain("- parent-msg-1（9 字节）");
    expect(output).toContain("- parent-msg-2（16384 字节，已截断）");
    expect(output).toContain("- （另有 1 条因总预算上限被丢弃）");
    expect(output).toContain("（注：消息快照因大小上限被截断，超出部分不可用）");
    expect(output).toContain("- workspace docs/plan.md（哈希 cccccccccccc）");
  });

  it("空引用列表渲染（无）", () => {
    const output = renderContextPacket(makePacket(), { resolution: makeSnapshot({ messageRefs: [], resources: [] }) });
    expect(output).toContain("[引用消息（父会话只读快照）]");
    expect(output).toContain("[已授权资源]");
  });
});

describe("Steer 渲染", () => {
  it("queue 投递与 preserveCompletedWork=true 语义（§9.3）", () => {
    const output = renderSteer(makeSteer());
    expect(output).toContain("[主 Agent 纠偏]");
    expect(output).toContain("动作：add_constraint");
    expect(output).toContain("原因：目标平台为 Windows。");
    expect(output).toContain("指令：请补充对 Windows 路径的测试覆盖。");
    expect(output).toContain("queue（队列投递：等待当前模型/工具处理结束后应用）");
    expect(output).toContain("保留已完成工作：是 — 在现有已完成工作的基础上调整，不得重做或丢弃已完成成果");
  });

  it("interrupt 投递说明与 preserveCompletedWork=false 语义", () => {
    const output = renderSteer(makeSteer({ deliveryMode: "interrupt", preserveCompletedWork: false, reason: "" }));
    expect(output).toContain("interrupt（中断投递：在安全边界内立即交付；工具不可中断时可延迟到工具终态，但必须如实返回 delayed）");
    expect(output).toContain("保留已完成工作：否 — 允许放弃未完成部分，按要求调整方向，无需保留中间成果");
    expect(output).toContain("原因：（未说明）");
  });

  it("stop 动作直接渲染为纠偏条目而非取消状态机说明", () => {
    const output = renderSteer(makeSteer({ action: "stop" }));
    expect(output).toContain("动作：stop");
  });
});

describe("spawn/steer 跨进程输入 TypeBox 校验", () => {
  it("parseTaskBrief 接受合法 brief", () => {
    const result = parseTaskBrief(makeBrief());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brief.title).toBe("审查 Phase 14 计划");
    }
  });

  it("parseTaskBrief 拒绝缺必填字段（constraints 缺失）", () => {
    const invalid = { ...makeBrief(), constraints: undefined };
    const result = parseTaskBrief(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it("parseTaskBrief 拒绝 future version", () => {
    const result = parseTaskBrief({ ...makeBrief(), version: 2 });
    expect(result.ok).toBe(false);
  });

  it("parseSteer 接受合法 steer 并拒绝非法投递模式", () => {
    expect(parseSteer(makeSteer()).ok).toBe(true);
    const invalid = parseSteer({ ...makeSteer(), deliveryMode: "immediate" });
    expect(invalid.ok).toBe(false);
  });
});
