import { Type, type Static } from "typebox";
import Value from "typebox/value";

import {
  SUBAGENT_MESSAGE_PROTOCOL,
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  SubagentCapabilityRequestV1Schema,
  SubagentContextPacketV1Schema,
  SubagentRunLimitsV1Schema,
  SubagentSteerV1Schema,
  SubagentTaskBriefV1Schema,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type ParentMailboxId,
  type SubagentCapabilitySummary,
  type SubagentRunId,
  type SubagentRunStatus,
  type SubagentSnapshotId,
  type SubagentSteerV1,
  type SubagentThreadId,
} from "../contracts/subagents.js";
import {
  computeEffectiveSnapshot,
  defaultCapabilityCeiling,
  normalizeCapabilityRequest,
  normalizeSubagentRunLimits,
  resolveSubagentModel,
  sha256Hex,
  stableSerialize,
  summarizeEffectiveSnapshot,
  type NormalizedCapabilityCeiling,
} from "../runtime/subagents/delegation-policy.js";
import { renderContextPacket, renderSteer, renderTaskBrief } from "../runtime/subagents/task-renderer.js";
import { isSubagentRunTerminal } from "../contracts/subagents.js";
import type { ExecuteSubagentRunInput } from "../runtime/subagents/runtime/runtime-host.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSubagentAbilityExecutor, requireSubagentContext, type SubagentToolContext } from "./subagent-tools-context.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T6：主 Agent 七个 Core 工具（plans/phase-14.md §20.1）
//
// spawn_subagent / get_subagent_status / inspect_subagent /
// steer_subagent / wait_subagent / cancel_subagent / close_subagent
//
// - 只注册普通主 Agent Session（§20.2：无 Agent Session、Subagent
//   Session、Memory Agent、Plugin worker 不注册；组合根缺少 Subagent
//   服务时不注册工具，不静默 no-op）；
// - 工具上下文经 registerSubagentContext 注入（ownerAgentId/sessionId/
//   turnId/trace 盖章，§20.2）；参数中不出现归属字段；
// - spawn 流程（§16.4 #1 + §22.5）：契约校验 → 模型解析（§10.2 三档
//   优先级）→ CapabilityCeiling/limits 归一化 → EffectiveSnapshot
//   （§12.1）→ durable 审计 started → 原子创建 Thread+Run+task 消息
//   （含 task_brief.v1/context_packet.v1 data parts）→ 渲染 prompt →
//   Scheduler 排队执行 → durable 审计 terminal；
// - 失败不 fail-open：模型不可用/审计拒绝/容量超限都返回稳定错误码，
//   不创建无人执行的 Run；
// - 返回 JSON 文本（模型可读）；错误码用 SUBAGENT_ERROR_CODES 稳定集合。
// ═══════════════════════════════════════════════════════════════

// ── 工具参数 schema ─────────────────────────────────────────────

const SpawnSubagentArgsSchema = Type.Object(
  {
    brief: SubagentTaskBriefV1Schema,
    context: SubagentContextPacketV1Schema,
    model: Type.Optional(
      Type.Object(
        {
          providerId: Type.String({ minLength: 1, maxLength: 128 }),
          modelId: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false },
      ),
    ),
    thinkingLevel: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    capabilities: Type.Optional(SubagentCapabilityRequestV1Schema),
    limits: Type.Optional(Type.Partial(SubagentRunLimitsV1Schema)),
  },
  { additionalProperties: false },
);
type SpawnSubagentArgs = Static<typeof SpawnSubagentArgsSchema>;

const GetSubagentStatusArgsSchema = Type.Object(
  {
    threadId: Type.Optional(SubagentThreadIdSchema()),
  },
  { additionalProperties: false },
);

const InspectSubagentArgsSchema = Type.Object(
  {
    threadId: SubagentThreadIdSchema(),
    runId: Type.Optional(SubagentRunIdSchema()),
    afterSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    include: Type.Array(
      Type.Union([
        Type.Literal("messages"),
        Type.Literal("tools"),
        Type.Literal("steers"),
        Type.Literal("artifacts"),
        Type.Literal("result"),
      ]),
      { minItems: 1, maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);

const SteerSubagentArgsSchema = SubagentSteerV1Schema;

const WaitSubagentArgsSchema = Type.Object(
  {
    threadIds: Type.Array(SubagentThreadIdSchema(), { minItems: 1, maxItems: 8 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 60_000 })),
    afterSequenceByThread: Type.Optional(
      Type.Record(SubagentThreadIdSchema(), Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
    ),
  },
  { additionalProperties: false },
);

const CancelSubagentArgsSchema = Type.Object(
  {
    threadId: SubagentThreadIdSchema(),
    runId: Type.Optional(SubagentRunIdSchema()),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);

const CloseSubagentArgsSchema = Type.Object(
  {
    threadId: SubagentThreadIdSchema(),
  },
  { additionalProperties: false },
);

function SubagentThreadIdSchema(): ReturnType<typeof Type.String> {
  return Type.String({ pattern: "^sat_[A-Za-z0-9_-]{8,128}$" });
}

function SubagentRunIdSchema(): ReturnType<typeof Type.String> {
  return Type.String({ pattern: "^sar_[A-Za-z0-9_-]{8,128}$" });
}

// ── 工具返回 helper ─────────────────────────────────────────────

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

function okResult(payload: unknown): ReturnType<typeof textResult> {
  return textResult(JSON.stringify({ ...(payload as object), status: "ok" }));
}

function errorResult(code: string, message: string): ReturnType<typeof textResult> {
  return textResult(JSON.stringify({ status: "error", code, message }));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

// ── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // ── spawn_subagent ──────────────────────────────────────────
  pi.registerTool({
    name: "spawn_subagent",
    label: "spawn_subagent",
    description:
      "委派一个子代理（subagent）执行独立任务。提供任务简报（brief，含目标/成功标准/交付物/约束）、上下文包（context，含引用消息与授权资源）。spawn 持久化成功后立即返回（accepted），不等待子代理完成；之后用 get_subagent_status / wait_subagent / steer_subagent 跟进。",
    parameters: SpawnSubagentArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireSubagentContext(executionContext);
      if (!ctx.services.available()) {
        return errorResult("subagent_runtime_unavailable", "Subagent 运行时不可用（启动恢复未完成或有错误）");
      }
      const raw = params as SpawnSubagentArgs;
      if (!Value.Check(SpawnSubagentArgsSchema, raw)) {
        return errorResult("subagent_invalid_args", "spawn_subagent 参数校验失败");
      }
      return spawnSubagent(ctx, raw);
    },
  });

  // ── get_subagent_status ─────────────────────────────────────
  pi.registerTool({
    name: "get_subagent_status",
    label: "get_subagent_status",
    description:
      "查询子代理状态。传 threadId 查询单个 Thread（当前/最近 Run、阶段、用量、Mailbox 与结果摘要）；不传时列出当前会话的 open/最近 Thread。不返回 transcript 正文（用 inspect_subagent）。",
    parameters: GetSubagentStatusArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireSubagentContext(executionContext);
      const raw = params as { threadId?: string };
      return getSubagentStatus(ctx, raw.threadId as SubagentThreadId | undefined);
    },
  });

  // ── inspect_subagent ────────────────────────────────────────
  pi.registerTool({
    name: "inspect_subagent",
    label: "inspect_subagent",
    description:
      "查看子代理 Thread 的受限、脱敏观察结果（消息/工具摘要/纠偏/工件/结果），供主 Agent 判断是否需要纠偏或验收。不返回隐藏推理与系统提示。",
    parameters: InspectSubagentArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireSubagentContext(executionContext);
      const raw = params as {
        threadId: SubagentThreadId;
        runId?: SubagentRunId;
        afterSequence?: number;
        limit?: number;
        include: readonly string[];
      };
      return inspectSubagent(ctx, raw);
    },
  });

  // ── steer_subagent ──────────────────────────────────────────
  pi.registerTool({
    name: "steer_subagent",
    label: "steer_subagent",
    description:
      "向子代理投递结构化纠偏（SubagentSteerV1：动作/指令/原因/是否保留已完成工作）。活动 Run 按 queue/interrupt 投递；最近 Run 已终态且 Thread open 时创建下一 Run 并把纠偏作为新输入；action=stop 转为取消。",
    parameters: SteerSubagentArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireSubagentContext(executionContext);
      if (!Value.Check(SubagentSteerV1Schema, params)) {
        return errorResult("subagent_invalid_args", "steer_subagent 参数校验失败");
      }
      return steerSubagent(ctx, params as SubagentSteerV1);
    },
  });

  // ── wait_subagent ───────────────────────────────────────────
  pi.registerTool({
    name: "wait_subagent",
    label: "wait_subagent",
    description:
      "等待一个或多个子代理出现关键状态（终态或等待父输入）或超时。timeout 返回最新快照不视为错误——必须检查返回中的 status 判断是否终态，不能以'有返回'当作任务完成。重复 wait 使用 afterSequenceByThread cursor，不重不漏。",
    parameters: WaitSubagentArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, signal, _onUpdate, executionContext) {
      const ctx = requireSubagentContext(executionContext);
      const raw = params as {
        threadIds: readonly SubagentThreadId[];
        timeoutMs?: number;
        afterSequenceByThread?: Record<string, number>;
      };
      return waitSubagent(ctx, raw, signal);
    },
  });

  // ── cancel_subagent ─────────────────────────────────────────
  pi.registerTool({
    name: "cancel_subagent",
    label: "cancel_subagent",
    description:
      "取消指定 Thread 的当前活动 Run（进入 cancelling 后中止 Runtime；幂等：已终态返回已有状态）。必填结构化 reason。不自动关闭 Thread。",
    parameters: CancelSubagentArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireSubagentContext(executionContext);
      const raw = params as { threadId: SubagentThreadId; runId?: SubagentRunId; reason: string };
      return cancelSubagent(ctx, raw);
    },
  });

  // ── close_subagent ──────────────────────────────────────────
  pi.registerTool({
    name: "close_subagent",
    label: "close_subagent",
    description:
      "关闭子代理 Thread。有活动 Run 时先取消再关闭（closedNow=false）；关闭后仍可观察历史；幂等；不删除 Workspace Artifact 文件。",
    parameters: CloseSubagentArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireSubagentContext(executionContext);
      const raw = params as { threadId: SubagentThreadId };
      return closeSubagent(ctx, raw.threadId);
    },
  });
}

// ── spawn 实现（§16.4 #1 + §22.5）──────────────────────────────

function spawnSubagent(ctx: SubagentToolContext, raw: SpawnSubagentArgs): ReturnType<typeof textResult> {
  const services = ctx.services;
  const ownership = { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId };
  const now = new Date(services.now()).toISOString();

  // 1. 模型解析（§10.2 三档优先级；失败不 fallback）
  const model = resolveSubagentModel({
    userDefault: services.preferences()?.subagents?.defaultModel ?? null,
    ...(raw.model !== undefined
      ? { parentRequest: { providerId: raw.model.providerId, modelId: raw.model.modelId } }
      : {}),
    parentInherited: services.currentModel(),
    resolveModel: services.modelResolver,
    now: services.now,
  });
  if (model.status !== "resolved") {
    return errorResult(model.code, model.message);
  }

  // 2. CapabilityCeiling + limits 归一化（超限拒绝）
  const ceiling = raw.capabilities === undefined ? defaultCapabilityCeiling() : normalizeCapabilityRequest(raw.capabilities);
  const limits = normalizeSubagentRunLimits(raw.limits);
  if (!limits.ok) {
    return errorResult("subagent_limits_exceeded", limits.reason ?? "运行限制超出平台上限");
  }

  // 2.5 容量预检（复审 P1-2）：领域写入前检查，队列满/积压超限提前拒绝，
  //     不创建无人调度的 Run（预检与 submit 之间无 await，无竞态）
  if (!services.scheduler.canAccept()) {
    return errorResult("subagent_runtime_unavailable", "Subagent 运行时排队积压超过上限，请稍后重试");
  }

  // 3. EffectiveSnapshot（§12.1：父有效能力 ∩ ceiling - 固定禁用）。parentSnapshot
  //    现场冻结真实插件执行快照与当前 turn 的 Skill 可见集（复审 P0-2/P0-3）
  const parent = services.parentSnapshot();
  const snapshot = computeEffectiveSnapshot({
    parentToolIds: parent.toolIds,
    parentPluginContributions: parent.pluginContributions,
    parentSkillEntries: parent.skillEntries,
    ceiling,
  });

  // 3.5 run-scoped 能力工具执行器（复审 P0-2/P0-3）：快照 toolIds 必须全部可
  //     解析、插件执行快照必须全部冻结成功，任何缺失 → 整体拒绝（fail-closed，
  //     不静默 filter 缩减、不创建快照与实际注册表不一致的 Run）
  const threadId = services.newId("sat_") as SubagentThreadId;
  const runId = services.newId("sar_") as SubagentRunId;
  const executorResult = services.createRunToolExecutor({
    runId,
    snapshot,
    spawnTurnId: ctx.turnIdSlot.current ?? null,
  });
  if (!executorResult.ok) {
    return errorResult("subagent_operation_failed", executorResult.reason);
  }

  // 4. durable 审计 started（§22.5 / §19.3：审计不可用/被拒 → fail-closed 不创建）
  const triggerMessageId = services.newId("sam_") as AgentMessageId;
  const auditStarted = tryDurableAudit(ctx, threadId, runId, "audit.subagent.spawn_started");
  if (auditStarted !== null) {
    return auditStarted;
  }

  // 5. 原子创建 Thread + first Run + task 消息（含 brief/context data parts）
  const contextPacketHash = sha256Hex(stableSerialize(raw.context));
  const capabilitySummary = summarizeEffectiveSnapshot(snapshot);
  let created: { thread: { threadId: SubagentThreadId }; run: { runId: SubagentRunId } } | null = null;
  try {
    created = services.transactions.createThreadWithFirstRun({
      thread: {
        threadId,
        title: raw.brief.title,
        modelProviderId: model.providerId,
        modelId: model.modelId,
        modelSource: model.source,
        thinkingLevel: raw.thinkingLevel ?? "normal",
        workspaceCwd: workspaceCwdOf(ctx),
        capabilityCeiling: capabilitySummary,
        contextPacketHash,
        createdFromTurnId: ctx.turnIdSlot.current ?? null,
      },
      ownership,
      firstRun: { runId, triggerMessageId },
      limits: limits.limits ?? SUBAGENT_RUN_LIMITS_DEFAULTS,
      taskEnvelope: {
        protocol: SUBAGENT_MESSAGE_PROTOCOL,
        version: 1,
        messageId: triggerMessageId,
        contextId: threadId,
        taskId: runId,
        sender: { kind: "parent_agent", id: ctx.ownerAgentId },
        recipient: { kind: "subagent", id: runId },
        messageType: "task",
        deliveryMode: "immediate",
        parts: [
          { kind: "data", schema: "subagent.task_brief.v1", value: raw.brief },
          { kind: "data", schema: "subagent.context_packet.v1", value: raw.context },
        ],
        metadata: { createdAt: now, traceId: `trace-${runId}`, schemaName: "subagent.task" },
      },
      now,
    });
  } catch (error) {
    // domain write 失败（§22.5）：补写 failed terminal audit（best-effort，
    // 无 Run 可挂 auditPending；started 记录仍为证据）
    bestEffortAudit(ctx, threadId, runId, "audit.subagent.spawn_failed");
    return errorResult("subagent_operation_failed", `Thread 创建失败：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
  }

  // 6. 渲染任务 prompt（TaskBrief + ContextPacket）
  const prompt = [renderTaskBrief(raw.brief), renderContextPacket(raw.context)].join("\n\n");

  // 7. 提交执行（容量预检后理论不可拒；拒绝路径可靠补偿，不留无人调度的 Run）
  const executeInput: ExecuteSubagentRunInput = {
    runId,
    threadId,
    ownership,
    snapshotId: services.newId("sas_") as SubagentSnapshotId,
    snapshotJson: stableSerialize(snapshot),
    prompt,
    abilityTools: snapshot.toolIds.map((toolId) => services.toolCatalog(toolId)).filter((def): def is NonNullable<typeof def> => def !== null),
    sessionDir: services.threadDirResolver({ threadId, ownerAgentId: ctx.ownerAgentId }),
    workspaceCwd: workspaceCwdOf(ctx),
    limits: limits.limits ?? SUBAGENT_RUN_LIMITS_DEFAULTS,
    ...(raw.thinkingLevel !== undefined ? { thinkingLevel: raw.thinkingLevel } : {}),
    triggerMessageId,
  };
  const outcome = services.scheduler.submit(executeInput);
  if (outcome.status === "rejected") {
    // 防御补偿（正常路径已被 canAccept 预检排除）：终态化 queued Run + 关闭
    // Thread——不留无人调度的 Run，也不要求主 Agent 手动 close 清理
    compensateSchedulerRejected(ctx, { threadId, runId, ownership, reasonCode: outcome.reasonCode, reason: outcome.reason, now });
    return errorResult(outcome.reasonCode, `${outcome.reason}（已补偿：Run 终态化并关闭 Thread）`);
  }

  // 8. 注册 run-scoped 能力工具执行器（spawn 冻结快照绑定，子会话按 runId 路由）
  registerSubagentAbilityExecutor(runId, executorResult.executor);

  // 9. 投影（thread.created / run.queued；best-effort）
  try {
    if (created !== null) {
      services.projector.projectThreadCreated(created.thread as never, ownership);
      services.projector.projectRunQueued(created.run as never, ownership);
    }
  } catch {
    // best-effort：投影失败不阻断 spawn
  }

  // 10. durable 审计 terminal（复审 P1-1：spawn_completed 失败必须补偿——
  //     Thread 已合法创建，审计证据转入 run.audit_pending_json 由启动恢复补账，
  //     不能静默吞掉）
  terminalAuditOrPending(ctx, threadId, runId, "audit.subagent.spawn_completed");

  return okResult({
    threadId,
    runId,
    model: { providerId: model.providerId, modelId: model.modelId, source: model.source },
    capabilitySummary,
    queued: outcome.status === "accepted" ? outcome.queued : false,
    queuedAt: now,
  });
}

// ── spawn 审计 helpers（§19.3：目录事件名 + assertDurableAudit 语义）──

/**
 * durable 审计（started 类）：rejected/spooled/抛错一律返回稳定错误（fail-closed），
 * 调用方不得继续创建；accepted/accepted-idempotent 返回 null（继续）。
 */
function tryDurableAudit(
  ctx: SubagentToolContext,
  threadId: SubagentThreadId,
  runId: SubagentRunId,
  eventName: string,
): ReturnType<typeof errorResult> | null {
  const services = ctx.services;
  try {
    const result = services.audit(spawnAuditInput(ctx, threadId, runId, eventName));
    if (result.kind !== "accepted" && result.kind !== "accepted-idempotent") {
      return errorResult("subagent_operation_failed", `审计拒绝（${eventName}）：${result.reason.slice(0, 160)}`);
    }
    return null;
  } catch (error) {
    return errorResult("subagent_operation_failed", `审计拒绝（${eventName}）：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
  }
}

/** best-effort 审计（terminal 类）：失败不阻断（Thread 已创建/关闭） */
function bestEffortAudit(ctx: SubagentToolContext, threadId: SubagentThreadId, runId: SubagentRunId, eventName: string): void {
  try {
    void ctx.services.audit(spawnAuditInput(ctx, threadId, runId, eventName));
  } catch {
    // 审计故障不阻断已完成的领域操作
  }
}

/**
 * terminal 审计（复审 P1-1，§19.3）：spawn_completed 是审计生命周期的收尾
 * 证据——rejected/抛错不能静默吞掉。Thread 已合法创建，证据转入
 * run.audit_pending_json（有界 32 条/8KB），由启动恢复第 5 步 replay 补账；
 * 双故障（审计 + auditPending 持久都失败）才放弃（started 记录仍在）。
 */
function terminalAuditOrPending(ctx: SubagentToolContext, threadId: SubagentThreadId, runId: SubagentRunId, eventName: string): void {
  try {
    const result = ctx.services.audit(spawnAuditInput(ctx, threadId, runId, eventName));
    if (result.kind === "accepted" || result.kind === "accepted-idempotent") {
      return;
    }
    throw new Error(`审计拒绝（${eventName}）：${result.reason.slice(0, 160)}`);
  } catch (error) {
    try {
      ctx.services.runs.appendAuditPending(
        runId,
        { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId },
        spawnAuditInput(ctx, threadId, runId, eventName),
      );
    } catch {
      // 双故障：started 审计记录仍为证据，放弃（不阻断 spawn 返回）
    }
  }
}

/**
 * Scheduler 拒绝补偿（复审 P1-2）：正常路径已被 canAccept 预检排除，此处是
 * 防御兜底——把 queued Run 终态化（queued → cancelled，转换表合法）并关闭
 * Thread，不留无人调度的 Run（不再要求主 Agent 手动 close 清理）。
 */
function compensateSchedulerRejected(
  ctx: SubagentToolContext,
  input: {
    readonly threadId: SubagentThreadId;
    readonly runId: SubagentRunId;
    readonly ownership: { readonly ownerAgentId: string; readonly parentSessionId: string };
    readonly reasonCode: string;
    readonly reason: string;
    readonly now: string;
  },
): void {
  const services = ctx.services;
  const { threadId, runId, ownership, reasonCode, now } = input;
  try {
    const messageId = services.newId("sam_") as AgentMessageId;
    services.transactions.completeRunWithResult({
      runId,
      threadId,
      ownership,
      from: "queued",
      to: "cancelled",
      result: null,
      reasonCode: "subagent_scheduler_rejected",
      usage: null,
      resultEnvelope: {
        protocol: SUBAGENT_MESSAGE_PROTOCOL,
        version: 1,
        messageId,
        contextId: threadId,
        taskId: runId,
        sender: { kind: "system", id: "subagent-system" },
        recipient: { kind: "parent_agent", id: ctx.ownerAgentId },
        messageType: "status",
        deliveryMode: "mailbox",
        parts: [{ kind: "text", text: `cancelled（subagent_scheduler_rejected：${input.reason.slice(0, 160)}）` }],
        metadata: { createdAt: now, traceId: `trace-${runId}`, schemaName: "subagent.status" },
      },
      mailbox: {
        mailboxId: services.newId("smb_") as ParentMailboxId,
        messageId,
        notificationKind: "cancelled",
        operationId: `subagent-scheduler-rejected-${runId}`,
        triggerParentTurn: false,
      },
      now,
    });
    services.transactions.closeThread({
      threadId,
      ownership,
      at: now,
      closeReason: "subagent_scheduler_rejected",
      suppressMailboxIds: [],
    });
  } catch {
    // 补偿失败：Run 保持 queued，由启动恢复按 interrupted 终态化兜底
  }
}

function spawnAuditInput(
  ctx: SubagentToolContext,
  threadId: SubagentThreadId,
  runId: SubagentRunId,
  eventName: string,
): import("../observability/audit-recorder.js").AuditRecordInput {
  return {
    eventName,
    payload: { action: "spawn_subagent", decision: "allowed", policyVersion: "subagents.v1" },
    actor: { kind: "agent", id: ctx.ownerAgentId },
    executor: { kind: "agent", id: ctx.ownerAgentId },
    target: { kind: "subagent_thread", id: threadId },
    scope: {
      ...(ctx.ownerAgentId !== undefined ? { ownerAgentId: ctx.ownerAgentId } : {}),
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.turnIdSlot.current !== undefined ? { turnId: ctx.turnIdSlot.current } : {}),
      subagentThreadId: threadId,
      subagentRunId: runId,
    },
    ...(ctx.traceSlot.current !== undefined ? { trace: ctx.traceSlot.current } : {}),
  };
}

// ── 其他工具实现 ────────────────────────────────────────────────

function getSubagentStatus(ctx: SubagentToolContext, threadId: SubagentThreadId | undefined): ReturnType<typeof textResult> {
  const services = ctx.services;
  const ownership = { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId };
  if (threadId !== undefined) {
    const thread = services.threads.get(threadId, ownership);
    if (thread === null) {
      return errorResult("subagent_not_found", `Thread ${threadId} 不存在或不属于当前会话`);
    }
    return okResult({ threads: [threadSummary(services, thread, ownership)] });
  }
  const threads = services.threads.listByOwner(ownership, 100)
    .sort((a, b) => (a.status === "open" ? -1 : 1) - (b.status === "open" ? -1 : 1))
    .slice(0, 20);
  return okResult({ threads: threads.map((thread) => threadSummary(services, thread, ownership)) });
}

function threadSummary(
  services: SubagentToolContext["services"],
  thread: { threadId: SubagentThreadId; title: string; status: string; modelProviderId: string; modelId: string; capabilityCeiling: unknown; updatedAt: string; createdAt: string },
  ownership: { ownerAgentId: string; parentSessionId: string },
): Record<string, unknown> {
  const runs = services.runs.listByThread(thread.threadId, ownership);
  const currentRun = runs[runs.length - 1] ?? null;
  const mailbox = services.mailbox.listByThread(thread.threadId, ownership);
  const pendingMailbox = mailbox.filter((row) => row.status !== "delivered" && row.status !== "suppressed");
  const ceiling = thread.capabilityCeiling as { ceilingHash?: string; workspaceAccess?: string; toolIds?: readonly string[] };
  return {
    threadId: thread.threadId,
    title: thread.title,
    status: thread.status,
    model: `${thread.modelProviderId}/${thread.modelId}`,
    currentRun: currentRun === null ? null : {
      runId: currentRun.runId,
      ordinal: currentRun.ordinal,
      status: currentRun.status,
      reasonCode: currentRun.reasonCode,
      currentPhase: currentRun.currentPhase,
      currentTool: currentRun.currentTool,
      iterationCount: currentRun.iterationCount,
      toolCallCount: currentRun.toolCallCount,
      usage: { inputTokens: currentRun.inputTokens, outputTokens: currentRun.outputTokens, totalTokens: currentRun.totalTokens },
      lastActivityAt: currentRun.lastActivityAt,
      startedAt: currentRun.startedAt,
      finishedAt: currentRun.finishedAt,
      result: currentRun.result,
    },
    runCount: runs.length,
    mailbox: {
      pending: pendingMailbox.length,
      latest: pendingMailbox[pendingMailbox.length - 1]?.notificationKind ?? null,
    },
    capability: {
      ceilingHash: ceiling.ceilingHash,
      workspaceAccess: ceiling.workspaceAccess,
      toolCount: ceiling.toolIds?.length ?? 0,
    },
    updatedAt: thread.updatedAt,
  };
}

function inspectSubagent(
  ctx: SubagentToolContext,
  raw: { threadId: SubagentThreadId; runId?: SubagentRunId; afterSequence?: number; limit?: number; include: readonly string[] },
): ReturnType<typeof textResult> {
  const services = ctx.services;
  const ownership = { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId };
  const threadId = raw.threadId;
  const thread = services.threads.get(threadId, ownership);
  if (thread === null) {
    return errorResult("subagent_not_found", `Thread ${threadId} 不存在或不属于当前会话`);
  }
  const output: Record<string, unknown> = {};
  if (raw.include.includes("messages")) {
    const page = services.transcriptView.listMessages(threadId, ownership, {
      ...(raw.afterSequence !== undefined ? { afterSequence: raw.afterSequence } : {}),
      ...(raw.limit !== undefined ? { limit: raw.limit } : {}),
    });
    output.messages = page.items;
    output.nextMessageSequence = page.nextSequence;
  }
  if (raw.include.includes("steers")) {
    const page = services.transcriptView.listMessages(threadId, ownership, { limit: 100 });
    output.steers = page.items
      .filter((message) => message.messageType === "steer")
      .map((message) => ({
        messageId: message.messageId,
        sequence: message.sequence,
        createdAt: message.createdAt,
        parts: message.parts,
      }));
  }
  if (raw.include.includes("tools")) {
    output.tools = services.toolTracker.listRecent(threadId, raw.limit ?? 50);
  }
  if (raw.include.includes("artifacts")) {
    output.artifacts = services.artifactFiles.listByThread(threadId, ownership);
  }
  if (raw.include.includes("result")) {
    const run = raw.runId !== undefined
      ? services.runs.get(raw.runId, ownership)
      : services.runs.listByThread(threadId, ownership).at(-1) ?? null;
    output.result = run?.result ?? null;
    output.runStatus = run?.status ?? null;
  }
  return okResult({ threadId, ...output });
}

function steerSubagent(ctx: SubagentToolContext, steer: SubagentSteerV1): ReturnType<typeof textResult> {
  const services = ctx.services;
  const ownership = { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId };
  const runId = steer.targetRunId;
  const run = services.runs.get(runId, ownership);
  if (run === null) {
    return errorResult("subagent_not_found", `Run ${runId} 不存在或不属于当前会话`);
  }
  const thread = services.threads.get(run.threadId, ownership);
  if (thread === null) {
    return errorResult("subagent_not_found", `Thread ${run.threadId} 不存在`);
  }

  // stop 动作 → cancel 路径（§13.4：stop 不作为普通 Prompt）
  if (steer.action === "stop") {
    return cancelSubagent(ctx, { threadId: run.threadId, runId, reason: steer.instruction.slice(0, 500) });
  }

  const now = new Date(services.now()).toISOString();
  const messageId = services.newId("sam_") as AgentMessageId;
  const parts = [
    { kind: "data" as const, schema: "subagent.steer.v1", value: steer },
    { kind: "text" as const, text: renderSteer(steer) },
  ];
  const envelope: Omit<AgentMessageEnvelopeV1, "sequence"> = {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId,
    contextId: run.threadId,
    taskId: runId,
    sender: { kind: "parent_agent", id: ctx.ownerAgentId },
    recipient: { kind: "subagent", id: runId },
    messageType: "steer",
    deliveryMode: steer.deliveryMode,
    parts,
    metadata: { createdAt: now, traceId: `trace-${runId}`, schemaName: "subagent.steer" },
  };
  const appended = services.messages.append({ envelope, ownership, createdAt: now }).message;

  // 活动 Run：投递给 Runtime（queue→followUp / interrupt→steer / 延迟重试）
  if (!isSubagentRunTerminal(run.status)) {
    services.dispatcher.dispatch(messageId, ownership);
    return okResult({ messageId, delivery: steer.deliveryMode, targetRunId: runId, newRunId: null });
  }

  // 终态 Run + open Thread：创建下一 Run，纠偏作为新输入（§9.3）
  if (thread.status !== "open") {
    return errorResult("subagent_thread_state_conflict", `Thread ${run.threadId} 状态 ${thread.status}，不能创建新 Run`);
  }
  // 容量预检（复审 P1-2）：领域写入前拒绝
  if (!services.scheduler.canAccept()) {
    return errorResult("subagent_runtime_unavailable", "Subagent 运行时排队积压超过上限，请稍后重试");
  }
  const newRunId = services.newId("sar_") as SubagentRunId;
  // 复审 P0-2（§12.6）：下一 Run 重新冻结快照——当前父能力 ∩ Thread ceiling
  // （ceiling 从 Thread 冻结摘要保守重建：新 Run 不超过 Thread 已观测的有效
  // 能力边界，权限只会缩小），插件执行快照与 Skill contentHash 全部现场
  // 重新冻结，变化必须产生新 snapshotId，不复用旧 Run 的冻结状态
  const parent = services.parentSnapshot();
  const nextSnapshot = computeEffectiveSnapshot({
    parentToolIds: parent.toolIds,
    parentPluginContributions: parent.pluginContributions,
    parentSkillEntries: parent.skillEntries,
    ceiling: rebuildCeilingFromSummary(thread.capabilityCeiling as SubagentCapabilitySummary),
  });
  const executorResult = services.createRunToolExecutor({
    runId: newRunId,
    snapshot: nextSnapshot,
    spawnTurnId: ctx.turnIdSlot.current ?? null,
  });
  if (!executorResult.ok) {
    return errorResult("subagent_operation_failed", executorResult.reason);
  }
  const newSnapshotId = services.newId("sas_") as SubagentSnapshotId;
  try {
    services.runs.create(
      { runId: newRunId, threadId: run.threadId, triggerMessageId: messageId, limits: run.limits, createdAt: now },
      ownership,
    );
  } catch (error) {
    return errorResult("subagent_run_state_conflict", `创建新 Run 失败：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
  }
  const executeInput: ExecuteSubagentRunInput = {
    runId: newRunId,
    threadId: run.threadId,
    ownership,
    snapshotId: newSnapshotId,
    snapshotJson: stableSerialize(nextSnapshot),
    prompt: renderSteer(steer),
    abilityTools: nextSnapshot.toolIds.map((toolId) => services.toolCatalog(toolId)).filter((def): def is NonNullable<typeof def> => def !== null),
    sessionDir: services.threadDirResolver({ threadId: run.threadId, ownerAgentId: ctx.ownerAgentId }),
    workspaceCwd: workspaceCwdOf(ctx),
    limits: run.limits,
    triggerMessageId: messageId,
  };
  const outcome = services.scheduler.submit(executeInput);
  if (outcome.status === "rejected") {
    // 防御补偿（预检后理论不可拒）：终态化新 Run（queued → cancelled），
    // Thread 保持 open（steer 消息仍在，父 Agent 可重试）
    compensateSchedulerRejected(ctx, {
      threadId: run.threadId,
      runId: newRunId,
      ownership,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      now,
    });
    return errorResult(outcome.reasonCode, `${outcome.reason}（已补偿：新 Run 终态化）`);
  }
  // 注册 run-scoped 能力工具执行器（复审 P0-2：新 Run 绑定自身冻结快照）
  registerSubagentAbilityExecutor(newRunId, executorResult.executor);
  services.dispatcher.dispatch(messageId, ownership); // task/steer 记账（新 Run 已由 Host 渲染 trigger）
  return okResult({ messageId, delivery: "queued", targetRunId: runId, newRunId, queued: outcome.queued });
}

async function waitSubagent(
  ctx: SubagentToolContext,
  raw: { threadIds: readonly SubagentThreadId[]; timeoutMs?: number; afterSequenceByThread?: Record<string, number> },
  signal?: AbortSignal,
): Promise<ReturnType<typeof textResult>> {
  const services = ctx.services;
  const ownership = { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId };
  const timeoutMs = raw.timeoutMs ?? 30_000;
  const deadline = services.now() + timeoutMs;

  const snapshot = (): Record<string, unknown> => {
    const threads: Record<string, unknown> = {};
    for (const threadId of raw.threadIds) {
      const thread = services.threads.get(threadId, ownership);
      if (thread === null) {
        threads[threadId] = { error: "subagent_not_found" };
        continue;
      }
      const runs = services.runs.listByThread(threadId, ownership);
      const run = runs.at(-1) ?? null;
      const since = raw.afterSequenceByThread?.[threadId] ?? 0;
      const page = services.transcriptView.listMessages(threadId, ownership, { afterSequence: since, limit: 100 });
      threads[threadId] = {
        threadId,
        threadStatus: thread.status,
        runId: run?.runId ?? null,
        runStatus: run?.status ?? null,
        reasonCode: run?.reasonCode ?? null,
        newMessageCount: page.items.length,
        nextSequence: page.nextSequence,
        waitingForInput: run?.status === "waiting_for_input",
      };
    }
    return threads;
  };

  const allTerminalOrWaiting = (threads: Record<string, unknown>): boolean =>
    Object.values(threads).every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as { runStatus?: string | null; waitingForInput?: boolean; error?: string };
      return e.error !== undefined || e.waitingForInput === true || (e.runStatus !== null && e.runStatus !== undefined && isSubagentRunTerminal(e.runStatus as SubagentRunStatus));
    });

  // 先查一次：已有关键状态 → 立即返回
  const first = snapshot();
  if (allTerminalOrWaiting(first)) {
    return okResult({ status: "ok", threads: first });
  }
  // 等待新 mailbox 通知（signal 唤醒/超时/abort）；随后重查
  try {
    await services.coordinator.waitForNotifications(ownership, {
      after: null,
      limit: 1,
      timeoutMs: Math.max(1, deadline - services.now()),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch {
    // abort / 超时：返回当前快照（timeout 不视为错误）
  }
  const second = snapshot();
  const timedOut = services.now() >= deadline;
  return textResult(JSON.stringify({ status: allTerminalOrWaiting(second) ? "ok" : timedOut ? "timeout" : "ok", threads: second }));
}

function cancelSubagent(
  ctx: SubagentToolContext,
  raw: { threadId: SubagentThreadId; runId?: SubagentRunId; reason: string },
): ReturnType<typeof textResult> {
  const services = ctx.services;
  const ownership = { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId };
  const run = raw.runId !== undefined
    ? services.runs.get(raw.runId, ownership)
    : services.runs.listByThread(raw.threadId, ownership).at(-1) ?? null;
  if (run === null) {
    return errorResult("subagent_not_found", `Run 不存在或不属于当前会话`);
  }
  if (isSubagentRunTerminal(run.status)) {
    // 幂等：已终态返回已有状态
    return okResult({ runId: run.runId, status: run.status, reasonCode: run.reasonCode, alreadyTerminal: true });
  }
  const now = new Date(services.now()).toISOString();
  const messageId = services.newId("sam_") as AgentMessageId;
  const envelope: Omit<AgentMessageEnvelopeV1, "sequence"> = {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId,
    contextId: run.threadId,
    taskId: run.runId,
    sender: { kind: "parent_agent", id: ctx.ownerAgentId },
    recipient: { kind: "subagent", id: run.runId },
    messageType: "cancel",
    deliveryMode: "interrupt",
    parts: [{ kind: "text", text: `cancel: ${raw.reason}` }],
    metadata: { createdAt: now, traceId: `trace-${run.runId}`, schemaName: "subagent.cancel" },
  };
  const appended = services.messages.append({ envelope, ownership, createdAt: now }).message;
  services.dispatcher.dispatch(messageId, ownership);
  return okResult({ runId: run.runId, runStatus: "cancelling", messageId: appended.messageId });
}

function closeSubagent(ctx: SubagentToolContext, threadId: SubagentThreadId): ReturnType<typeof textResult> {
  const services = ctx.services;
  const ownership = { ownerAgentId: ctx.ownerAgentId, parentSessionId: ctx.sessionId };
  const thread = services.threads.get(threadId, ownership);
  if (thread === null) {
    return errorResult("subagent_not_found", `Thread ${threadId} 不存在或不属于当前会话`);
  }
  if (thread.status === "closed") {
    return okResult({ threadId, threadStatus: "closed", closedNow: false, idempotent: true });
  }
  const activeRun = services.runs.getActiveRunByThread(threadId, ownership);
  if (activeRun !== null) {
    // 有活动 Run：先取消（cancel 消息 + dispatch）
    cancelSubagent(ctx, { threadId, runId: activeRun.runId, reason: "close_subagent: 关闭 Thread 前取消活动 Run" });
  }
  const outcome = services.transactions.closeThread({
    threadId,
    ownership,
    at: new Date(services.now()).toISOString(),
    closeReason: "close_subagent",
    suppressMailboxIds: [],
  });
  // §19.3：close 正常路径投影 thread.closed（activity + auditMirror
  // audit.subagent.close_completed；best-effort，Recorder 故障不阻断关闭）
  try {
    services.projector.projectThreadClosed(outcome.thread as never, ownership);
  } catch {
    // 投影失败不阻断 close（证据可由恢复器补账路径兜底）
  }
  return okResult({ threadId, threadStatus: outcome.thread.status, closedNow: outcome.closedNow, suppressed: outcome.suppressed });
}

// ── helpers ─────────────────────────────────────────────────────

function workspaceCwdOf(ctx: SubagentToolContext): string {
  return ctx.services.workspaceCwd();
}

/**
 * 复审 P0-2（§12.6）：从 Thread 冻结的 CapabilitySummary 保守重建 ceiling。
 * summary 只保留"创建时刻的有效交集"，不含原始 mode 与 allowlist——重建为
 * allowlist（新 Run 不超过 Thread 已观测的有效能力边界，权限只会缩小，
 * §10.10）；Skill 的 contentHash 由 parentSnapshot 现场重新解析（变化必须
 * 产生新 snapshotId）。插件 pluginIds 从贡献限定名（pluginId.toolId）前缀
 * 还原，只用于贡献级交集判断。
 */
function rebuildCeilingFromSummary(summary: SubagentCapabilitySummary): NormalizedCapabilityCeiling {
  return {
    tools: { mode: "allowlist", ids: [...summary.toolIds] },
    plugins: {
      mode: "allowlist",
      pluginIds: [...new Set(summary.pluginContributionIds.map((id) => id.split(".")[0] ?? id))],
      contributionIds: [...summary.pluginContributionIds],
    },
    skills: { mode: "allowlist", refs: [...summary.skillRefs] },
    workspaceAccess: summary.workspaceAccess,
    network: summary.network,
  };
}
