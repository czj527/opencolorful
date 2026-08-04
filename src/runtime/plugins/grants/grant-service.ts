import crypto from "node:crypto";

import Value from "typebox/value";

import type { ActorRef, ExecutorRef, ResourceRef, TraceContext } from "../../../contracts/observability.js";
import { GrantChangeInputSchema, type CapabilityKind, type GrantDecision } from "../../../contracts/plugin-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import { assertDurableAudit, type AuditRecorder } from "../../../observability/audit-recorder.js";
import { type PluginGrantRecord, type PluginGrantStore } from "../../../storage/plugin-grant-store.js";
import { isHighRisk, isKnownCapability } from "./capability-catalog.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 平台级授权服务（plans/phase-12.md §十 / §17.3）
//
// - 授权/撤销持久化到 plugin_grants，revision 插件级单调递增（每次变更 +1）；
// - 高风险能力必须用户显式确认（或 full-access 审核通过路径），否则拒绝；
// - 变更走严格审计三阶段：started（fail-closed）→ 领域写入 + completed
//   同一事务 → 失败补 failed 终态；audit 未配置/拒绝 → 抛错且不写入；
// - 授权结果同步发 plugin.permission.granted/denied/revoked Activity。
//
// 协议包类型说明：GrantChangeInputSchema / PluginGrantSchema 的 Static
// 类型在 typebox 1.3.6 下对 `CAPABILITY_KINDS.map(kind => Type.Literal(kind))`
// 构建的 Literal 联合解析为 never（open array 非 tuple，StaticUnion 递归
// 无法分发）。这是 T1 冻结契约缺陷，本服务用结构一致的 GrantChangeRequest
// 承载输入，仍以 GrantChangeInputSchema 做运行时校验（fail-closed）。
// ═══════════════════════════════════════════════════════════════

export interface GrantServiceDeps {
  readonly store: PluginGrantStore;
  readonly audit: AuditRecorder;
  readonly now?: () => Date;
}

/** 一次权限变更输入（与 GrantChangeInputSchema 结构一致，capability/decision 正确取值） */
export interface GrantChangeRequest {
  readonly pluginId: string;
  readonly capability: CapabilityKind;
  readonly decision: GrantDecision;
  readonly reason?: string;
}

/** 授权发起方：高风险能力要求 kind === "user"（用户显式确认） */
export interface GrantActor {
  readonly actor: ActorRef;
  /** full-access 审核通过路径：允许 system 等平台 actor 授予高风险能力 */
  readonly allowSystemForHighRisk?: boolean;
}

export type GrantChangeResult =
  | { kind: "granted"; grant: PluginGrantRecord }
  | { kind: "revoked"; grant: PluginGrantRecord }
  | { kind: "denied"; grant: PluginGrantRecord };

const EXECUTOR: ExecutorRef = { kind: "service", id: "plugin-grants" };
const ACTION = "grant.change";
const CHANGED_FIELDS = ["capability", "decision"] as const;

export class GrantService {
  private readonly now: () => Date;

  constructor(private readonly deps: GrantServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  change(input: GrantChangeRequest, grantActor: GrantActor): GrantChangeResult {
    if (!Value.Check(GrantChangeInputSchema, input)) {
      throw new Error("权限变更输入不合法");
    }
    // 校验通过后回落到结构正确的类型（避免协议 Static 联合类型 never 缺陷）
    const request: GrantChangeRequest = input;
    const { pluginId, capability, decision } = request;
    if (!isKnownCapability(capability)) {
      throw new Error(`未知能力族：${capability}`);
    }
    if (isHighRisk(capability) && grantActor.actor.kind !== "user" && grantActor.allowSystemForHighRisk !== true) {
      throw new Error(`高风险能力 ${capability} 需要用户显式确认（或 full-access 审核通过）`);
    }

    const previous = this.deps.store.get(pluginId, capability);
    const beforeRevision = this.deps.store.maxRevision(pluginId);
    const afterRevision = beforeRevision + 1;
    const nowIso = this.now().toISOString();
    const operationId = `grant-change-${pluginId.slice(0, 64)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace = this.newTrace(operationId);
    const target: ResourceRef = { kind: "plugin", id: pluginId };
    const actor = grantActor.actor;

    const grant: PluginGrantRecord = {
      pluginId,
      capability,
      decision,
      revision: afterRevision,
      grantedAt: nowIso,
      grantedBy: actor.id,
    };

    // 阶段一：started（fail-closed —— audit 未配置/拒绝立即抛错，不写入）
    assertDurableAudit(
      this.deps.audit.appendStrict({
        eventName: "audit.plugin.permission_change_started",
        payload: {
          action: ACTION,
          decision: "deferred",
          beforeRevision: String(beforeRevision),
          afterRevision: String(afterRevision),
          changedFields: [...CHANGED_FIELDS],
        },
        actor,
        executor: EXECUTOR,
        target,
        scope: { pluginId },
        trace,
      }),
      "权限变更审计(启动)",
    );

    try {
      // 阶段二 + 阶段三：领域写入与 completed 审计同一事务，任一失败整体回滚
      const { result } = this.deps.audit.runAuditedTransaction(
        {
          eventName: "audit.plugin.permission_change_completed",
          payload: {
            action: ACTION,
            decision: decision === "allowed" ? "allowed" : "denied",
            beforeRevision: String(beforeRevision),
            afterRevision: String(afterRevision),
            changedFields: [...CHANGED_FIELDS],
          },
          actor,
          executor: EXECUTOR,
          target,
          scope: { pluginId },
          trace,
        },
        () => {
          this.deps.store.upsert({
            pluginId,
            capability,
            decision,
            revision: afterRevision,
            grantedBy: actor.id,
            grantedAt: nowIso,
          });
          return grant;
        },
      );
      this.emitPermissionActivity({ request, previous, grant, actor, trace });
      return this.toChangeResult(request, previous, result);
    } catch (error) {
      // 事务失败：领域写入已回滚；尽力补 failed 终态（失败不吞原错误）
      this.tryAppendFailure({ request, beforeRevision, actor, target, trace });
      throw error;
    }
  }

  grant(
    input: { pluginId: string; capability: CapabilityKind; reason?: string },
    grantActor: GrantActor,
  ): GrantChangeResult {
    return this.change(
      {
        pluginId: input.pluginId,
        capability: input.capability,
        decision: "allowed",
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      grantActor,
    );
  }

  revoke(
    input: { pluginId: string; capability: CapabilityKind; reason?: string },
    grantActor: GrantActor,
  ): GrantChangeResult {
    return this.change(
      {
        pluginId: input.pluginId,
        capability: input.capability,
        decision: "denied",
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      grantActor,
    );
  }

  get(pluginId: string, capability: string): PluginGrantRecord | null {
    return this.deps.store.get(pluginId, capability);
  }

  list(pluginId: string): PluginGrantRecord[] {
    return this.deps.store.list(pluginId);
  }

  /** 插件当前授权版本（无授权时 0） */
  currentRevision(pluginId: string): number {
    return this.deps.store.maxRevision(pluginId);
  }

  // ── private helpers ───────────────────────────────────────────

  private toChangeResult(
    request: GrantChangeRequest,
    previous: PluginGrantRecord | null,
    grant: PluginGrantRecord,
  ): GrantChangeResult {
    if (request.decision === "allowed") return { kind: "granted", grant };
    return previous?.decision === "allowed"
      ? { kind: "revoked", grant }
      : { kind: "denied", grant };
  }

  private emitPermissionActivity(params: {
    request: GrantChangeRequest;
    previous: PluginGrantRecord | null;
    grant: PluginGrantRecord;
    actor: ActorRef;
    trace: TraceContext;
  }): void {
    const { request, previous, grant, actor, trace } = params;
    let eventName: string;
    if (request.decision === "allowed") {
      eventName = "plugin.permission.granted";
    } else if (previous?.decision === "allowed") {
      eventName = "plugin.permission.revoked";
    } else {
      eventName = "plugin.permission.denied";
    }
    instrument.activity({
      eventName,
      actor,
      executor: EXECUTOR,
      target: { kind: "plugin", id: request.pluginId },
      scope: { pluginId: request.pluginId },
      trace,
      payload: {
        summaryCode: eventName.replace(/\./g, "_"),
        attributes: {
          pluginId: request.pluginId,
          capability: request.capability,
          decision: request.decision,
          revision: grant.revision,
          grantedBy: actor.id,
          ...(request.reason !== undefined ? { reason: request.reason.slice(0, 200) } : {}),
        },
      },
    });
  }

  private tryAppendFailure(params: {
    request: GrantChangeRequest;
    beforeRevision: number;
    actor: ActorRef;
    target: ResourceRef;
    trace: TraceContext;
  }): void {
    const { request, beforeRevision, actor, target, trace } = params;
    try {
      this.deps.audit.appendStrict({
        eventName: "audit.plugin.permission_change_failed",
        payload: {
          action: ACTION,
          decision: "denied",
          reasonCode: "grant_write_failed",
          beforeRevision: String(beforeRevision),
          changedFields: [...CHANGED_FIELDS],
        },
        actor,
        executor: EXECUTOR,
        target,
        scope: { pluginId: request.pluginId },
        trace,
      });
    } catch {
      // failed 终态也写不进去时保留原错误（appendStrict 已 fail-closed）
    }
  }

  private newTrace(operationId: string): TraceContext {
    return { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
  }
}
