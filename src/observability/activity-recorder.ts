import crypto from "node:crypto";
import type Database from "better-sqlite3";
import Value from "typebox/value";
import {
  ActivityEnvelopeSchema,
  type ActivityEnvelope,
  type ActivityPayload,
  type ActorRef,
  type EventScope,
  type ExecutorRef,
  type ProducerContext,
  type ResourceRef,
  type TraceContext,
  ACTIVITY_TERMINAL_STATUSES,
} from "../contracts/observability.js";
import { getCatalogEntry } from "./event-catalog.js";
import { normalizeSafeObject } from "./safe-value.js";
import { currentTrace } from "./trace-context.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 ActivityRecorder（plans/phase-11.md §五.2 / §5.5）
//
// - 目录驱动：eventName+eventVersion 查目录，未注册拒绝；
//   channel/defaultLevel/significance 由目录固定，调用方不可覆盖；
// - durable-on-accept：SQLite 事务成功才返回 accepted；SQLite 失败 → durable spool，
//   两者都失败返回 rejected（不静默成功）；
// - eventId UNIQUE 幂等：重放/重复提交返回 accepted(idempotent)；
// - 唯一终态：同 operationId 只能有一个 started 与一个终态（DB 校验）；
// - 目录 auditMirror：同事务写入 audit_events（责任证据与时间线同库）；
// - reconcileRunning：启动恢复把旧 bootId 遗留 running/processing 补为 interrupted。
// ═══════════════════════════════════════════════════════════════

export interface ActivityRecordInput {
  eventName: string;
  eventVersion?: number;
  payload: ActivityPayload;
  actor: ActorRef;
  executor: ExecutorRef;
  target?: ResourceRef;
  scope?: EventScope;
  trace?: TraceContext;
  operationId?: string;
  status?: ActivityEnvelope["status"];
  significance?: never; // 目录固定，调用方不可指定
  level?: never;
  channel?: never;
}

export type ActivityAcceptResult =
  | { kind: "accepted"; eventId: string; rowId: number }
  | { kind: "accepted-idempotent"; eventId: string }
  | { kind: "rejected"; eventName: string; reason: string }
  | { kind: "spooled"; eventId: string; reason: string };

export interface ActivityRecorderDeps {
  database: Database.Database;
  producer: ProducerContext;
  /** SQLite 写失败时的应急落盘（按进程隔离，同步写保证成败立即可知）；缺省则直接 rejected */
  spool?: { write(channel: "activity", envelope: ActivityEnvelope): { ok: boolean; error?: string } };
  now?: () => Date;
}

interface ActivityRow {
  id: number;
  event_id: string;
  operation_id: string | null;
  status: string | null;
  event_name: string;
  payload_json: string;
}

export class ActivityRecorder {
  private readonly now: () => Date;
  private spool: ActivityRecorderDeps["spool"];

  constructor(private readonly deps: ActivityRecorderDeps) {
    this.now = deps.now ?? (() => new Date());
    this.spool = deps.spool;
  }

  /** durable-on-accept 提交一条活动事件 */
  append(input: ActivityRecordInput): ActivityAcceptResult {
    const entry = getCatalogEntry(input.eventName, input.eventVersion);
    if (entry === undefined) {
      return { kind: "rejected", eventName: input.eventName, reason: "事件未注册或版本不符" };
    }
    if (entry.channel !== "activity") {
      return { kind: "rejected", eventName: input.eventName, reason: "事件属于 audit 通道" };
    }
    // 评审 P1-9：payload 必须符合目录固定的 schema（不能靠通用 Envelope 蒙混）
    if (!Value.Check(entry.payloadSchema, input.payload)) {
      return { kind: "rejected", eventName: input.eventName, reason: "payload 不符合目录 schema" };
    }
    // 评审 P1-9：status 必须符合目录 lifecycleRole/terminalStatuses
    // （system.started + status=denied 之类的组合一律拒绝）。
    // started 角色事件可自带终态（startOperation 复用事件名）或 processing。
    const statusIssue = this.validateLifecycleStatus(entry, input.status);
    if (statusIssue !== null) {
      return { kind: "rejected", eventName: input.eventName, reason: statusIssue };
    }
    // 唯一终态校验（同 operationId 已有终态 → 拒绝/幂等）
    if (input.operationId !== undefined && input.status !== undefined) {
      const terminal = ACTIVITY_TERMINAL_STATUSES as readonly string[];
      if (terminal.includes(input.status)) {
        const existing = this.findTerminal(input.operationId);
        if (existing !== null) {
          return { kind: "accepted-idempotent", eventId: existing.event_id };
        }
      }
    }
    // 评审 P1-9：同 operationId 未收尾前不允许重复 started（重试需先有终态）。
    // DB 不可用时跳过预检——真正的 insert 失败会走 spool/rejected 矩阵
    if (entry.lifecycleRole === "started" && input.status === "started" && input.operationId !== undefined) {
      const open = this.findOpenStartedSafe(input.operationId);
      if (open !== null) {
        return { kind: "rejected", eventName: input.eventName, reason: "同一 operationId 已有未收尾的 started 记录" };
      }
    }

    const trace = input.trace ?? currentTrace() ?? { traceId: "no-trace", spanId: "no-span" };
    const nowIso = this.now().toISOString();
    const eventId = crypto.randomUUID();
    const payload = normalizeSafeObject(input.payload).value as unknown as ActivityPayload;
    const envelope: ActivityEnvelope = {
      schemaVersion: 1,
      eventVersion: entry.eventVersion,
      eventId,
      eventName: entry.eventName,
      occurredAt: nowIso,
      recordedAt: nowIso,
      level: entry.defaultLevel,
      actor: input.actor,
      executor: input.executor,
      ...(input.target !== undefined ? { target: input.target } : {}),
      scope: input.scope ?? {},
      trace,
      producer: this.deps.producer,
      channel: "activity",
      ...(input.status !== undefined ? { status: input.status } : {}),
      significance: entry.significance,
      payload,
    };
    if (!Value.Check(ActivityEnvelopeSchema, envelope)) {
      return { kind: "rejected", eventName: input.eventName, reason: "Envelope 校验失败" };
    }

    // 平台权威字段与 search_text（FTS 只索引 eventName/category/errorCode/summaryCode，不含 payload 正文）
    const searchText = this.buildSearchText(entry.eventName, entry.category, payload, input.scope);

    try {
      // insert + audit 镜像同一事务：活动行存在则镜像必然存在（durable-on-accept 原子性）
      const rowId = this.deps.database.transaction(() => {
        const id = this.insert(envelope, entry.category, input.operationId ?? envelope.trace.operationId ?? null, input.scope ?? {}, searchText);
        if (entry.auditMirror !== undefined) {
          this.insertAuditMirror(envelope, entry.auditMirror, input.scope ?? {});
        }
        return id;
      })();
      return { kind: "accepted", eventId, rowId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.spool !== undefined) {
        const spoolResult = this.spool.write("activity", envelope);
        if (!spoolResult.ok) {
          this.spool = undefined; // 双失败：fail closed，不伪装成功
          return { kind: "rejected", eventName: input.eventName, reason: spoolResult.error ?? "spool 写入失败" };
        }
        return { kind: "spooled", eventId, reason };
      }
      return { kind: "rejected", eventName: input.eventName, reason };
    }
  }

  /** 评审 P1-9：status 是否符合目录 lifecycleRole/terminalStatuses；null = 合法 */
  private validateLifecycleStatus(
    entry: import("../contracts/observability.js").EventCatalogEntry,
    status: ActivityEnvelope["status"] | undefined,
  ): string | null {
    const role = entry.lifecycleRole;
    if (role === "started") {
      const allowed = ["started", "processing", ...(entry.terminalStatuses ?? [])];
      if (status === undefined || !allowed.includes(status)) {
        return `started 事件 status 必须是 ${allowed.join("/")} 之一`;
      }
    } else if (role === "terminal") {
      const allowed = entry.terminalStatuses ?? [];
      if (status === undefined || !allowed.includes(status)) {
        return `终态事件 status 必须是 ${allowed.join("/")} 之一`;
      }
    } else if (status !== undefined) {
      // point/progress：无生命周期状态
      return "point/progress 事件不允许带 status";
    }
    return null;
  }

  /** 应急导入：spool 行幂等写入 SQLite（eventId UNIQUE）；坏行/未知事件 quarantine */
  importEnvelope(line: unknown): { ok: boolean; error?: string } {
    if (!Value.Check(ActivityEnvelopeSchema, line)) return { ok: false, error: "quarantine" };
    const envelope = line as unknown as ActivityEnvelope;
    const entry = getCatalogEntry(envelope.eventName, envelope.eventVersion);
    if (entry === undefined || entry.channel !== "activity") return { ok: false, error: "quarantine" };
    // 评审 P1（第三轮）：导入重新执行目录约束——被篡改/损坏的 spool 行
    // 不得绕过生命周期校验、payload schema 或伪造 significance
    if (!Value.Check(entry.payloadSchema, envelope.payload)) return { ok: false, error: "quarantine" };
    if (this.validateLifecycleStatus(entry, envelope.status) !== null) return { ok: false, error: "quarantine" };
    if (envelope.significance !== undefined && envelope.significance !== entry.significance) {
      return { ok: false, error: "quarantine" };
    }
    try {
      // spool 行可能缺 significance（schema 可选，DB 列 NOT NULL，INSERT OR IGNORE 会静默丢弃）：以目录为准补全
      const normalized: ActivityEnvelope = envelope.significance === undefined
        ? { ...envelope, significance: entry.significance }
        : envelope;
      this.deps.database.transaction(() => {
        this.insert(
          normalized,
          entry.category,
          envelope.trace.operationId ?? null,
          envelope.scope,
          this.buildSearchText(entry.eventName, entry.category, envelope.payload, envelope.scope),
        );
        if (entry.auditMirror !== undefined) {
          this.insertAuditMirror(normalized, entry.auditMirror, envelope.scope);
        }
      })();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "import failed" };
    }
  }

  private buildSearchText(eventName: string, category: string, payload: ActivityPayload, scope?: { pluginId?: string }): string {
    return [
      eventName,
      category,
      typeof payload.summaryCode === "string" ? payload.summaryCode : "",
      // P1-3：插件 id 进 search_text（/logs 全文搜索可命中普通插件事件）
      ...(scope?.pluginId !== undefined ? [scope.pluginId] : []),
    ].filter(Boolean).join(" ");
  }

  /** 启动恢复：把旧 bootId 遗留 running/processing 的 started 补为 interrupted */
  reconcileRunning(bootId: string, olderThanIso: string): number {
    const result = this.deps.database
      .prepare(
        `UPDATE activity_events SET status = 'interrupted', recorded_at = ?, payload_json = json_set(payload_json, '$.summaryCode', 'interrupted_by_restart')
         WHERE boot_id = ? AND status IN ('started', 'processing') AND recorded_at < ?`,
      )
      .run(this.now().toISOString(), bootId, olderThanIso);
    return result.changes;
  }

  private findTerminal(operationId: string): { event_id: string } | null {
    return (this.deps.database
      .prepare(
        `SELECT event_id FROM activity_events
         WHERE operation_id = ? AND status IN (${ACTIVITY_TERMINAL_STATUSES.map(() => "?").join(",")})
         LIMIT 1`,
      )
      .get(operationId, ...ACTIVITY_TERMINAL_STATUSES) as { event_id: string } | undefined) ?? null;
  }

  /**
   * 同 operationId 是否存在"未收尾"的 started（评审 P1-9：重复 started 拒绝；
   * 已存在终态的操作允许重试——如调度失败后 nextRetryAt 重跑）。
   */
  private findOpenStartedSafe(operationId: string): { event_id: string } | null {
    try {
      return (this.deps.database
        .prepare(
          `SELECT event_id FROM activity_events
           WHERE operation_id = ? AND status IN ('started', 'processing')
             AND NOT EXISTS (
               SELECT 1 FROM activity_events t
               WHERE t.operation_id = activity_events.operation_id
                 AND t.status IN (${ACTIVITY_TERMINAL_STATUSES.map(() => "?").join(",")})
             )
           ORDER BY id DESC LIMIT 1`,
        )
        .get(operationId, ...ACTIVITY_TERMINAL_STATUSES) as { event_id: string } | undefined) ?? null;
    } catch {
      return null; // DB 不可用：交给 insert 的 spool/rejected 矩阵处理
    }
  }

  private insert(
    envelope: ActivityEnvelope,
    category: string,
    operationId: string | null,
    scope: EventScope,
    searchText: string,
  ): number {
    const result = this.deps.database
      .prepare(
        `INSERT OR IGNORE INTO activity_events
          (event_id, schema_version, event_version, recorded_at, occurred_at, event_name, category,
           level, status, significance, actor_kind, actor_id, executor_kind, executor_id,
           target_kind, target_id, owner_agent_id, session_id, run_id, turn_id, task_id,
           subagent_run_id, tool_call_id, plugin_id, trace_id, span_id, parent_span_id,
           operation_id, correlation_id, duration_ms, error_code, retryable,
           producer_component, producer_process_type, boot_id, search_text, payload_json)
         VALUES (
           @eventId, @schemaVersion, @eventVersion, @recordedAt, @occurredAt, @eventName, @category,
           @level, @status, @significance, @actorKind, @actorId, @executorKind, @executorId,
           @targetKind, @targetId, @ownerAgentId, @sessionId, @runId, @turnId, @taskId,
           @subagentRunId, @toolCallId, @pluginId, @traceId, @spanId, @parentSpanId,
           @operationId, @correlationId, @durationMs, @errorCode, @retryable,
           @producerComponent, @producerProcessType, @bootId, @searchText, @payloadJson
         )`,
      )
      .run({
        eventId: envelope.eventId,
        schemaVersion: 1,
        eventVersion: envelope.eventVersion,
        recordedAt: envelope.recordedAt,
        occurredAt: envelope.occurredAt,
        eventName: envelope.eventName,
        category,
        level: envelope.level,
        status: envelope.status ?? null,
        significance: envelope.significance ?? null,
        actorKind: envelope.actor.kind,
        actorId: envelope.actor.id,
        executorKind: envelope.executor.kind,
        executorId: envelope.executor.id,
        targetKind: envelope.target?.kind ?? null,
        targetId: envelope.target?.id ?? null,
        ownerAgentId: scope.ownerAgentId ?? null,
        sessionId: scope.sessionId ?? null,
        runId: scope.runId ?? null,
        turnId: scope.turnId ?? null,
        taskId: scope.taskId ?? null,
        subagentRunId: scope.subagentRunId ?? null,
        toolCallId: scope.toolCallId ?? null,
        pluginId: scope.pluginId ?? null,
        traceId: envelope.trace.traceId,
        spanId: envelope.trace.spanId,
        parentSpanId: envelope.trace.parentSpanId ?? null,
        operationId,
        correlationId: envelope.trace.correlationId ?? null,
        durationMs: envelope.payload.durationMs ?? null,
        errorCode: typeof envelope.payload.attributes?.["errorCode"] === "string" ? envelope.payload.attributes["errorCode"] : null,
        retryable: envelope.payload.attributes?.["retryable"] === true ? 1 : 0,
        producerComponent: envelope.producer.component,
        producerProcessType: envelope.producer.processType,
        bootId: envelope.producer.bootId,
        searchText,
        payloadJson: JSON.stringify(envelope.payload),
      });
    if (result.changes === 0) {
      // eventId 冲突 → 幂等
      const existing = this.deps.database
        .prepare("SELECT id FROM activity_events WHERE event_id = ?")
        .get(envelope.eventId) as { id: number } | undefined;
      if (existing === undefined) throw new Error("活动写入失败（未知冲突）");
      return existing.id;
    }
    const row = this.deps.database
      .prepare("SELECT id FROM activity_events WHERE event_id = ?")
      .get(envelope.eventId) as { id: number };
    return row.id;
  }

  /** audit 镜像：action=auditMirror 事件名（摘要化），不含 payload 正文；
   *  event_name 同步落 mirror 事件名；decision 按事件名推导
   *  （含 denied/revoked → 'denied'，否则 'allowed'） */
  private insertAuditMirror(envelope: ActivityEnvelope, mirrorEventName: string, scope: EventScope): void {
    const decision = mirrorEventName.includes("denied") || mirrorEventName.includes("revoked") ? "denied" : "allowed";
    this.deps.database
      .prepare(
        `INSERT OR IGNORE INTO audit_events
          (event_id, ledger_epoch, schema_version, event_version, recorded_at, occurred_at,
           action, decision, event_name, actor_kind, actor_id, executor_kind, executor_id,
           target_kind, target_id, owner_agent_id, session_id, trace_id, operation_id,
           policy_version, payload_json)
         VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `mirror:${envelope.eventId}`,
        this.ledgerEpoch(),
        envelope.recordedAt,
        envelope.occurredAt,
        mirrorEventName,
        decision,
        mirrorEventName,
        envelope.actor.kind,
        envelope.actor.id,
        envelope.executor.kind,
        envelope.executor.id,
        envelope.target?.kind ?? null,
        envelope.target?.id ?? null,
        scope.ownerAgentId ?? null,
        scope.sessionId ?? null,
        envelope.trace.traceId,
        scope.runId ?? null,
        "1",
        JSON.stringify({ summaryCode: envelope.payload.summaryCode }),
      );
  }

  private ledgerEpoch(): number {
    const row = this.deps.database
      .prepare("SELECT value FROM observability_state WHERE key = 'audit.ledger_epoch'")
      .get() as { value: string } | undefined;
    return row !== undefined ? Number(row.value) : 1;
  }
}
