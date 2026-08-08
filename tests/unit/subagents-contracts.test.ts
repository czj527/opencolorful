import { describe, expect, it } from "vitest";
import Value from "typebox/value";

import {
  SUBAGENT_DELIVERY_MODES,
  SUBAGENT_ERROR_CODES,
  SUBAGENT_MESSAGE_TYPES,
  SUBAGENT_MESSAGE_TYPE_PERMISSIONS,
  SUBAGENT_PLATFORM_FIXED_DENIALS,
  SUBAGENT_RUN_ACTIVE_STATUSES,
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  SUBAGENT_RUN_LIMITS_MAXIMUM,
  SUBAGENT_RUN_STATUSES,
  SUBAGENT_RUN_TERMINAL_STATUSES,
  SUBAGENT_RUN_TRANSITIONS,
  SUBAGENT_SENDER_KINDS,
  SUBAGENT_THREAD_STATUSES,
  SUBAGENT_THREAD_ID_PREFIX,
  SUBAGENT_RUN_ID_PREFIX,
  SUBAGENT_MESSAGE_ID_PREFIX,
  SUBAGENT_ARTIFACT_ID_PREFIX,
  SUBAGENT_MAILBOX_ID_PREFIX,
  SUBAGENT_SNAPSHOT_ID_PREFIX,
  AgentMessageEnvelopeV1Schema,
  SubagentCapabilityRequestV1Schema,
  SubagentContextPacketV1Schema,
  SubagentErrorSchema,
  SubagentInputRequiredV1Schema,
  SubagentResultV1Schema,
  SubagentSteerV1Schema,
  SubagentTaskBriefV1Schema,
  canTransitSubagentRun,
  isSubagentRunActive,
  isSubagentRunTerminal,
  type AgentMessageEnvelopeV1,
  type SubagentResultV1,
  type SubagentTaskBriefV1,
  type SubagentSteerV1,
} from "../../src/contracts/subagents.js";
import { defaultSubagentCapabilityRequest, defaultSubagentPreferences, SubagentPreferencesSchema } from "../../src/contracts/subagents.js";
import { defaultPreferences, normalizePreferences, PreferencesDocumentSchema } from "../../src/contracts/preferences.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T1 契约测试（plans/phase-14.md §7 / §8 / §9 / §10 / §12 / §15）
// - 枚举与计划逐字一致（防漂移）；
// - 状态机合法/非法转换表；
// - TypeBox fixtures：合法/非法/超限/future version 拒绝；
// - 消息权限（sender × messageType）；
// - Preferences subagents.defaultModel 五步接入。
// ═══════════════════════════════════════════════════════════════

// ── 枚举与计划一致性（T1 冻结，不得漂移）────────────────────────

describe("枚举与计划逐字一致", () => {
  it("Thread 状态三值", () => {
    expect(SUBAGENT_THREAD_STATUSES).toEqual(["open", "closing", "closed"]);
  });

  it("Run 状态 11 值：5 活动 + 6 终态", () => {
    expect(SUBAGENT_RUN_STATUSES).toEqual([
      "queued", "starting", "running", "waiting_for_input", "cancelling",
      "succeeded", "failed", "cancelled", "timed_out", "interrupted", "budget_exhausted",
    ]);
    expect(SUBAGENT_RUN_ACTIVE_STATUSES).toEqual(["queued", "starting", "running", "waiting_for_input", "cancelling"]);
    expect(SUBAGENT_RUN_TERMINAL_STATUSES).toEqual(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "budget_exhausted"]);
    for (const status of SUBAGENT_RUN_TERMINAL_STATUSES) {
      expect(isSubagentRunTerminal(status)).toBe(true);
    }
    for (const status of SUBAGENT_RUN_ACTIVE_STATUSES) {
      expect(isSubagentRunActive(status)).toBe(true);
      expect(isSubagentRunTerminal(status)).toBe(false);
    }
  });

  it("消息类型/发送方/投递模式与计划一致", () => {
    expect(SUBAGENT_MESSAGE_TYPES).toEqual(["task", "progress", "steer", "input_required", "result", "error", "cancel", "status"]);
    expect(SUBAGENT_SENDER_KINDS).toEqual(["parent_agent", "subagent", "system"]);
    expect(SUBAGENT_DELIVERY_MODES).toEqual(["immediate", "queue", "interrupt", "mailbox"]);
  });

  it("消息权限：task/steer/cancel 仅父 Agent；progress/input_required/result/error 仅 Subagent；status 仅 system", () => {
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.task).toEqual(["parent_agent"]);
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.steer).toEqual(["parent_agent"]);
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.cancel).toEqual(["parent_agent"]);
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.progress).toEqual(["subagent"]);
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.input_required).toEqual(["subagent"]);
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.result).toEqual(["subagent"]);
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.error).toEqual(["subagent"]);
    expect(SUBAGENT_MESSAGE_TYPE_PERMISSIONS.status).toEqual(["system"]);
  });

  it("平台固定禁用能力清单（§12.3）", () => {
    expect(SUBAGENT_PLATFORM_FIXED_DENIALS).toEqual([
      "search_memory", "memory_intent", "memory_agent", "spawn_subagent",
      // 复审 P0-3（§12.3）：Skill 安装/绑定/解绑/停用/Bundle 管理永不授予
      "install_skill", "manage_skills", "manage_skill_bundle",
      "agent_admin", "provider_credentials", "plugin_admin", "skill_admin", "observability_admin",
      "session_admin", "platform_config", "host_admin",
    ]);
  });

  it("预算默认与平台最大值（§15.2）", () => {
    expect(SUBAGENT_RUN_LIMITS_DEFAULTS).toEqual({
      startupTimeoutMs: 60_000,
      providerFirstEventTimeoutMs: 90_000,
      providerEventIdleTimeoutMs: 180_000,
      idleTimeoutMs: 180_000,
      totalRunTimeoutMs: 1_800_000,
      maxModelIterations: 24,
      maxToolCalls: 64,
      maxTotalTokens: 200_000,
    });
    expect(SUBAGENT_RUN_LIMITS_MAXIMUM.totalRunTimeoutMs).toBe(3_600_000);
  });

  it("稳定 ID 前缀（§5.2）", () => {
    expect(SUBAGENT_THREAD_ID_PREFIX).toBe("sat_");
    expect(SUBAGENT_RUN_ID_PREFIX).toBe("sar_");
    expect(SUBAGENT_MESSAGE_ID_PREFIX).toBe("sam_");
    expect(SUBAGENT_ARTIFACT_ID_PREFIX).toBe("saa_");
    expect(SUBAGENT_MAILBOX_ID_PREFIX).toBe("smb_");
    expect(SUBAGENT_SNAPSHOT_ID_PREFIX).toBe("sas_");
  });

  it("稳定错误码含计划逐字码（含补充最小集）", () => {
    for (const code of [
      "subagent_steer_queue_full",
      "subagent_model_override_denied",
      "subagent_model_required",
      "subagent_model_unavailable",
      "subagent_result_not_reported",
      "subagent_nesting_forbidden",
      "subagent_runtime_unavailable",
      "subagent_artifact_integrity_failed",
    ]) {
      expect(SUBAGENT_ERROR_CODES).toContain(code);
    }
  });
});

// ── 状态机转换表（§7.2）─────────────────────────────────────────

describe("Run 状态机转换表", () => {
  it("合法转换（§7.2 逐条）", () => {
    expect(canTransitSubagentRun("queued", "starting")).toBe(true);
    expect(canTransitSubagentRun("starting", "running")).toBe(true);
    expect(canTransitSubagentRun("running", "succeeded")).toBe(true);
    expect(canTransitSubagentRun("running", "failed")).toBe(true);
    expect(canTransitSubagentRun("running", "waiting_for_input")).toBe(true);
    expect(canTransitSubagentRun("waiting_for_input", "running")).toBe(true);
    expect(canTransitSubagentRun("running", "timed_out")).toBe(true);
    expect(canTransitSubagentRun("running", "budget_exhausted")).toBe(true);
    expect(canTransitSubagentRun("running", "cancelling")).toBe(true);
    expect(canTransitSubagentRun("cancelling", "cancelled")).toBe(true);
    for (const active of SUBAGENT_RUN_ACTIVE_STATUSES) {
      expect(canTransitSubagentRun(active, "interrupted")).toBe(true);
    }
  });

  it("非法转换一律拒绝", () => {
    // 终态无出边
    for (const terminal of SUBAGENT_RUN_TERMINAL_STATUSES) {
      for (const target of SUBAGENT_RUN_STATUSES) {
        expect(canTransitSubagentRun(terminal, target)).toBe(false);
      }
    }
    // 典型非法：queued → running（缺 starting）、starting → succeeded、waiting → succeeded、cancelling → running
    expect(canTransitSubagentRun("queued", "running")).toBe(false);
    expect(canTransitSubagentRun("starting", "succeeded")).toBe(false);
    expect(canTransitSubagentRun("waiting_for_input", "succeeded")).toBe(false);
    expect(canTransitSubagentRun("cancelling", "running")).toBe(false);
    expect(canTransitSubagentRun("queued", "budget_exhausted")).toBe(false);
  });

  it("转换表覆盖全部 11 状态（无遗漏）", () => {
    for (const status of SUBAGENT_RUN_STATUSES) {
      expect(SUBAGENT_RUN_TRANSITIONS[status]).toBeDefined();
    }
  });
});

// ── TypeBox fixtures（§9）────────────────────────────────────────

function makeBrief(overrides: Partial<SubagentTaskBriefV1> = {}): SubagentTaskBriefV1 {
  return {
    version: 1,
    title: "研究任务",
    objective: "调研 OpenColorful 的 Subagent 边界",
    successCriteria: ["产出结论"],
    deliverables: ["报告"],
    context: ["父上下文"],
    constraints: ["只读"],
    nonGoals: [],
    executionMode: "research",
    reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "both" },
    ...overrides,
  };
}

describe("TaskBrief/ContextPacket/Steer/InputRequired/Result/Envelope fixtures", () => {
  it("合法 TaskBrief 通过；缺必填（objective/constraints）拒绝", () => {
    expect(Value.Check(SubagentTaskBriefV1Schema, makeBrief())).toBe(true);
    const { objective: _objective, ...noObjective } = makeBrief();
    expect(Value.Check(SubagentTaskBriefV1Schema, noObjective)).toBe(false);
    const { constraints: _constraints, ...noConstraints } = makeBrief();
    expect(Value.Check(SubagentTaskBriefV1Schema, noConstraints)).toBe(false);
  });

  it("future version 拒绝（version: 2）", () => {
    expect(Value.Check(SubagentTaskBriefV1Schema, { ...makeBrief(), version: 2 })).toBe(false);
  });

  it("超限字符串/数组拒绝", () => {
    expect(Value.Check(SubagentTaskBriefV1Schema, makeBrief({ successCriteria: [] }))).toBe(false);
    expect(Value.Check(SubagentTaskBriefV1Schema, makeBrief({ successCriteria: ["x".repeat(501)] }))).toBe(false);
    expect(Value.Check(SubagentTaskBriefV1Schema, makeBrief({ title: "" }))).toBe(false);
  });

  it("ContextPacket：parent_message 引用通过；其他 kind 引用在 messageRefs 拒绝", () => {
    const packet = {
      version: 1,
      userRequest: "帮我调研",
      parentSummary: "摘要",
      messageRefs: [{ kind: "parent_message", messageId: "m-1", contentHash: "sha256-12345678" }],
      resources: [
        { kind: "workspace_file", relativePath: "docs/a.md", contentHash: "sha256-12345678" },
        { kind: "artifact", artifactId: "saa_12345678", contentHash: "sha256-12345678" },
      ],
      knownFacts: ["事实"],
      unresolvedQuestions: [],
    };
    expect(Value.Check(SubagentContextPacketV1Schema, packet)).toBe(true);
    // messageRefs 只接受 parent_message
    expect(
      Value.Check(SubagentContextPacketV1Schema, {
        ...packet,
        messageRefs: [{ kind: "workspace_file", relativePath: "x", contentHash: "sha256-12345678" }],
      }),
    ).toBe(false);
  });

  it("Steer：queue/interrupt 合法；stop 动作保留；超长 instruction 拒绝", () => {
    const steer: SubagentSteerV1 = {
      version: 1,
      targetRunId: "sar_12345678",
      action: "redirect",
      instruction: "调整方向",
      reason: "范围变化",
      preserveCompletedWork: true,
      deliveryMode: "interrupt",
    };
    expect(Value.Check(SubagentSteerV1Schema, steer)).toBe(true);
    expect(Value.Check(SubagentSteerV1Schema, { ...steer, instruction: "x".repeat(4001) })).toBe(false);
    expect(Value.Check(SubagentSteerV1Schema, { ...steer, action: "stop" })).toBe(true);
    expect(Value.Check(SubagentSteerV1Schema, { ...steer, deliveryMode: "mailbox" })).toBe(false);
  });

  it("InputRequired：blocking 必须为 true；choices ≤ 8", () => {
    expect(
      Value.Check(SubagentInputRequiredV1Schema, {
        version: 1,
        question: "需要澄清",
        reason: "信息不足",
        expectedAnswerType: "choice",
        choices: ["a", "b"],
        blocking: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(SubagentInputRequiredV1Schema, {
        version: 1,
        question: "x",
        reason: "",
        expectedAnswerType: "text",
        blocking: false,
      }),
    ).toBe(false);
  });

  it("Result：disposition=blocked 合法（succeeded + blocked 组合允许）", () => {
    const result: SubagentResultV1 = {
      version: 1,
      disposition: "blocked",
      summary: "资料不足但分析完毕",
      criteria: [{ criterion: "完整证据", status: "unmet", evidenceRefs: [] }],
      artifacts: [],
      unresolvedIssues: ["缺少来源"],
      recommendedNextAction: "ask_user",
    };
    expect(Value.Check(SubagentResultV1Schema, result)).toBe(true);
    expect(Value.Check(SubagentResultV1Schema, { ...result, recommendedNextAction: "teleport" })).toBe(false);
  });

  it("Envelope：合法消息通过；sender/recipient/messageType 不匹配拒绝；future version 拒绝", () => {
    const envelope: AgentMessageEnvelopeV1 = {
      protocol: "opencolorful.agent-message",
      version: 1,
      messageId: "sam_12345678",
      contextId: "sat_12345678",
      taskId: "sar_12345678",
      sequence: 1,
      sender: { kind: "parent_agent", id: "agent-a" },
      recipient: { kind: "subagent", id: "sat_12345678" },
      messageType: "task",
      deliveryMode: "immediate",
      parts: [{ kind: "text", text: "任务" }],
      metadata: { createdAt: "2026-08-07T00:00:00.000Z", traceId: "trace-1", schemaName: "subagent.task" },
    };
    expect(Value.Check(AgentMessageEnvelopeV1Schema, envelope)).toBe(true);
    // future version 拒绝
    expect(Value.Check(AgentMessageEnvelopeV1Schema, { ...envelope, version: 2 })).toBe(false);
    // 错误协议名拒绝
    expect(Value.Check(AgentMessageEnvelopeV1Schema, { ...envelope, protocol: "other.protocol" })).toBe(false);
    // recipient.kind 非法
    expect(Value.Check(AgentMessageEnvelopeV1Schema, { ...envelope, recipient: { kind: "system", id: "x" } })).toBe(false);
  });

  it("CapabilityRequest：默认值形状合法；workspaceAccess 非法拒绝", () => {
    expect(Value.Check(SubagentCapabilityRequestV1Schema, defaultSubagentCapabilityRequest())).toBe(true);
    expect(
      Value.Check(SubagentCapabilityRequestV1Schema, { ...defaultSubagentCapabilityRequest(), workspaceAccess: "admin" }),
    ).toBe(false);
  });

  it("SubagentError：code 必须来自稳定枚举", () => {
    expect(Value.Check(SubagentErrorSchema, { code: "subagent_steer_queue_full", message: "队列已满" })).toBe(true);
    expect(Value.Check(SubagentErrorSchema, { code: "not_a_real_code", message: "x" })).toBe(false);
  });
});

// ── Preferences subagents.defaultModel（§10.1）───────────────────

describe("Preferences subagents 段", () => {
  it("默认偏好包含 subagents.defaultModel=null", () => {
    const defaults = defaultPreferences();
    expect(defaults.subagents).toEqual({ defaultModel: null });
    expect(Value.Check(PreferencesDocumentSchema, defaults)).toBe(true);
  });

  it("normalizePreferences：缺失补默认段；非法值回退默认；合法值保留", () => {
    const normalized = normalizePreferences({ version: 2, defaults: {}, layout: {}, appearance: {} });
    expect(normalized.subagents).toEqual({ defaultModel: null });
    const withModel = normalizePreferences({
      ...defaultPreferences(),
      subagents: { defaultModel: { providerId: "faux", modelId: "faux-1" } },
    });
    expect(withModel.subagents).toEqual({ defaultModel: { providerId: "faux", modelId: "faux-1" } });
    const invalid = normalizePreferences({ ...defaultPreferences(), subagents: { defaultModel: "not-an-object" } });
    expect(invalid.subagents).toEqual({ defaultModel: null });
  });

  it("SubagentPreferencesSchema 拒绝未知字段", () => {
    expect(Value.Check(SubagentPreferencesSchema, { defaultModel: null, extra: 1 })).toBe(false);
    expect(Value.Check(SubagentPreferencesSchema, defaultSubagentPreferences())).toBe(true);
  });
});
