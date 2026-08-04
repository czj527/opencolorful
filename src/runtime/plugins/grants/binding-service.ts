import crypto from "node:crypto";

import type { ActorRef, ExecutorRef, ResourceRef, TraceContext } from "../../../contracts/observability.js";
import type { AgentPluginBinding } from "../../../contracts/plugin-protocol.js";
import { PLUGIN_ID_PATTERN } from "../../../contracts/plugin-protocol.js";
import { assertDurableAudit, type AuditRecorder } from "../../../observability/audit-recorder.js";
import { instrument } from "../../../observability/instrument.js";
import type { PluginBindingStore } from "../../../storage/plugin-binding-store.js";
import type { PluginGrantStore } from "../../../storage/plugin-grant-store.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Agent 插件绑定服务（plans/phase-12.md §十一 / §17.3）
//
// - Agent × pluginId 绑定持久化；允许的 contributions 子集；
// - 绑定只引用平台授权（grantRevision），不替代授权；绑定时要求插件
//   已至少授予一个能力（grantRevision >= 1）；
// - 绑定变更从下一 turn 生效：每次变更 binding revision +1，配合
//   grant revision 由 ExecutionSnapshot 冻结；
// - 变更走严格审计三阶段（audit.plugin.agent_binding_change_*），
//   audit 未配置/拒绝 → fail-closed 拒绝变更。
// ═══════════════════════════════════════════════════════════════

export interface BindingServiceDeps {
  readonly store: PluginBindingStore;
  readonly grants: PluginGrantStore;
  readonly audit: AuditRecorder;
  readonly now?: () => Date;
}

export interface BindingActor {
  readonly actor: ActorRef;
}

export interface BindInput {
  readonly agentId: string;
  readonly pluginId: string;
  /** 允许该 Agent 使用的 contribution id（空 = 全部启用） */
  readonly contributions?: readonly string[];
  readonly enabled?: boolean;
}

const EXECUTOR: ExecutorRef = { kind: "service", id: "plugin-bindings" };
const ACTION = "agent.binding.change";
const CHANGED_FIELDS = ["contributions", "grantRevision", "enabled", "revision"] as const;

export class BindingService {
  private readonly now: () => Date;

  constructor(private readonly deps: BindingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  bind(input: BindInput, bindingActor: BindingActor): AgentPluginBinding {
    const { agentId, pluginId } = input;
    this.validateAgentId(agentId);
    this.validatePluginId(pluginId);
    const contributions = this.validateContributions(input.contributions);
    const enabled = input.enabled ?? true;

    const grantRevision = this.deps.grants.maxRevision(pluginId);
    if (grantRevision < 1) {
      throw new Error("插件尚未授予任何能力，无法绑定（绑定只引用授权，不替代授权）");
    }

    const beforeRevision = this.deps.store.maxRevision(agentId, pluginId);
    const afterRevision = beforeRevision + 1;
    const nowIso = this.now().toISOString();
    const operationId = `binding-change-${agentId.slice(0, 32)}-${pluginId.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace = this.newTrace(operationId);

    const binding: AgentPluginBinding = {
      agentId,
      pluginId,
      contributions: [...contributions],
      grantRevision,
      enabled,
      revision: afterRevision,
      updatedAt: nowIso,
    };

    this.commitBindingChange({
      agentId,
      pluginId,
      actor: bindingActor.actor,
      trace,
      beforeRevision,
      afterRevision,
      write: () => {
        this.deps.store.upsert({
          agentId,
          pluginId,
          contributions,
          grantRevision,
          enabled,
          revision: afterRevision,
          updatedAt: nowIso,
        });
        return binding;
      },
    });
    return binding;
  }

  unbind(agentId: string, pluginId: string, bindingActor: BindingActor): void {
    this.validateAgentId(agentId);
    this.validatePluginId(pluginId);
    const existing = this.deps.store.get(agentId, pluginId);
    if (existing === null) {
      throw new Error("绑定不存在，无法解绑");
    }

    const beforeRevision = this.deps.store.maxRevision(agentId, pluginId);
    const afterRevision = beforeRevision + 1;
    const operationId = `binding-change-${agentId.slice(0, 32)}-${pluginId.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace = this.newTrace(operationId);

    this.commitBindingChange({
      agentId,
      pluginId,
      actor: bindingActor.actor,
      trace,
      beforeRevision,
      afterRevision,
      write: () => {
        this.deps.store.remove(agentId, pluginId);
      },
    });
  }

  setEnabled(agentId: string, pluginId: string, enabled: boolean, bindingActor: BindingActor): AgentPluginBinding {
    this.validateAgentId(agentId);
    this.validatePluginId(pluginId);
    const existing = this.deps.store.get(agentId, pluginId);
    if (existing === null) {
      throw new Error("绑定不存在，无法修改启用状态");
    }

    const beforeRevision = this.deps.store.maxRevision(agentId, pluginId);
    const afterRevision = beforeRevision + 1;
    const nowIso = this.now().toISOString();
    const operationId = `binding-change-${agentId.slice(0, 32)}-${pluginId.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;
    const trace = this.newTrace(operationId);

    const binding: AgentPluginBinding = { ...existing, enabled, revision: afterRevision, updatedAt: nowIso };

    this.commitBindingChange({
      agentId,
      pluginId,
      actor: bindingActor.actor,
      trace,
      beforeRevision,
      afterRevision,
      write: () => {
        this.deps.store.upsert({
          agentId,
          pluginId,
          contributions: existing.contributions,
          grantRevision: existing.grantRevision,
          enabled,
          revision: afterRevision,
          updatedAt: nowIso,
        });
        return binding;
      },
    });
    return binding;
  }

  get(agentId: string, pluginId: string): AgentPluginBinding | null {
    return this.deps.store.get(agentId, pluginId);
  }

  listByAgent(agentId: string): AgentPluginBinding[] {
    return this.deps.store.listByAgent(agentId);
  }

  // ── private helpers ───────────────────────────────────────────

  private commitBindingChange<T>(params: {
    agentId: string;
    pluginId: string;
    actor: ActorRef;
    trace: TraceContext;
    beforeRevision: number;
    afterRevision: number;
    write: () => T;
  }): T {
    const { agentId, pluginId, actor, trace, beforeRevision, afterRevision, write } = params;
    const target: ResourceRef = { kind: "plugin", id: pluginId };
    const scope = { ownerAgentId: agentId, pluginId };

    assertDurableAudit(
      this.deps.audit.appendStrict({
        eventName: "audit.plugin.agent_binding_change_started",
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
        scope,
        trace,
      }),
      "Agent 绑定审计(启动)",
    );

    try {
      const { result } = this.deps.audit.runAuditedTransaction(
        {
          eventName: "audit.plugin.agent_binding_change_completed",
          payload: {
            action: ACTION,
            decision: "allowed",
            beforeRevision: String(beforeRevision),
            afterRevision: String(afterRevision),
            changedFields: [...CHANGED_FIELDS],
          },
          actor,
          executor: EXECUTOR,
          target,
          scope,
          trace,
        },
        write,
      );
      return result;
    } catch (error) {
      try {
        this.deps.audit.appendStrict({
          eventName: "audit.plugin.agent_binding_change_failed",
          payload: {
            action: ACTION,
            decision: "denied",
            reasonCode: "binding_write_failed",
            beforeRevision: String(beforeRevision),
            changedFields: [...CHANGED_FIELDS],
          },
          actor,
          executor: EXECUTOR,
          target,
          scope,
          trace,
        });
      } catch {
        // failed 终态写不进去时保留原错误
      }
      throw error;
    }
  }

  private validateAgentId(agentId: string): void {
    if (typeof agentId !== "string" || agentId.length < 1 || agentId.length > 128) {
      throw new Error("Agent ID 不合法");
    }
  }

  private validatePluginId(pluginId: string): void {
    if (!new RegExp(PLUGIN_ID_PATTERN).test(pluginId)) {
      throw new Error("插件 ID 不合法");
    }
  }

  private validateContributions(contributions: readonly string[] | undefined): string[] {
    if (contributions === undefined) return [];
    if (contributions.length > 512) {
      throw new Error("允许的 contributions 数量超出上限");
    }
    const seen = new Set<string>();
    for (const contribution of contributions) {
      if (typeof contribution !== "string" || contribution.length < 1 || contribution.length > 128) {
        throw new Error("contribution id 不合法");
      }
      if (seen.has(contribution)) {
        throw new Error("contribution id 重复");
      }
      seen.add(contribution);
    }
    return [...contributions];
  }

  private newTrace(operationId: string): TraceContext {
    return { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
  }
}
