import { Type, type Static } from "typebox";

import type { SkillRef } from "./skill-protocol.js";
import { SkillRefSchema } from "./skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T1 冻结契约：临时 Subagent Runtime 与父子任务协议
// （plans/phase-14.md §五 / §七 / §八 / §九 / §十 / §十二 / §十五）
//
// 本文件是 T1 冻结的契约：T2-T9 按此实现，不得自行发明字段、状态或事件名；
// 跨进程输入（Tool args / SSE payload / DB JSON）必须过 TypeBox 校验，
// 不允许 `as unknown as` 绕过 AgentMessage/TaskBrief/Result 边界。
//
// 硬边界（§5.2 / §8.2 / §16.2）：
// - 稳定 ID 使用随机不可预测前缀，不允许客户端或模型自定义；
// - Thread 内协议 sequence 严格单调、SQLite 事务内分配、重启后不重复；
// - Envelope 写入前 TypeBox 完整校验；读取时拒绝 future incompatible version；
// - version 字段用 Type.Literal(1) 天然拒绝 future version；
// - ownerAgentId/parentSessionId/父 Turn/父 Actor 一律从工具调用上下文获取，
//   不从模型参数信任。
// ═══════════════════════════════════════════════════════════════

// ── 稳定 ID（§5.2）──────────────────────────────────────────────

export const SUBAGENT_THREAD_ID_PREFIX = "sat_";
export const SUBAGENT_RUN_ID_PREFIX = "sar_";
export const SUBAGENT_MESSAGE_ID_PREFIX = "sam_";
export const SUBAGENT_ARTIFACT_ID_PREFIX = "saa_";
export const SUBAGENT_MAILBOX_ID_PREFIX = "smb_";
export const SUBAGENT_SNAPSHOT_ID_PREFIX = "sas_";

/** `sat_${string}` 等稳定 ID 模板字面量类型（A2A：contextId=Thread，taskId=Run） */
export type SubagentThreadId = `sat_${string}`;
export type SubagentRunId = `sar_${string}`;
export type AgentMessageId = `sam_${string}`;
export type SubagentArtifactId = `saa_${string}`;
export type ParentMailboxId = `smb_${string}`;
export type SubagentSnapshotId = `sas_${string}`;

export const SubagentThreadIdSchema = Type.String({ pattern: `^sat_[A-Za-z0-9_-]{8,128}$`, minLength: 12, maxLength: 132 });
export const SubagentRunIdSchema = Type.String({ pattern: `^sar_[A-Za-z0-9_-]{8,128}$`, minLength: 12, maxLength: 132 });
export const AgentMessageIdSchema = Type.String({ pattern: `^sam_[A-Za-z0-9_-]{8,128}$`, minLength: 12, maxLength: 132 });
export const SubagentArtifactIdSchema = Type.String({ pattern: `^saa_[A-Za-z0-9_-]{8,128}$`, minLength: 12, maxLength: 132 });
export const ParentMailboxIdSchema = Type.String({ pattern: `^smb_[A-Za-z0-9_-]{8,128}$`, minLength: 12, maxLength: 132 });
export const SubagentSnapshotIdSchema = Type.String({ pattern: `^sas_[A-Za-z0-9_-]{8,128}$`, minLength: 12, maxLength: 132 });

// ── Thread / Run 生命周期（§7）───────────────────────────────────

export const SUBAGENT_THREAD_STATUSES = ["open", "closing", "closed"] as const;
export type SubagentThreadStatus = (typeof SUBAGENT_THREAD_STATUSES)[number];

export const SubagentThreadStatusSchema = Type.Union(
  SUBAGENT_THREAD_STATUSES.map((status) => Type.Literal(status)),
);

/** Run 状态（11 值；终态 6 个） */
export const SUBAGENT_RUN_STATUSES = [
  "queued", "starting", "running", "waiting_for_input", "cancelling",
  "succeeded", "failed", "cancelled", "timed_out", "interrupted", "budget_exhausted",
] as const;
export type SubagentRunStatus = (typeof SUBAGENT_RUN_STATUSES)[number];

export const SubagentRunStatusSchema = Type.Union(
  SUBAGENT_RUN_STATUSES.map((status) => Type.Literal(status)),
);

/** 终态集合（一个 Run 只能写入一个终态；重复 terminal 幂等返回已有结果） */
export const SUBAGENT_RUN_TERMINAL_STATUSES = [
  "succeeded", "failed", "cancelled", "timed_out", "interrupted", "budget_exhausted",
] as const satisfies readonly SubagentRunStatus[];

/** 活动态集合（可被启动恢复标记 interrupted） */
export const SUBAGENT_RUN_ACTIVE_STATUSES = [
  "queued", "starting", "running", "waiting_for_input", "cancelling",
] as const satisfies readonly SubagentRunStatus[];

export function isSubagentRunTerminal(status: SubagentRunStatus): boolean {
  return (SUBAGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isSubagentRunActive(status: SubagentRunStatus): boolean {
  return (SUBAGENT_RUN_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Run 状态机合法转换表（§7.2 / §7.3）。
 * 约束：同一 Thread 同时最多一个非终态 Run；转换用事务内 compare-and-set；
 * 非法转换抛稳定错误（subagent_run_state_conflict）；interrupted 不自动重试；
 * succeeded 不代表业务满足，业务结果看 SubagentResultDisposition。
 */
export const SUBAGENT_RUN_TRANSITIONS: Readonly<Record<SubagentRunStatus, readonly SubagentRunStatus[]>> = {
  queued: ["starting", "interrupted", "cancelled"],
  starting: ["running", "failed", "timed_out", "interrupted", "cancelled"],
  running: ["succeeded", "failed", "waiting_for_input", "timed_out", "budget_exhausted", "cancelling", "interrupted"],
  waiting_for_input: ["running", "timed_out", "budget_exhausted", "cancelling", "interrupted", "failed"],
  cancelling: ["cancelled", "interrupted", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  interrupted: [],
  budget_exhausted: [],
};

/** 状态机转换合法性判定（非法 → 稳定错误码，由 Store 层抛错） */
export function canTransitSubagentRun(from: SubagentRunStatus, to: SubagentRunStatus): boolean {
  return (SUBAGENT_RUN_TRANSITIONS[from] as readonly SubagentRunStatus[]).includes(to);
}

// ── 结果与 Disposition（§7.3）───────────────────────────────────

export const SUBAGENT_RESULT_DISPOSITIONS = ["satisfied", "partial", "blocked", "failed"] as const;
export type SubagentResultDisposition = (typeof SUBAGENT_RESULT_DISPOSITIONS)[number];

export const SubagentResultDispositionSchema = Type.Union(
  SUBAGENT_RESULT_DISPOSITIONS.map((disposition) => Type.Literal(disposition)),
);

export const SUBAGENT_CRITERION_STATUSES = ["met", "partial", "unmet", "unknown"] as const;
export type SubagentCriterionStatus = (typeof SUBAGENT_CRITERION_STATUSES)[number];

export const SUBAGENT_RECOMMENDED_NEXT_ACTIONS = ["accept", "steer", "ask_user", "restart", "stop"] as const;
export type SubagentRecommendedNextAction = (typeof SUBAGENT_RECOMMENDED_NEXT_ACTIONS)[number];

export const SubagentArtifactRefSchema = Type.Object(
  {
    artifactId: SubagentArtifactIdSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    contentHash: Type.String({ minLength: 8, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type SubagentArtifactRef = Static<typeof SubagentArtifactRefSchema>;

export const SubagentResultV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    disposition: SubagentResultDispositionSchema,
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    criteria: Type.Array(
      Type.Object(
        {
          criterion: Type.String({ minLength: 1, maxLength: 200 }),
          status: Type.Union(SUBAGENT_CRITERION_STATUSES.map((status) => Type.Literal(status)) as never),
          evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 0, maxItems: 20 },
    ),
    artifacts: Type.Array(SubagentArtifactRefSchema, { maxItems: 32 }),
    unresolvedIssues: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    recommendedNextAction: Type.Union(SUBAGENT_RECOMMENDED_NEXT_ACTIONS.map((action) => Type.Literal(action)) as never),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 会破坏 Static 推导，T1 经验：显式声明） */
export interface SubagentResultV1 {
  readonly version: 1;
  readonly disposition: SubagentResultDisposition;
  readonly summary: string;
  readonly criteria: readonly {
    readonly criterion: string;
    readonly status: SubagentCriterionStatus;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly artifacts: readonly SubagentArtifactRef[];
  readonly unresolvedIssues: readonly string[];
  readonly recommendedNextAction: SubagentRecommendedNextAction;
}

// ── 协议 Envelope（§8.1）─────────────────────────────────────────

export const SUBAGENT_MESSAGE_PROTOCOL = "opencolorful.agent-message" as const;

export const SUBAGENT_MESSAGE_TYPES = [
  "task", "progress", "steer", "input_required", "result", "error", "cancel", "status",
] as const;
export type SubagentMessageType = (typeof SUBAGENT_MESSAGE_TYPES)[number];

export const SUBAGENT_SENDER_KINDS = ["parent_agent", "subagent", "system"] as const;
export type SubagentSenderKind = (typeof SUBAGENT_SENDER_KINDS)[number];

export const SUBAGENT_RECIPIENT_KINDS = ["parent_agent", "subagent"] as const;
export type SubagentRecipientKind = (typeof SUBAGENT_RECIPIENT_KINDS)[number];

export const SUBAGENT_DELIVERY_MODES = ["immediate", "queue", "interrupt", "mailbox"] as const;
export type SubagentDeliveryMode = (typeof SUBAGENT_DELIVERY_MODES)[number];

export const SubagentContextRefV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("parent_message"),
      messageId: Type.String({ minLength: 1, maxLength: 256 }),
      contentHash: Type.String({ minLength: 8, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("workspace_file"),
      relativePath: Type.String({ minLength: 1, maxLength: 1024 }),
      contentHash: Type.String({ minLength: 8, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("artifact"),
      artifactId: SubagentArtifactIdSchema,
      contentHash: Type.String({ minLength: 8, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("skill"),
      skillRef: SkillRefSchema,
      contentHash: Type.String({ minLength: 8, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
]);
export type SubagentContextRefV1 = Static<typeof SubagentContextRefV1Schema>;

/** messageRefs 只允许 parent_message 引用（§9.2：只引用当前父 Session 可见可读消息） */
export const ParentMessageRefSchema = Type.Object(
  {
    kind: Type.Literal("parent_message"),
    messageId: Type.String({ minLength: 1, maxLength: 256 }),
    contentHash: Type.String({ minLength: 8, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type ParentMessageRef = Static<typeof ParentMessageRefSchema>;

export const AgentMessagePartV1Schema = Type.Union([
  Type.Object({ kind: Type.Literal("text"), text: Type.String({ minLength: 0, maxLength: 65536 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("data"), schema: Type.String({ minLength: 1, maxLength: 128 }), value: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("context_ref"), ref: SubagentContextRefV1Schema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("artifact_ref"), ref: SubagentArtifactRefSchema }, { additionalProperties: false }),
]);
export type AgentMessagePartV1 = Static<typeof AgentMessagePartV1Schema>;

export const AgentMessageEnvelopeV1Schema = Type.Object(
  {
    protocol: Type.Literal(SUBAGENT_MESSAGE_PROTOCOL),
    version: Type.Literal(1),
    messageId: AgentMessageIdSchema,
    contextId: SubagentThreadIdSchema,
    taskId: SubagentRunIdSchema,
    sequence: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
    sender: Type.Object(
      {
        kind: Type.Union(SUBAGENT_SENDER_KINDS.map((kind) => Type.Literal(kind)) as never),
        id: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    recipient: Type.Object(
      {
        kind: Type.Union(SUBAGENT_RECIPIENT_KINDS.map((kind) => Type.Literal(kind)) as never),
        id: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    messageType: Type.Union(SUBAGENT_MESSAGE_TYPES.map((messageType) => Type.Literal(messageType)) as never),
    deliveryMode: Type.Union(SUBAGENT_DELIVERY_MODES.map((mode) => Type.Literal(mode)) as never),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    causationId: Type.Optional(AgentMessageIdSchema),
    parts: Type.Array(AgentMessagePartV1Schema, { minItems: 1, maxItems: 64 }),
    metadata: Type.Object(
      {
        createdAt: Type.String({ minLength: 1, maxLength: 64 }),
        traceId: Type.String({ minLength: 1, maxLength: 64 }),
        parentTurnId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        schemaName: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface AgentMessageEnvelopeV1 {
  readonly protocol: typeof SUBAGENT_MESSAGE_PROTOCOL;
  readonly version: 1;
  readonly messageId: AgentMessageId;
  readonly contextId: SubagentThreadId;
  readonly taskId: SubagentRunId;
  readonly sequence: number;
  readonly sender: { readonly kind: SubagentSenderKind; readonly id: string };
  readonly recipient: { readonly kind: SubagentRecipientKind; readonly id: string };
  readonly messageType: SubagentMessageType;
  readonly deliveryMode: SubagentDeliveryMode;
  readonly correlationId?: string;
  readonly causationId?: AgentMessageId;
  readonly parts: readonly AgentMessagePartV1[];
  readonly metadata: {
    readonly createdAt: string;
    readonly traceId: string;
    readonly parentTurnId?: string;
    readonly schemaName: string;
  };
}

/**
 * Envelope 消息权限（§8.3，平台盖章，调用方不能自报）：
 * - 仅父 Agent 可发 task/steer/cancel；
 * - 仅 Subagent 可发 progress/input_required/result 及执行 error；
 * - system 只能发状态、超时、预算、恢复相关消息。
 */
export const SUBAGENT_MESSAGE_TYPE_PERMISSIONS: Readonly<Record<SubagentMessageType, readonly SubagentSenderKind[]>> = {
  task: ["parent_agent"],
  steer: ["parent_agent"],
  cancel: ["parent_agent"],
  progress: ["subagent"],
  input_required: ["subagent"],
  result: ["subagent"],
  error: ["subagent"],
  status: ["system"],
};

// ── Parent Mailbox 通知（§8.4，独立于 messageType，非别名）──────

export const PARENT_MAILBOX_NOTIFICATION_KINDS = [
  "started", "input_required", "completed", "failed", "cancelled",
  "timed_out", "interrupted", "budget_exhausted",
] as const;
export type ParentMailboxNotificationKind = (typeof PARENT_MAILBOX_NOTIFICATION_KINDS)[number];

/** 仅这些通知触发父 Turn continuation（started 只供查询，不触发） */
export const PARENT_MAILBOX_TRIGGER_KINDS = [
  "input_required", "completed", "failed", "cancelled", "timed_out", "interrupted", "budget_exhausted",
] as const satisfies readonly ParentMailboxNotificationKind[];

export const PARENT_MAILBOX_STATUSES = [
  "queued", "delivering", "delivered", "suppressed", "failed",
] as const;
export type ParentMailboxStatus = (typeof PARENT_MAILBOX_STATUSES)[number];

// ── 任务、上下文与纠偏（§9）──────────────────────────────────────

export const SUBAGENT_EXECUTION_MODES = ["research", "analyze", "implement", "verify", "general"] as const;
export type SubagentExecutionMode = (typeof SUBAGENT_EXECUTION_MODES)[number];

export const SUBAGENT_PROGRESS_MODES = ["milestones", "terminal-only"] as const;
export type SubagentProgressMode = (typeof SUBAGENT_PROGRESS_MODES)[number];

export const SUBAGENT_ARTIFACT_PREFERENCES = ["inline", "references", "both"] as const;
export type SubagentArtifactPreference = (typeof SUBAGENT_ARTIFACT_PREFERENCES)[number];

export const SubagentTaskBriefV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    objective: Type.String({ minLength: 1, maxLength: 8000 }),
    successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }),
    deliverables: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 20 }),
    context: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 }),
    constraints: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 20 }),
    nonGoals: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    executionMode: Type.Union(SUBAGENT_EXECUTION_MODES.map((mode) => Type.Literal(mode)) as never),
    reporting: Type.Object(
      {
        progress: Type.Union(SUBAGENT_PROGRESS_MODES.map((mode) => Type.Literal(mode)) as never),
        evidenceRequired: Type.Boolean(),
        artifactPreference: Type.Union(SUBAGENT_ARTIFACT_PREFERENCES.map((preference) => Type.Literal(preference)) as never),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface SubagentTaskBriefV1 {
  readonly version: 1;
  readonly title: string;
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly deliverables: readonly string[];
  readonly context: readonly string[];
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
  readonly executionMode: SubagentExecutionMode;
  readonly reporting: {
    readonly progress: SubagentProgressMode;
    readonly evidenceRequired: boolean;
    readonly artifactPreference: SubagentArtifactPreference;
  };
}

/** messageRefs 有界快照预算：单条 ≤ 16KB、总计 ≤ 128KB，超限截断并标记 truncated */
export const SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES = 16 * 1024;
export const SUBAGENT_CONTEXT_TOTAL_MAX_BYTES = 128 * 1024;

export const SubagentContextPacketV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    userRequest: Type.String({ minLength: 1, maxLength: 8000 }),
    parentSummary: Type.String({ minLength: 0, maxLength: 8000 }),
    messageRefs: Type.Array(ParentMessageRefSchema, { maxItems: 64 }),
    resources: Type.Array(SubagentContextRefV1Schema, { maxItems: 64 }),
    knownFacts: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 50 }),
    unresolvedQuestions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 }),
  },
  { additionalProperties: false },
);
export type SubagentContextPacketV1 = Static<typeof SubagentContextPacketV1Schema>;

export const SUBAGENT_STEER_ACTIONS = [
  "add_constraint", "remove_constraint", "redirect", "request_evidence",
  "replace_deliverable", "clarify", "answer_input", "stop",
] as const;
export type SubagentSteerAction = (typeof SUBAGENT_STEER_ACTIONS)[number];

export const SubagentSteerV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    targetRunId: SubagentRunIdSchema,
    action: Type.Union(SUBAGENT_STEER_ACTIONS.map((action) => Type.Literal(action)) as never),
    instruction: Type.String({ minLength: 1, maxLength: 4000 }),
    reason: Type.String({ minLength: 0, maxLength: 1000 }),
    preserveCompletedWork: Type.Boolean(),
    deliveryMode: Type.Union([Type.Literal("queue"), Type.Literal("interrupt")]),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface SubagentSteerV1 {
  readonly version: 1;
  readonly targetRunId: SubagentRunId;
  readonly action: SubagentSteerAction;
  readonly instruction: string;
  readonly reason: string;
  readonly preserveCompletedWork: boolean;
  readonly deliveryMode: "queue" | "interrupt";
}

/** 同一 Run 未投递 Steer 队列上限（超限返回 subagent_steer_queue_full） */
export const SUBAGENT_STEER_QUEUE_MAX = 16;

export const SUBAGENT_INPUT_ANSWER_TYPES = ["text", "choice", "resource_ref"] as const;
export type SubagentInputAnswerType = (typeof SUBAGENT_INPUT_ANSWER_TYPES)[number];

export const SubagentInputRequiredV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    question: Type.String({ minLength: 1, maxLength: 2000 }),
    reason: Type.String({ minLength: 0, maxLength: 1000 }),
    expectedAnswerType: Type.Union(SUBAGENT_INPUT_ANSWER_TYPES.map((answerType) => Type.Literal(answerType)) as never),
    choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 8 })),
    blocking: Type.Literal(true),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface SubagentInputRequiredV1 {
  readonly version: 1;
  readonly question: string;
  readonly reason: string;
  readonly expectedAnswerType: SubagentInputAnswerType;
  readonly choices?: readonly string[];
  readonly blocking: true;
}

// ── 模型与设置（§10）─────────────────────────────────────────────

export const SUBAGENT_MODEL_SOURCES = ["user_default", "parent_request", "parent_inherited"] as const;
export type SubagentModelSource = (typeof SUBAGENT_MODEL_SOURCES)[number];

export const SubagentDefaultModelSchema = Type.Union([
  Type.Object(
    {
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      modelId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
]);
export type SubagentDefaultModel = Static<typeof SubagentDefaultModelSchema>;

/** Phase 14 Subagent 偏好段（§10.1；PreferencesDocument 保持 version 2 向后兼容） */
export const SubagentPreferencesSchema = Type.Object(
  {
    defaultModel: SubagentDefaultModelSchema,
  },
  { additionalProperties: false },
);
export type SubagentPreferences = Static<typeof SubagentPreferencesSchema>;

export function defaultSubagentPreferences(): SubagentPreferences {
  return { defaultModel: null };
}

// ── Capability（§12）─────────────────────────────────────────────

export const SUBAGENT_WORKSPACE_ACCESS_MODES = ["read", "write"] as const;
export type SubagentWorkspaceAccessMode = (typeof SUBAGENT_WORKSPACE_ACCESS_MODES)[number];

export const SUBAGENT_NETWORK_MODES = ["none", "inherit"] as const;
export type SubagentNetworkMode = (typeof SUBAGENT_NETWORK_MODES)[number];

export const SUBAGENT_CAPABILITY_MODES = ["inherit", "allowlist"] as const;
export type SubagentCapabilityMode = (typeof SUBAGENT_CAPABILITY_MODES)[number];

export const SubagentCapabilityRequestV1Schema = Type.Object(
  {
    tools: Type.Object(
      {
        mode: Type.Union(SUBAGENT_CAPABILITY_MODES.map((mode) => Type.Literal(mode)) as never),
        ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 })),
      },
      { additionalProperties: false },
    ),
    plugins: Type.Object(
      {
        mode: Type.Union(SUBAGENT_CAPABILITY_MODES.map((mode) => Type.Literal(mode)) as never),
        pluginIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
        contributionIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 512 })),
      },
      { additionalProperties: false },
    ),
    skills: Type.Object(
      {
        mode: Type.Union(SUBAGENT_CAPABILITY_MODES.map((mode) => Type.Literal(mode)) as never),
        refs: Type.Optional(Type.Array(SkillRefSchema, { maxItems: 128 })),
      },
      { additionalProperties: false },
    ),
    workspaceAccess: Type.Union(SUBAGENT_WORKSPACE_ACCESS_MODES.map((mode) => Type.Literal(mode)) as never),
    network: Type.Union(SUBAGENT_NETWORK_MODES.map((mode) => Type.Literal(mode)) as never),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface SubagentCapabilityRequestV1 {
  readonly tools: { readonly mode: SubagentCapabilityMode; readonly ids?: readonly string[] };
  readonly plugins: {
    readonly mode: SubagentCapabilityMode;
    readonly pluginIds?: readonly string[];
    readonly contributionIds?: readonly string[];
  };
  readonly skills: { readonly mode: SubagentCapabilityMode; readonly refs?: readonly SkillRef[] };
  readonly workspaceAccess: SubagentWorkspaceAccessMode;
  readonly network: SubagentNetworkMode;
}

export function defaultSubagentCapabilityRequest(): SubagentCapabilityRequestV1 {
  return {
    tools: { mode: "inherit" },
    plugins: { mode: "inherit" },
    skills: { mode: "inherit" },
    workspaceAccess: "read",
    network: "inherit",
  };
}

export const TOOL_SIDE_EFFECT_CLASSES = [
  "none", "workspace-read", "workspace-write", "external-read", "external-write", "administrative", "unknown",
] as const;
export type ToolSideEffectClass = (typeof TOOL_SIDE_EFFECT_CLASSES)[number];

export const SubagentCapabilitySummarySchema = Type.Object(
  {
    ceilingHash: Type.String({ minLength: 8, maxLength: 128 }),
    workspaceAccess: Type.Union(SUBAGENT_WORKSPACE_ACCESS_MODES.map((mode) => Type.Literal(mode)) as never),
    toolIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 }),
    pluginContributionIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 512 }),
    skillRefs: Type.Array(SkillRefSchema, { maxItems: 128 }),
    network: Type.Union(SUBAGENT_NETWORK_MODES.map((mode) => Type.Literal(mode)) as never),
    fixedDenials: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 }),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface SubagentCapabilitySummary {
  readonly ceilingHash: string;
  readonly workspaceAccess: SubagentWorkspaceAccessMode;
  readonly toolIds: readonly string[];
  readonly pluginContributionIds: readonly string[];
  readonly skillRefs: readonly SkillRef[];
  readonly network: SubagentNetworkMode;
  readonly fixedDenials: readonly string[];
}

/**
 * 平台固定禁用能力（§12.3，逐字清单）——EffectiveSnapshot 恒减去这些，
 * Subagent 永不获得：记忆/子 Agent 创建/Provider 凭据/Plugin 管理/Skill
 * 管理/Observability 管理/Session 管理/平台配置。
 */
export const SUBAGENT_PLATFORM_FIXED_DENIALS = [
  "search_memory",
  "memory_intent",
  "memory_agent",
  "spawn_subagent",
  "agent_admin",
  "provider_credentials",
  "plugin_admin",
  "skill_admin",
  "observability_admin",
  "session_admin",
  "platform_config",
  "host_admin",
] as const satisfies readonly string[];

// ── 预算与活性（§15）─────────────────────────────────────────────

export const SubagentRunLimitsV1Schema = Type.Object(
  {
    startupTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    providerFirstEventTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 600_000 }),
    providerEventIdleTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 1_800_000 }),
    idleTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 1_800_000 }),
    totalRunTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    maxModelIterations: Type.Integer({ minimum: 1, maximum: 100 }),
    maxToolCalls: Type.Integer({ minimum: 1, maximum: 500 }),
    maxTotalTokens: Type.Integer({ minimum: 1_000, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);
export type SubagentRunLimitsV1 = Static<typeof SubagentRunLimitsV1Schema>;

/** 平台默认 Run 限制（§15.2，逐字）；主 Agent 创建时可请求更小，不能超过平台最大值 */
export const SUBAGENT_RUN_LIMITS_DEFAULTS: SubagentRunLimitsV1 = {
  startupTimeoutMs: 60_000,
  providerFirstEventTimeoutMs: 90_000,
  providerEventIdleTimeoutMs: 180_000,
  idleTimeoutMs: 180_000,
  totalRunTimeoutMs: 30 * 60_000,
  maxModelIterations: 24,
  maxToolCalls: 64,
  maxTotalTokens: 200_000,
};

/** 平台最大值（上限：totalRunTimeoutMs 60min、token 200K 为硬上限） */
export const SUBAGENT_RUN_LIMITS_MAXIMUM: SubagentRunLimitsV1 = {
  startupTimeoutMs: 300_000,
  providerFirstEventTimeoutMs: 600_000,
  providerEventIdleTimeoutMs: 1_800_000,
  idleTimeoutMs: 1_800_000,
  totalRunTimeoutMs: 60 * 60_000,
  maxModelIterations: 100,
  maxToolCalls: 500,
  maxTotalTokens: 1_000_000,
};

export const SUBAGENT_HEARTBEAT_INTERVAL_MS = 15_000;
export const SUBAGENT_RUNTIME_LEASE_TTL_MS = 45_000;

/** 空闲 24 小时且无活动 Run → Thread 自动关闭（保留历史） */
export const SUBAGENT_THREAD_IDLE_CLOSE_MS = 24 * 60 * 60 * 1000;

// ── 稳定错误码（T1 冻结）─────────────────────────────────────────

/**
 * Phase 14 稳定错误码（plans/phase-14.md 逐字 + T1 补充最小必要集）。
 * 补充项：subagent_run_state_conflict（状态机非法转换/非终态唯一冲突）、
 * subagent_thread_state_conflict（closed/closing 上不允许的操作）、
 * subagent_ownership_denied（§22.1 跨 Agent/Session 归属拒绝）、
 * subagent_not_found（查找不存在，API 语义不泄露对象是否存在）。
 */
export const SUBAGENT_ERROR_CODES = [
  // 计划逐字错误码
  "subagent_steer_queue_full",
  "subagent_model_override_denied",
  "subagent_model_required",
  "subagent_model_unavailable",
  "subagent_result_not_reported",
  "subagent_nesting_forbidden",
  "subagent_runtime_unavailable",
  "subagent_artifact_integrity_failed",
  // T1 补充（状态机/归属/查找）
  "subagent_run_state_conflict",
  "subagent_thread_state_conflict",
  "subagent_ownership_denied",
  "subagent_not_found",
  "subagent_operation_failed",
] as const;
export type SubagentErrorCode = (typeof SUBAGENT_ERROR_CODES)[number];

export const SubagentErrorSchema = Type.Object(
  {
    code: Type.Union(SUBAGENT_ERROR_CODES.map((code) => Type.Literal(code)) as never),
    message: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
/** 手动类型（schema 的 map Union 破坏 Static 推导；字段与 Schema 严格一致） */
export interface SubagentError {
  readonly code: SubagentErrorCode;
  readonly message: string;
}
