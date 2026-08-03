import crypto from "node:crypto";
import type Database from "better-sqlite3";
import Value from "typebox/value";
import {
  AuditEnvelopeSchema,
  type ActorRef,
  type AuditEnvelope,
  type AuditPayload,
  type EventScope,
  type ExecutorRef,
  type ProducerContext,
  type ResourceRef,
  type TraceContext,
} from "../contracts/observability.js";
import { getCatalogEntry } from "./event-catalog.js";
import { normalizeSafeObject } from "./safe-value.js";
import { currentTrace } from "./trace-context.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 AuditRecorder（plans/phase-11.md §5.3 / §5.6）
//
// - 独立 append-only Store：只暴露 append/get/list/resetLedger，无单行 update/delete；
// - ledger_epoch 普通路径 append-only；显式 resetLedger 单事务递增 epoch、
//   清理旧 epoch 并留下新 epoch 的 audit.observability.ledger_reset 记录；
// - previousHash/recordHash 固定 NULL（v1 预留，不实现防篡改校验链）；
// - 同库高风险修改：runAuditedTransaction 保证领域修改与 Audit 同一事务，
//   事务失败即拒绝操作（内部走 appendStrict，绝不 spool 脱离事务）；
// - 独立 append 的 SQLite 失败可落应急 spool；spool 也失败 → rejected（fail closed）。
// ═══════════════════════════════════════════════════════════════

export interface AuditRecordInput {
  eventName: string;
  payload: AuditPayload;
  actor: ActorRef;
  executor?: ExecutorRef;
  target?: ResourceRef;
  scope?: EventScope;
  trace?: TraceContext;
}

export type AuditAcceptResult =
  | { kind: "accepted"; eventId: string; rowId: number }
  | { kind: "accepted-idempotent"; eventId: string }
  | { kind: "rejected"; eventName: string; reason: string }
  | { kind: "spooled"; eventId: string; reason: string };

/**
 * 评审 P0（第三轮）：统一 durable audit 断言——只接受 accepted / accepted-idempotent，
 * 其余结果（rejected/spooled）一律抛错；调用方 catch 后回滚领域修改并拒绝操作。
 * appendStrict 不会走 spool，故此处 spooled 也按失败处理（防御性）。
 */
export function assertDurableAudit(result: AuditAcceptResult, context: string): AuditAcceptResult {
  if (result.kind !== "accepted" && result.kind !== "accepted-idempotent") {
    throw new Error(`${context}：审计记录未被接受（${result.kind === "rejected" ? result.reason : "spooled"}）`);
  }
  return result;
}

export interface AuditRecorderDeps {
  database: Database.Database;
  producer: ProducerContext;
  /** SQLite 写失败时的应急落盘（按进程隔离，同步写保证成败立即可知）；缺省则直接 rejected */
  spool?: { write(channel: "audit", envelope: AuditEnvelope): { ok: boolean; error?: string } };
  now?: () => Date;
}

interface AuditLifecycleRow {
  readonly event_id: string;
  readonly event_name: string;
  readonly action: string;
  readonly decision: string;
  readonly target_kind: string | null;
  readonly target_id: string | null;
  readonly owner_agent_id: string | null;
  readonly session_id: string | null;
  readonly payload_json: string;
}

export class AuditRecorder {
  private readonly now: () => Date;
  private spool: AuditRecorderDeps["spool"];

  constructor(private readonly deps: AuditRecorderDeps) {
    this.now = deps.now ?? (() => new Date());
    this.spool = deps.spool;
  }

  append(input: AuditRecordInput): AuditAcceptResult {
    try {
      return this.appendStrict(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.spool !== undefined) {
        const envelope = this.buildEnvelope(input);
        const spoolResult = this.spool.write("audit", envelope);
        if (!spoolResult.ok) {
          this.spool = undefined; // 双失败：fail closed，不伪装成功
          return { kind: "rejected", eventName: input.eventName, reason: spoolResult.error ?? "spool 写入失败" };
        }
        return { kind: "spooled", eventId: envelope.eventId, reason };
      }
      return { kind: "rejected", eventName: input.eventName, reason };
    }
  }

  /**
   * 严格路径：任何失败直接抛出（绝不 spool）。
   * 评审 P0-1：公开给 fail-closed 调用方——文件/外部高风险修改先写后审计，
   * 审计失败即回滚；审计先行方（凭据）在写入前调用本方法，失败即拒绝操作。
   */
  appendStrict(input: AuditRecordInput): AuditAcceptResult {
    const entry = getCatalogEntry(input.eventName);
    if (entry === undefined) {
      return { kind: "rejected", eventName: input.eventName, reason: "事件未注册或版本不符" };
    }
    if (entry.channel !== "audit") {
      return { kind: "rejected", eventName: input.eventName, reason: "事件不属于 audit 通道" };
    }
    // 评审 P1-9：payload 必须符合目录固定的 schema
    if (!Value.Check(entry.payloadSchema, input.payload)) {
      return { kind: "rejected", eventName: input.eventName, reason: "payload 不符合目录 schema" };
    }
    const operationId = input.trace?.operationId;
    if (operationId !== undefined && (entry.lifecycleRole === "started" || entry.lifecycleRole === "terminal")) {
      const existing = this.findOperationLifecycle(operationId, entry.lifecycleRole);
      if (existing !== null) {
        if (this.isSameLifecycleInput(existing, input)) {
          return { kind: "accepted-idempotent", eventId: existing.event_id };
        }
        return {
          kind: "rejected",
          eventName: input.eventName,
          reason: entry.lifecycleRole === "terminal"
            ? "同一 operationId 已有冲突的 terminal 记录"
            : "同一 operationId 已有冲突的 started 记录",
        };
      }
      if (entry.lifecycleRole === "terminal") {
        const started = this.findOperationLifecycle(operationId, "started");
        if (started !== null && !this.isSameOperationSubject(started, input)) {
          return { kind: "rejected", eventName: input.eventName, reason: "terminal 与 started 的操作目标不一致" };
        }
      }
    }
    const envelope = this.buildEnvelope(input);
    if (!Value.Check(AuditEnvelopeSchema, envelope)) {
      return { kind: "rejected", eventName: input.eventName, reason: "Envelope 校验失败" };
    }
    const result = this.deps.database
      .prepare(
        `INSERT OR IGNORE INTO audit_events
          (event_id, ledger_epoch, schema_version, event_version, recorded_at, occurred_at,
           event_name, action, decision, reason_code, actor_kind, actor_id, executor_kind, executor_id,
           target_kind, target_id, owner_agent_id, session_id, trace_id, operation_id,
           policy_version, before_revision, after_revision, changed_fields_json, payload_json)
         VALUES (
           @eventId, @ledgerEpoch, 1, @eventVersion, @recordedAt, @occurredAt,
           @eventName, @action, @decision, @reasonCode, @actorKind, @actorId, @executorKind, @executorId,
           @targetKind, @targetId, @ownerAgentId, @sessionId, @traceId, @operationId,
           @policyVersion, @beforeRevision, @afterRevision, @changedFieldsJson, @payloadJson
         )`,
      )
      .run({
        eventId: envelope.eventId,
        ledgerEpoch: this.ledgerEpoch(),
        eventVersion: entry.eventVersion,
        recordedAt: envelope.recordedAt,
        occurredAt: envelope.occurredAt,
        eventName: envelope.eventName,
        action: envelope.payload.action,
        decision: envelope.payload.decision,
        reasonCode: envelope.payload.reasonCode ?? null,
        actorKind: envelope.actor.kind,
        actorId: envelope.actor.id,
        executorKind: envelope.executor.kind,
        executorId: envelope.executor.id,
        targetKind: envelope.target?.kind ?? null,
        targetId: envelope.target?.id ?? null,
        ownerAgentId: envelope.scope.ownerAgentId ?? null,
        sessionId: envelope.scope.sessionId ?? null,
        traceId: envelope.trace.traceId,
        operationId: envelope.trace.operationId ?? null,
        policyVersion: envelope.payload.policyVersion ?? null,
        beforeRevision: envelope.payload.beforeRevision ?? null,
        afterRevision: envelope.payload.afterRevision ?? null,
        changedFieldsJson: JSON.stringify(envelope.payload.changedFields ?? []),
        payloadJson: JSON.stringify(envelope.payload),
      });
    if (result.changes === 0) {
      return { kind: "accepted-idempotent", eventId: envelope.eventId };
    }
    const row = this.deps.database
      .prepare("SELECT id FROM audit_events WHERE event_id = ?")
      .get(envelope.eventId) as { id: number };
    return { kind: "accepted", eventId: envelope.eventId, rowId: row.id };
  }

  /**
   * 评审 P1（第四轮）：一次操作的多条 Audit 必须原子——全部放进同一 SQLite
   * 事务，任一 rejected 则整体回滚。防止"第一条 accepted、第二条 rejected"
   * 时账本永久保留一条声称已发生（实际已回滚）变更的记录。
   */
  appendStrictMany(inputs: readonly AuditRecordInput[]): AuditAcceptResult[] {
    if (inputs.length === 0) return [];
    const transaction = this.deps.database.transaction(() => {
      const results = inputs.map((input) => this.appendStrict(input));
      for (const result of results) {
        if (result.kind === "rejected") {
          throw new Error(`审计记录未被接受：${result.reason}`);
        }
      }
      return results;
    });
    return transaction();
  }

  /** 应急导入：spool 行幂等写入 SQLite（eventId UNIQUE）；坏行/未知事件 quarantine */
  importEnvelope(line: unknown): { ok: boolean; error?: string } {
    if (!Value.Check(AuditEnvelopeSchema, line)) return { ok: false, error: "quarantine" };
    const envelope = line as unknown as AuditEnvelope;
    const entry = getCatalogEntry(envelope.eventName, envelope.eventVersion);
    if (entry === undefined || entry.channel !== "audit") return { ok: false, error: "quarantine" };
    // 评审 P1（第三轮）：导入重新校验目录 payload schema（防篡改 spool 行绕过）
    if (!Value.Check(entry.payloadSchema, envelope.payload)) return { ok: false, error: "quarantine" };
    try {
      // spool 行无 epoch 字段：导入时归属当前 ledger epoch
      const result = this.deps.database
        .prepare(
          `INSERT OR IGNORE INTO audit_events
            (event_id, ledger_epoch, schema_version, event_version, recorded_at, occurred_at,
             event_name, action, decision, reason_code, actor_kind, actor_id, executor_kind, executor_id,
             target_kind, target_id, owner_agent_id, session_id, trace_id, operation_id,
             policy_version, before_revision, after_revision, changed_fields_json, payload_json)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.eventId,
          this.ledgerEpoch(),
          entry.eventVersion,
          envelope.recordedAt,
          envelope.occurredAt,
          envelope.eventName,
          envelope.payload.action,
          envelope.payload.decision,
          envelope.payload.reasonCode ?? null,
          envelope.actor.kind,
          envelope.actor.id,
          envelope.executor.kind,
          envelope.executor.id,
          envelope.target?.kind ?? null,
          envelope.target?.id ?? null,
          envelope.scope.ownerAgentId ?? null,
          envelope.scope.sessionId ?? null,
          envelope.trace.traceId,
          envelope.trace.operationId ?? null,
          envelope.payload.policyVersion ?? null,
          envelope.payload.beforeRevision ?? null,
          envelope.payload.afterRevision ?? null,
          JSON.stringify(envelope.payload.changedFields ?? []),
          JSON.stringify(envelope.payload),
        );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "import failed" };
    }
  }

  private findOperationLifecycle(
    operationId: string,
    role: "started" | "terminal",
  ): AuditLifecycleRow | null {
    const rows = this.deps.database
      .prepare(
        `SELECT event_id, event_name, action, decision, target_kind, target_id, owner_agent_id, session_id, payload_json
         FROM audit_events
         WHERE ledger_epoch = ? AND operation_id = ?
         ORDER BY id ASC`,
      )
      .all(this.ledgerEpoch(), operationId) as AuditLifecycleRow[];
    for (const row of rows) {
      const entry = getCatalogEntry(row.event_name);
      if (entry?.lifecycleRole === role) return row;
    }
    return null;
  }

  private isSameLifecycleInput(row: AuditLifecycleRow, input: AuditRecordInput): boolean {
    return row.event_name === input.eventName
      && this.isSameOperationSubject(row, input)
      && row.decision === input.payload.decision
      && row.payload_json === JSON.stringify(normalizeSafeObject(input.payload).value);
  }

  private isSameOperationSubject(row: AuditLifecycleRow, input: AuditRecordInput): boolean {
    return row.action === input.payload.action
      && row.target_kind === (input.target?.kind ?? null)
      && row.target_id === (input.target?.id ?? null)
      && row.owner_agent_id === (input.scope?.ownerAgentId ?? null)
      && row.session_id === (input.scope?.sessionId ?? null);
  }

  private buildEnvelope(input: AuditRecordInput): AuditEnvelope {
    const trace = input.trace ?? currentTrace() ?? { traceId: "no-trace", spanId: "no-span" };
    const nowIso = this.now().toISOString();
    const entry = getCatalogEntry(input.eventName);
    if (entry === undefined) {
      // 未注册：不可能到达（appendStrict 先校验）；防御性兜底
      throw new Error(`事件未注册：${input.eventName}`);
    }
    return {
      schemaVersion: 1,
      eventVersion: entry.eventVersion,
      eventId: crypto.randomUUID(),
      eventName: entry.eventName,
      occurredAt: nowIso,
      recordedAt: nowIso,
      level: entry.defaultLevel,
      actor: input.actor,
      executor: input.executor ?? { kind: "service", id: this.deps.producer.component },
      ...(input.target !== undefined ? { target: input.target } : {}),
      scope: input.scope ?? {},
      trace,
      producer: this.deps.producer,
      channel: "audit",
      payload: normalizeSafeObject(input.payload).value as unknown as AuditPayload,
    };
  }

  /**
   * 同库高风险修改 + Audit 同事务（§5.6 fail-closed 清单）。
   * domainFn 内的领域修改与 audit append 一起提交；任一失败整体回滚，
   * 内部走 appendStrict（绝不 spool 脱离事务）。
   */
  runAuditedTransaction<T>(input: AuditRecordInput, domainFn: () => T): { result: T; audit: AuditAcceptResult } {
    const transaction = this.deps.database.transaction(() => {
      const result = domainFn();
      const audit = this.appendStrict(input);
      if (audit.kind === "rejected") {
        throw new Error(`审计记录被拒绝：${audit.reason}`);
      }
      return { result, audit };
    });
    return transaction();
  }

  /** ledger reset：单事务递增 epoch、清理旧 epoch、留下新 epoch 的 reset 记录（§5.6） */
  resetLedger(input: { actor: ActorRef; reason: string; targetCount?: number }): { newEpoch: number; deleted: number } {
    const transaction = this.deps.database.transaction(() => {
      const oldEpoch = this.ledgerEpoch();
      const newEpoch = oldEpoch + 1;
      const deleted = this.deps.database
        .prepare("DELETE FROM audit_events WHERE ledger_epoch = ?")
        .run(oldEpoch).changes;
      this.deps.database
        .prepare("INSERT OR REPLACE INTO observability_state (key, value) VALUES ('audit.ledger_epoch', ?)")
        .run(String(newEpoch));
      this.deps.database
        .prepare(
          `INSERT INTO audit_events
            (event_id, ledger_epoch, schema_version, event_version, recorded_at, occurred_at,
             event_name, action, decision, reason_code, actor_kind, actor_id, executor_kind, executor_id,
             target_kind, target_id, trace_id, payload_json)
           VALUES (?, ?, 1, 1, ?, ?, 'audit.observability.ledger_reset', 'audit.ledger_reset', 'reset', ?, ?, ?, 'system', 'observability', 'platform', 'observability', 'reset-ledger', ?)`,
        )
        .run(
          crypto.randomUUID(),
          newEpoch,
          this.now().toISOString(),
          this.now().toISOString(),
          input.reason.slice(0, 256),
          input.actor.kind,
          input.actor.id,
          `epoch ${oldEpoch} → ${newEpoch}${input.targetCount !== undefined ? `，删除 ${input.targetCount} 条` : ""}`,
        );
      return { newEpoch, deleted };
    });
    return transaction();
  }

  getById(eventId: string): AuditEnvelope | null {
    const row = this.deps.database
      .prepare("SELECT * FROM audit_events WHERE event_id = ?")
      .get(eventId) as Record<string, unknown> | undefined;
    return row === undefined ? null : (row as unknown as AuditEnvelope);
  }

  listByEpoch(epoch: number, limit = 100): Array<{ id: number; eventId: string; action: string }> {
    const rows = this.deps.database
      .prepare("SELECT id, event_id, action FROM audit_events WHERE ledger_epoch = ? ORDER BY id DESC LIMIT ?")
      .all(epoch, limit) as Array<{ id: number; event_id: string; action: string }>;
    return rows.map((row) => ({ id: row.id, eventId: row.event_id, action: row.action }));
  }

  ledgerEpoch(): number {
    const row = this.deps.database
      .prepare("SELECT value FROM observability_state WHERE key = 'audit.ledger_epoch'")
      .get() as { value: string } | undefined;
    return row !== undefined ? Number(row.value) : 1;
  }
}
