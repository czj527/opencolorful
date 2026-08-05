import crypto from "node:crypto";

import Value from "typebox/value";

import {
  PLUGIN_EXECUTION_SNAPSHOT_VERSION,
  PluginExecutionSnapshotSchema,
  type AgentPluginBinding,
  type PluginExecutionSnapshot,
} from "../../../contracts/plugin-protocol.js";
import type { PluginBindingStore } from "../../../storage/plugin-binding-store.js";
import type { PluginGrantRecord, PluginGrantStore } from "../../../storage/plugin-grant-store.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 不可变执行快照（plans/phase-12.md §十一）
//
// - PluginExecutionSnapshot 为不可变对象：一次 in-flight turn 使用同一
//   快照，不能中途换工具实现；
// - 快照记录 pluginVersion / runtimeInstanceId / grantRevision /
//   bindingRevision / contributions；每次工具调用据此回放与诊断；
// - state 是快照创建时冻结的授权 + 绑定状态：turn 内授权解析以 state
//   为准（grant/binding 后续变更不影响 in-flight turn）；
// - 快照只在插件已授权（grantRevision >= 1）且已绑定到 Agent 时创建。
// ═══════════════════════════════════════════════════════════════

export interface ResolveState {
  /** 快照创建时冻结的平台授权（in-flight turn 授权解析依据） */
  readonly grants: readonly PluginGrantRecord[];
  readonly binding: AgentPluginBinding | null;
}

export interface ExecutionSnapshotDeps {
  readonly bindings: PluginBindingStore;
  readonly grants: PluginGrantStore;
  /**
   * 解析插件当前全部登记 contribution id（P0-1：绑定空列表 = "允许全部"，
   * 冻结时必须展开为冻结时刻的实际贡献集合，否则快照的 includes 校验
   * 会拒绝所有 contribution）。未提供时按空集合处理（fail-closed）。
   */
  readonly listContributionIds?: (pluginId: string) => readonly string[];
  readonly now?: () => Date;
  readonly snapshotIdFactory?: () => string;
}

export interface ExecutionSnapshotResult {
  readonly snapshot: PluginExecutionSnapshot;
  readonly state: ResolveState;
}

export class ExecutionSnapshotService {
  private readonly now: () => Date;
  private readonly snapshotIdFactory: () => string;

  constructor(private readonly deps: ExecutionSnapshotDeps) {
    this.now = deps.now ?? (() => new Date());
    this.snapshotIdFactory = deps.snapshotIdFactory ?? (() => `snap-${crypto.randomUUID()}`);
  }

  create(input: {
    readonly pluginId: string;
    readonly pluginVersion: string;
    readonly runtimeKind: string;
    readonly runtimeInstanceId: string;
    readonly agentId: string;
  }): ExecutionSnapshotResult {
    const { pluginId, pluginVersion, runtimeKind, runtimeInstanceId, agentId } = input;

    const binding = this.deps.bindings.get(agentId, pluginId);
    if (binding === null || !binding.enabled) {
      throw new Error(`插件 ${pluginId} 未绑定到 Agent ${agentId} 或绑定已禁用，无法创建执行快照`);
    }
    const grantRevision = this.deps.grants.maxRevision(pluginId);
    if (grantRevision < 1) {
      throw new Error(`插件 ${pluginId} 尚无任何授权，无法创建执行快照`);
    }
    const grants = this.deps.grants.list(pluginId);
    // P0-1：绑定空列表 = "允许全部"（binding-service 契约），冻结时展开为
    // 当前登记贡献集合——快照是 turn 开始时刻的冻结视图，后续新增贡献不在
    // 本 turn 生效；展开失败（无解析源）按空集合处理（fail-closed：宁缺毋滥）。
    const contributions =
      binding.contributions.length > 0
        ? [...binding.contributions]
        : [...(this.deps.listContributionIds?.(pluginId) ?? [])];

    const snapshot: PluginExecutionSnapshot = {
      version: PLUGIN_EXECUTION_SNAPSHOT_VERSION,
      snapshotId: this.snapshotIdFactory(),
      pluginId,
      pluginVersion,
      runtimeKind,
      runtimeInstanceId,
      grantRevision,
      bindingRevision: binding.revision,
      contributions,
      createdAt: this.now().toISOString(),
    };

    const state: ResolveState = deepFreeze({ grants: deepFreeze(grants), binding: deepFreeze(binding) });

    if (!Value.Check(PluginExecutionSnapshotSchema, snapshot)) {
      throw new Error("执行快照不符合协议 schema");
    }
    return { snapshot: deepFreeze(snapshot), state };
  }

  /** 校验快照协议合法性（运行时/调用方在每次工具调用前复核） */
  validate(snapshot: unknown): { ok: boolean; reason?: string } {
    if (!Value.Check(PluginExecutionSnapshotSchema, snapshot)) {
      return { ok: false, reason: "执行快照不符合协议 schema" };
    }
    return { ok: true };
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
