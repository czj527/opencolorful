import Value from "typebox/value";

import type { ActorRef, ExecutorRef, TraceContext } from "../../../contracts/observability.js";
import { instrument } from "../../../observability/instrument.js";
import type { AuditRecorder } from "../../../observability/audit-recorder.js";
import type { PluginConfigStore } from "../../../storage/plugin-config-store.js";
import type { ContributionRegistry } from "./contribution-registry.js";
import { runStrictAuditLifecycle } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Config Contribution（plans/phase-12.md §8.7）
//
// - 插件配置读写复用 plugin_configs（PluginConfigStore）：全局
//   （agentId=''）与 per-Agent 非敏感配置分离；
// - 变更走 audit.plugin.config_change_* 三阶段严格审计（started →
//   写入 + completed 同事务 → 失败 failed 终态），fail-closed；
// - 配置值只存非敏感数据，Secret 走 SecretService（占位 store）。
// ═══════════════════════════════════════════════════════════════

export interface ConfigDescriptor {
  readonly pluginId: string;
  readonly configId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly schema?: unknown;
}

export interface ConfigServiceDeps {
  readonly registry: ContributionRegistry;
  readonly store: PluginConfigStore;
  readonly audit: AuditRecorder;
  readonly now?: () => Date;
}

const EXECUTOR: ExecutorRef = { kind: "service", id: "plugin-config" };
const ACTION = "plugin.config.change";
const CHANGED_FIELDS = ["config"] as const;

export class ConfigService {
  private readonly now: () => Date;

  constructor(private readonly deps: ConfigServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  listConfigContributions(pluginId: string): ConfigDescriptor[] {
    return this.deps.registry
      .listByKind(pluginId, "config")
      .map((contribution) => this.toDescriptor(contribution))
      .filter((descriptor): descriptor is ConfigDescriptor => descriptor !== undefined);
  }

  /** 读取配置（全局或 per-Agent；不区分 Sensitive）。 */
  getConfig(pluginId: string, agentId: string): Record<string, unknown> | null {
    const entry = this.deps.store.get(pluginId, agentId);
    return entry === null ? null : entry.config;
  }

  listConfigs(pluginId: string): Array<{ agentId: string; revision: number; config: Record<string, unknown> }> {
    return this.deps.store
      .list(pluginId)
      .map((entry) => ({ agentId: entry.agentId, revision: entry.revision, config: entry.config }));
  }

  /**
   * 写入/更新插件配置：Schema 校验 → 三阶段严格审计（fail-closed）。
   * 审计未配置/拒绝时抛错且不写入任何配置。
   */
  setConfig(input: { pluginId: string; agentId: string; config: Record<string, unknown>; actor: ActorRef }): { revision: number } {
    const { pluginId, agentId, config, actor } = input;
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error("配置必须是 JSON 对象");
    }
    this.validateConfigAgainstSchema(pluginId, config);

    const beforeRevision = String(this.deps.store.maxRevision(pluginId, agentId));
    const operationId = `config-change-${pluginId.slice(0, 64)}-${agentId.slice(0, 32)}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const trace = this.newTrace(operationId);

    return runStrictAuditLifecycle(
      {
        audit: this.deps.audit,
        trace,
        actor,
        executor: EXECUTOR,
        target: { kind: "plugin", id: pluginId },
        scope: agentId === "" ? { pluginId } : { ownerAgentId: agentId, pluginId },
        startEventName: "audit.plugin.config_change_started",
        completedEventName: "audit.plugin.config_change_completed",
        failedEventName: "audit.plugin.config_change_failed",
        action: ACTION,
        beforeRevision,
        afterRevision: String(beforeRevision.length === 0 ? 1 : Number(beforeRevision) + 1),
        changedFields: CHANGED_FIELDS,
      },
      () => {
        const result = this.deps.store.set({
          pluginId,
          agentId,
          config,
          updatedAt: this.now().toISOString(),
        });
        return result;
      },
    );
  }

  /** 移除某 Agent 的插件配置（不删除插件数据目录）。 */
  removeConfig(input: { pluginId: string; agentId: string; actor: ActorRef }): void {
    const { pluginId, agentId, actor } = input;
    const beforeRevision = String(this.deps.store.maxRevision(pluginId, agentId));
    const operationId = `config-change-${pluginId.slice(0, 64)}-${agentId.slice(0, 32)}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const trace = this.newTrace(operationId);
    runStrictAuditLifecycle(
      {
        audit: this.deps.audit,
        trace,
        actor,
        executor: EXECUTOR,
        target: { kind: "plugin", id: pluginId },
        scope: agentId === "" ? { pluginId } : { ownerAgentId: agentId, pluginId },
        startEventName: "audit.plugin.config_change_started",
        completedEventName: "audit.plugin.config_change_completed",
        failedEventName: "audit.plugin.config_change_failed",
        action: ACTION,
        beforeRevision,
        afterRevision: "0",
        changedFields: CHANGED_FIELDS,
      },
      () => {
        this.deps.store.remove(pluginId, agentId);
      },
    );
  }

  // ── private helpers ───────────────────────────────────────────

  private validateConfigAgainstSchema(pluginId: string, config: Record<string, unknown>): void {
    const contributions = this.listConfigContributions(pluginId);
    const schema = contributions.find((descriptor) => descriptor.schema !== undefined)?.schema;
    if (schema === undefined) {
      return;
    }
    if (!isSchemaObject(schema)) {
      throw new Error("插件配置 Schema 非法，拒绝写入");
    }
    try {
      if (!Value.Check(schema, config)) {
        throw new Error("配置不符合插件声明的 Schema");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "配置不符合插件声明的 Schema") {
        throw error;
      }
      instrument.warn("plugin.config.schema_invalid", "插件配置 Schema 无法校验，拒绝写入", {
        pluginId,
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      throw new Error("插件配置 Schema 无法校验，拒绝写入");
    }
  }

  private toDescriptor(contribution: import("./contribution-registry.js").RegisteredContribution): ConfigDescriptor | undefined {
    if (contribution.kind !== "config") {
      return undefined;
    }
    const descriptor: ConfigDescriptor = {
      pluginId: contribution.pluginId,
      configId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
    };
    const schema = contribution.spec["schema"];
    return isSchemaObject(schema) ? { ...descriptor, schema } : descriptor;
  }

  private newTrace(operationId: string): TraceContext {
    return { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
