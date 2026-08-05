import { Type, type Static, type TSchema } from "typebox";

// ═══════════════════════════════════════════════════════════════
// Phase 11 统一可观测性契约（plans/phase-11.md §三）
//
// 设计要点：
// - Observability Envelope 与 PlatformEventEnvelope（events.ts）分离，
//   只共享 Actor/Scope/Trace 等值类型的语义，不复用 transport 序列号；
// - channel 判别联合：activity / audit / diagnostic 三类 payload 不可错配；
// - 平台权威字段（eventId/recordedAt/channel/actor/executor/scope/trace/producer）
//   由 Recorder 生成或重新盖章，业务模块不能覆盖；
// - 目录（event-catalog.ts）固定 channel/level/significance/schema，调用方不可指定。
// ═══════════════════════════════════════════════════════════════

export const OBSERVABILITY_SCHEMA_VERSION = 1 as const;

// ─── 级别与状态 ────────────────────────────────────────────────

export const OBSERVABILITY_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type ObservabilityLevel = (typeof OBSERVABILITY_LEVELS)[number];

/** 业务结果状态（status）与运行严重程度（level）分离 */
export const ACTIVITY_STATUSES = [
  "started", "processing", "completed", "degraded", "failed", "cancelled",
  "denied", "deferred", "retrying", "skipped", "interrupted",
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** 唯一终态集合（一个 operationId 只能有一个 started 与一个终态） */
export const ACTIVITY_TERMINAL_STATUSES = [
  "completed", "degraded", "failed", "cancelled", "denied", "deferred", "skipped", "interrupted",
] as const satisfies readonly ActivityStatus[];

export const OBSERVABILITY_SIGNIFICANCES = ["routine", "notable", "milestone"] as const;
export type ObservabilitySignificance = (typeof OBSERVABILITY_SIGNIFICANCES)[number];

export const OBSERVABILITY_CHANNELS = ["diagnostic", "activity", "audit"] as const;
export type ObservabilityChannel = (typeof OBSERVABILITY_CHANNELS)[number];

export const LIFECYCLE_ROLES = ["started", "progress", "terminal", "point"] as const;
export type LifecycleRole = (typeof LIFECYCLE_ROLES)[number];

// ─── Actor / Executor / Target ─────────────────────────────────

export const ACTOR_KINDS = ["user", "agent", "subagent", "memory_agent", "plugin", "scheduler", "system", "supervisor"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const EXECUTOR_KINDS = ["service", "agent", "subagent", "memory_agent", "plugin", "worker", "system"] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

export const TARGET_KINDS = [
  "platform", "agent", "session", "turn", "tool", "file", "workspace",
  "memory_fact", "memory_event", "memory_batch", "plugin", "provider", "configuration", "external_resource",
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const ActorRefSchema = Type.Object({
  kind: Type.Union([
      Type.Literal("user"),
      Type.Literal("agent"),
      Type.Literal("subagent"),
      Type.Literal("memory_agent"),
      Type.Literal("plugin"),
      Type.Literal("scheduler"),
      Type.Literal("system"),
      Type.Literal("supervisor"),
    ]),
  id: Type.String({ minLength: 1, maxLength: 128 }),
});
export type ActorRef = Static<typeof ActorRefSchema>;

export const ExecutorRefSchema = Type.Object({
  kind: Type.Union([
      Type.Literal("service"),
      Type.Literal("agent"),
      Type.Literal("subagent"),
      Type.Literal("memory_agent"),
      Type.Literal("plugin"),
      Type.Literal("worker"),
      Type.Literal("system"),
    ]),
  id: Type.String({ minLength: 1, maxLength: 128 }),
});
export type ExecutorRef = Static<typeof ExecutorRefSchema>;

export const ResourceRefSchema = Type.Object({
  kind: Type.Union([
      Type.Literal("platform"),
      Type.Literal("agent"),
      Type.Literal("session"),
      Type.Literal("turn"),
      Type.Literal("tool"),
      Type.Literal("file"),
      Type.Literal("workspace"),
      Type.Literal("memory_fact"),
      Type.Literal("memory_event"),
      Type.Literal("memory_batch"),
      Type.Literal("plugin"),
      Type.Literal("provider"),
      Type.Literal("configuration"),
      Type.Literal("external_resource"),
    ]),
  id: Type.String({ minLength: 1, maxLength: 256 }),
});
export type ResourceRef = Static<typeof ResourceRefSchema>;

// ─── Scope / Trace / Producer ──────────────────────────────────

/** 活动归属：ownerAgentId 表达永久归属，临时 subagent/记忆 Agent/插件不冒充 Agent 身份 */
export const EventScopeSchema = Type.Object(
  {
    ownerAgentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    subagentRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    pluginId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type EventScope = Static<typeof EventScopeSchema>;

export const TraceContextSchema = Type.Object(
  {
    traceId: Type.String({ minLength: 1, maxLength: 64 }),
    spanId: Type.String({ minLength: 1, maxLength: 64 }),
    parentSpanId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    linkedTraceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 16 })),
  },
  { additionalProperties: false },
);
export type TraceContext = Static<typeof TraceContextSchema>;

export const PROCESS_TYPES = ["server", "supervisor", "web", "plugin", "worker"] as const;
export type ObservabilityProcessType = (typeof PROCESS_TYPES)[number];

export const ProducerContextSchema = Type.Object(
  {
    component: Type.String({ minLength: 1, maxLength: 96 }),
    processType: Type.Union([
      Type.Literal("server"),
      Type.Literal("supervisor"),
      Type.Literal("web"),
      Type.Literal("plugin"),
      Type.Literal("worker"),
    ]),
    processId: Type.String({ minLength: 1, maxLength: 32 }),
    bootId: Type.String({ minLength: 1, maxLength: 64 }),
    appVersion: Type.String({ minLength: 1, maxLength: 32 }),
    hostPlatform: Type.String({ minLength: 1, maxLength: 32 }),
  },
  { additionalProperties: false },
);
export type ProducerContext = Static<typeof ProducerContextSchema>;

// ─── SafeValue：受限 payload 字段类型 ──────────────────────────

/** 单 attribute 字符串上限（2KB）与数量上限（32），由 SafeValue normalize 强制执行 */
export const OBSERVABILITY_ATTRIBUTE_LIMITS = {
  maxStringLength: 2_000,
  maxAttributeCount: 32,
  maxArrayLength: 50,
  maxDepth: 5,
  maxPayloadBytes: 32 * 1024,
} as const;

/** 可安全落库的标量；对象/数组受深度与长度限制，密钥/路径/原文在 normalize 阶段剔除 */
export const SafeScalarSchema = Type.Union([
  Type.String({ maxLength: OBSERVABILITY_ATTRIBUTE_LIMITS.maxStringLength }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
/** Static 显式声明：空 props Object + additionalProperties 的 Static 会退化为 `{}`，无法索引 */
export type SafeScalar = string | number | boolean | null;

/** 单层 SafeValue（标量 / 标量数组 / 标量对象）；更深结构由 T2 SafeValue normalize 收敛到单层 */
export const SafeValueSchema = Type.Union([
  Type.String({ maxLength: OBSERVABILITY_ATTRIBUTE_LIMITS.maxStringLength }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Array(SafeScalarSchema, { maxItems: OBSERVABILITY_ATTRIBUTE_LIMITS.maxArrayLength }),
  Type.Object({}, { additionalProperties: SafeScalarSchema }),
]);
/** 递归显式声明（Static 对空 props Object + additionalProperties 会退化为 `{}`；别名直接自引用会 TS2456，故经 interface 间接） */
export interface SafeValueList extends Array<SafeValue> {}
export interface SafeValueMap { [key: string]: SafeValue }
export type SafeValue = SafeScalar | SafeValueList | SafeValueMap;

/** attributes/metrics 容器：值域为 SafeValue（含嵌套对象/数组，由 normalize 收敛深度） */
export const SafeObjectSchema = Type.Object({}, { additionalProperties: SafeValueSchema });
export type SafeObject = Record<string, SafeValue>;

// ─── 三类 Payload ──────────────────────────────────────────────

/** ActivityPayload：语义摘要而非原文副本（§3.7）；Static 显式声明（Optional(SafeObjectSchema) 的 Static 会退化为 object） */
export const ActivityPayloadSchema = Type.Object(
  {
    /** 稳定英文机器标识，中文文案由 Web 映射 */
    summaryCode: Type.String({ minLength: 1, maxLength: 96 }),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    attempt: Type.Optional(Type.Integer({ minimum: 1 })),
    metrics: Type.Optional(SafeObjectSchema),
    /** 指向领域事实源（sessionEntryId/memoryId/batchId…），不复制正文 */
    resultRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    relatedResources: Type.Optional(Type.Array(ResourceRefSchema, { maxItems: 8 })),
    attributes: Type.Optional(SafeObjectSchema),
  },
  { additionalProperties: false },
);
export interface ActivityPayload {
  /** 稳定英文机器标识，中文文案由 Web 映射 */
  summaryCode: string;
  durationMs?: number;
  attempt?: number;
  metrics?: SafeObject;
  /** 指向领域事实源（sessionEntryId/memoryId/batchId…），不复制正文 */
  resultRef?: string;
  relatedResources?: ResourceRef[];
  attributes?: SafeObject;
}

/** AuditPayload：责任与策略证据，不含正文（§3.7 / §6.3） */
export const AuditPayloadSchema = Type.Object(
  {
    action: Type.String({ minLength: 1, maxLength: 96 }),
    decision: Type.Union([Type.Literal("allowed"), Type.Literal("denied"), Type.Literal("required"), Type.Literal("deferred"), Type.Literal("reset")]),
    reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    policyVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    beforeRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    afterRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    changedFields: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 16 })),
    approver: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** §17.3 可验证补偿：写入已生效但审计事务失败时，failed 终态记录外部副作用补偿结果 */
    compensation: Type.Optional(Type.Union([Type.Literal("not-applicable"), Type.Literal("rolled-back"), Type.Literal("rollback-failed"), Type.Literal("uncompensated")])),
  },
  { additionalProperties: false },
);
export interface AuditPayload {
  action: string;
  decision: "allowed" | "denied" | "required" | "deferred" | "reset";
  reasonCode?: string;
  policyVersion?: string;
  beforeRevision?: string;
  afterRevision?: string;
  changedFields?: string[];
  approver?: string;
  compensation?: "not-applicable" | "rolled-back" | "rollback-failed" | "uncompensated";
}

/** DiagnosticPayload：可丢弃的排错材料，message 上限 4KB / stack 16KB */
export const DiagnosticPayloadSchema = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 4_000 }),
    stack: Type.Optional(Type.String({ maxLength: 16_000 })),
    attributes: Type.Optional(SafeObjectSchema),
  },
  { additionalProperties: false },
);
export interface DiagnosticPayload {
  message: string;
  stack?: string;
  attributes?: SafeObject;
}

// ─── Envelope 判别联合 ─────────────────────────────────────────

/**
 * 各通道 Envelope 用完整 Object schema 内联定义
 * （typebox 本版本的 Value.Check 不支持 Type.Intersect；spread 展开也会丢失 props 类型推断）。
 */
const BASE_FIELDS = [
  "schemaVersion",
  "eventVersion",
  "eventId",
  "eventName",
  "occurredAt",
  "recordedAt",
  "level",
  "actor",
  "executor",
  "target",
  "scope",
  "trace",
  "producer",
] as const;

function envelopeProps(extra: Record<string, TSchema>): Record<string, TSchema> {
  return {
    schemaVersion: Type.Literal(OBSERVABILITY_SCHEMA_VERSION),
    eventVersion: Type.Integer({ minimum: 1 }),
    eventId: Type.String({ minLength: 1, maxLength: 64 }),
    eventName: Type.String({ minLength: 1, maxLength: 120 }),
    occurredAt: Type.String({ minLength: 1 }),
    recordedAt: Type.String({ minLength: 1 }),
    level: Type.Union([
      Type.Literal("trace"),
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
      Type.Literal("fatal"),
    ]),
    actor: ActorRefSchema,
    executor: ExecutorRefSchema,
    target: Type.Optional(ResourceRefSchema),
    scope: EventScopeSchema,
    trace: TraceContextSchema,
    producer: ProducerContextSchema,
    ...extra,
  };
}
void BASE_FIELDS;

export const ActivityEnvelopeSchema = Type.Object(
  envelopeProps({
    channel: Type.Literal("activity"),
    status: Type.Optional(Type.Union([
      Type.Literal("started"),
      Type.Literal("processing"),
      Type.Literal("completed"),
      Type.Literal("degraded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("denied"),
      Type.Literal("deferred"),
      Type.Literal("retrying"),
      Type.Literal("skipped"),
      Type.Literal("interrupted"),
    ])),
    significance: Type.Optional(Type.Union([
      Type.Literal("routine"),
      Type.Literal("notable"),
      Type.Literal("milestone"),
    ])),
    payload: ActivityPayloadSchema,
  }),
  { additionalProperties: false },
);

/**
 * Envelope 的静态类型显式声明：schema 经 Record spread 构造后 Static 会丢失
 * props 推断（actor/trace/payload 等退化为 unknown），故类型与 schema 分离——
 * schema 仅用于运行时 Value.Check，静态类型以本接口为准。
 */
export interface ActivityEnvelope {
  schemaVersion: 1;
  eventVersion: number;
  eventId: string;
  eventName: string;
  occurredAt: string;
  recordedAt: string;
  level: ObservabilityLevel;
  actor: ActorRef;
  executor: ExecutorRef;
  target?: ResourceRef;
  scope: EventScope;
  trace: TraceContext;
  producer: ProducerContext;
  channel: "activity";
  status?: ActivityStatus;
  significance?: ObservabilitySignificance;
  payload: ActivityPayload;
}

export const AuditEnvelopeSchema = Type.Object(
  envelopeProps({
    channel: Type.Literal("audit"),
    payload: AuditPayloadSchema,
  }),
  { additionalProperties: false },
);

export interface AuditEnvelope {
  schemaVersion: 1;
  eventVersion: number;
  eventId: string;
  eventName: string;
  occurredAt: string;
  recordedAt: string;
  level: ObservabilityLevel;
  actor: ActorRef;
  executor: ExecutorRef;
  target?: ResourceRef;
  scope: EventScope;
  trace: TraceContext;
  producer: ProducerContext;
  channel: "audit";
  payload: AuditPayload;
}

export const DiagnosticEnvelopeSchema = Type.Object(
  envelopeProps({
    channel: Type.Literal("diagnostic"),
    payload: DiagnosticPayloadSchema,
  }),
  { additionalProperties: false },
);

export interface DiagnosticEnvelope {
  schemaVersion: 1;
  eventVersion: number;
  eventId: string;
  eventName: string;
  occurredAt: string;
  recordedAt: string;
  level: ObservabilityLevel;
  actor: ActorRef;
  executor: ExecutorRef;
  target?: ResourceRef;
  scope: EventScope;
  trace: TraceContext;
  producer: ProducerContext;
  channel: "diagnostic";
  payload: DiagnosticPayload;
}


export const ObservabilityEventEnvelopeSchema = Type.Union([
  ActivityEnvelopeSchema,
  AuditEnvelopeSchema,
  DiagnosticEnvelopeSchema,
]);
export type ObservabilityEventEnvelope = ActivityEnvelope | AuditEnvelope | DiagnosticEnvelope;

// ─── 事件目录条目类型（实例见 src/observability/event-catalog.ts） ──

export const SECURITY_SUMMARY_POLICIES = ["include", "exclude", "redacted"] as const;
export type SecuritySummaryPolicy = (typeof SECURITY_SUMMARY_POLICIES)[number];

export const PRODUCER_POLICIES = ["platform-only", "extension-allowed"] as const;
export type ProducerPolicy = (typeof PRODUCER_POLICIES)[number];

export interface EventCatalogEntry {
  readonly eventName: string;
  readonly eventVersion: number;
  /** durable 通道：activity 或 audit；diagnostic 不进入注册表 */
  readonly channel: "activity" | "audit";
  readonly category: string;
  readonly defaultLevel: "info" | "warn" | "error";
  readonly significance: ObservabilitySignificance;
  readonly lifecycleRole: LifecycleRole;
  readonly terminalStatuses?: readonly ActivityStatus[];
  /**
   * payload schema（评审 P1-9）：目录固定每事件的 payload 形状，
   * Recorder 校验不通过即拒绝——调用方不能靠通用 Envelope 蒙混。
   * activity 事件默认 ActivityPayloadSchema；audit 事件默认 AuditPayloadSchema。
   */
  readonly payloadSchema: TSchema;
  /** 同名事件镜像为 Audit（§6.3） */
  readonly auditMirror?: string;
  readonly securitySummary: SecuritySummaryPolicy;
  readonly producerPolicy: ProducerPolicy;
}
