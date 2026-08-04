import type { AgentPluginBinding, CapabilityKind } from "../../../contracts/plugin-protocol.js";
import type { PluginBindingStore } from "../../../storage/plugin-binding-store.js";
import type { PluginGrantRecord, PluginGrantStore } from "../../../storage/plugin-grant-store.js";
import type { ResolveState } from "./execution-snapshot.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 权限交集计算（plans/phase-12.md §十）
//
//   effective capability
//   = manifest request
//     ∩ installed platform grant      （plugin_grants）
//     ∩ agent binding grant           （agent_plugin_bindings，跨 Agent 隔离）
//     ∩ session/runtime policy        （本阶段提供接口与默认实现，T4/T5 接线）
//     ∩ Phase 9 sandbox policy        （sandboxCheck 可注入；沙箱边界由
//                                       SandboxBridge 执行具体路径/命令检查）
//
// 返回 allowed/denied + deniedBy（哪一层拒绝）+ evidence 依据链。
// in-flight turn 通过 state（ExecutionSnapshot 冻结的授权/绑定状态）
// 解析授权，grant/binding 后续变更不影响当前 turn。
// ═══════════════════════════════════════════════════════════════

export type PolicyLayer = "manifest" | "grant" | "binding" | "session" | "sandbox";

export interface CapabilityResolution {
  readonly allowed: boolean;
  /** 首个拒绝层；allowed 时为 null */
  readonly deniedBy: PolicyLayer | null;
  readonly reason: string;
  /** 依据链：已检查的策略层顺序 */
  readonly evidence: readonly PolicyLayer[];
}

export interface SessionRuntimePolicy {
  /**
   * 返回 null 表示该层无意见（不参与交集）；返回 { allowed: false } 表示拒绝。
   * T4/T5 将把 Session/Runtime 策略层接进来（如会话级能力开关、沙箱上下文）。
   */
  resolve(input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly capability: CapabilityKind;
    readonly sessionId?: string;
  }): { allowed: boolean; reason: string } | null;
}

/** 默认 Session/Runtime 策略：本阶段无意见（不参与交集） */
export class DefaultSessionRuntimePolicy implements SessionRuntimePolicy {
  resolve(): { allowed: boolean; reason: string } | null {
    return null;
  }
}

export interface EffectivePolicyDeps {
  readonly grants: PluginGrantStore;
  readonly bindings: PluginBindingStore;
  /** 可注入的 Session/Runtime 策略层（缺省无意见） */
  readonly sessionPolicy?: SessionRuntimePolicy;
  /**
   * 可注入的 Phase 9 沙箱策略层（capability 级预检；具体路径/命令检查由
   * SandboxBridge 执行）。返回 null 表示无意见。
   */
  readonly sandboxCheck?: (input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly capability: CapabilityKind;
  }) => { allowed: boolean; reason: string } | null;
}

export class EffectivePolicy {
  private readonly sessionPolicy: SessionRuntimePolicy;

  constructor(private readonly deps: EffectivePolicyDeps) {
    this.sessionPolicy = deps.sessionPolicy ?? new DefaultSessionRuntimePolicy();
  }

  resolveCapability(input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly capability: CapabilityKind;
    /** 插件 manifest 声明的权限请求（缺省视为已请求） */
    readonly manifestPermissions?: readonly { capability: string }[];
    /** in-flight turn 的不可变授权/绑定状态（ExecutionSnapshot 冻结）；缺省读当前库 */
    readonly state?: ResolveState;
    readonly sessionId?: string;
  }): CapabilityResolution {
    const { pluginId, agentId, capability } = input;
    const evidence: PolicyLayer[] = [];

    // ── 1. manifest 层：未声明的能力一律拒绝 ────────────────────
    if (input.manifestPermissions !== undefined) {
      evidence.push("manifest");
      if (!input.manifestPermissions.some((request) => request.capability === capability)) {
        return { allowed: false, deniedBy: "manifest", reason: "插件未在 Manifest 声明该能力", evidence };
      }
    }

    // ── 2. 平台授权层（plugin_grants；in-flight turn 用快照授权） ─
    evidence.push("grant");
    const grants: readonly PluginGrantRecord[] = input.state?.grants ?? this.deps.grants.list(pluginId);
    const grant = grants.find((item) => item.capability === capability);
    if (grant === undefined || grant.decision !== "allowed") {
      return {
        allowed: false,
        deniedBy: "grant",
        reason: grant === undefined ? "该能力未获平台授权" : "该能力已被平台撤销授权",
        evidence,
      };
    }

    // ── 3. Agent 绑定层（跨 Agent 隔离；in-flight turn 用快照绑定） ─
    evidence.push("binding");
    const binding: AgentPluginBinding | null = input.state?.binding ?? this.deps.bindings.get(agentId, pluginId);
    if (binding === null || !binding.enabled) {
      return {
        allowed: false,
        deniedBy: "binding",
        reason: binding === null ? "插件未绑定到该 Agent" : "插件对该 Agent 的绑定已被禁用",
        evidence,
      };
    }
    // 绑定引用的授权版本若超前于当前授权 → 绑定过期（授权回滚/手动修改场景 fail-closed）
    const currentGrantRevision = grants.length > 0
      ? Math.max(...grants.map((item) => item.revision))
      : 0;
    if (binding.grantRevision > currentGrantRevision) {
      return { allowed: false, deniedBy: "binding", reason: "绑定引用的授权版本超前于当前授权，绑定已失效", evidence };
    }

    // ── 4. Session/Runtime 策略层（可注入；本阶段默认无意见） ─────
    evidence.push("session");
    const sessionResult = this.sessionPolicy.resolve({
      pluginId,
      agentId,
      capability,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (sessionResult !== null && !sessionResult.allowed) {
      return { allowed: false, deniedBy: "session", reason: sessionResult.reason, evidence };
    }

    // ── 5. Phase 9 沙箱策略层（capability 级预检；可注入） ────────
    if (this.deps.sandboxCheck !== undefined) {
      evidence.push("sandbox");
      const sandboxResult = this.deps.sandboxCheck({ pluginId, agentId, capability });
      if (sandboxResult !== null && !sandboxResult.allowed) {
        return { allowed: false, deniedBy: "sandbox", reason: sandboxResult.reason, evidence };
      }
    }

    return { allowed: true, deniedBy: null, reason: "全部策略层放行", evidence };
  }
}
