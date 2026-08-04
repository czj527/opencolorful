import type { CapabilityKind } from "../../../contracts/plugin-protocol.js";
import type { AccessLevel, FileOperation } from "../../../contracts/sandbox.js";
import { instrument } from "../../../observability/instrument.js";
import { checkBashPreflight } from "../../../sandbox/preflight.js";
import type { PathGuard } from "../../../sandbox/path-guard.js";
import type { EffectivePolicy, PolicyLayer } from "./effective-policy.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 沙箱桥接（plans/phase-12.md §十 / §17.2）
//
// - 插件文件/网络/进程/Secret 操作一律走平台沙箱策略，不建立平行安全系统：
//   能力交集（EffectivePolicy）+ Phase 9 PathGuard 具体路径检查 +
//   bash preflight 危险命令模式；
// - denied 场景记录 plugin.sandbox.denied（不含路径原文/命令原文以外的
//   敏感内容；路径按 Phase 11 脱敏策略 —— 与 SandboxService 一致只保留
//   operation/level/required/pattern 等语义字段）；
// - PathGuard 未注入（沙箱未配置）时文件操作 fail-closed 拒绝。
// ═══════════════════════════════════════════════════════════════

export type SandboxDecision =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string; deniedLayer: PolicyLayer | "sandbox" };

export interface SandboxBridgeDeps {
  readonly policy: EffectivePolicy;
  /** 平台 PathGuard；null 时插件文件操作 fail-closed 拒绝 */
  readonly pathGuard: PathGuard | null;
  readonly now?: () => Date;
}

interface DeniedContext {
  readonly pluginId: string;
  readonly agentId: string;
  readonly capability: CapabilityKind;
  readonly deniedLayer: PolicyLayer | "sandbox";
  readonly reason: string;
  readonly operation?: FileOperation;
  readonly level?: AccessLevel;
  readonly required?: AccessLevel;
  readonly pattern?: string;
}

export class SandboxBridge {
  private readonly now: () => Date;

  constructor(private readonly deps: SandboxBridgeDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  checkFileOperation(input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly operation: FileOperation;
    readonly path: string;
  }): SandboxDecision {
    const { pluginId, agentId, operation, path } = input;
    const capability: CapabilityKind = operation === "read" ? "filesystem.read" : "filesystem.write";

    const capabilityDecision = this.resolveCapability({ pluginId, agentId, capability });
    if (!capabilityDecision.allowed) {
      return this.deny({
        pluginId,
        agentId,
        capability,
        deniedLayer: capabilityDecision.deniedBy,
        reason: capabilityDecision.reason,
        operation,
      });
    }

    if (this.deps.pathGuard === null) {
      return this.deny({
        pluginId,
        agentId,
        capability,
        deniedLayer: "sandbox",
        reason: "平台沙箱未配置，文件操作拒绝",
        operation,
      });
    }

    const result = this.deps.pathGuard.check(operation, path);
    if (!result.allowed) {
      return this.deny({
        pluginId,
        agentId,
        capability,
        deniedLayer: "sandbox",
        reason: result.reason,
        operation,
        level: result.level,
        required: result.required,
      });
    }
    return { allowed: true, reason: "PathGuard 放行" };
  }

  checkNetworkConnection(input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly target: string;
  }): SandboxDecision {
    const { pluginId, agentId, target } = input;
    const capabilityDecision = this.resolveCapability({ pluginId, agentId, capability: "network.connect" });
    if (!capabilityDecision.allowed) {
      return this.deny({
        pluginId,
        agentId,
        capability: "network.connect",
        deniedLayer: capabilityDecision.deniedBy,
        reason: capabilityDecision.reason,
      });
    }
    // Phase 9 无独立网络守卫；网络连接受能力交集约束（T4/T5 可注入目标 allowlist）
    void target;
    return { allowed: true, reason: "网络策略放行" };
  }

  checkProcessSpawn(input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly command: string;
  }): SandboxDecision {
    const { pluginId, agentId, command } = input;
    const capabilityDecision = this.resolveCapability({ pluginId, agentId, capability: "process.spawn" });
    if (!capabilityDecision.allowed) {
      return this.deny({
        pluginId,
        agentId,
        capability: "process.spawn",
        deniedLayer: capabilityDecision.deniedBy,
        reason: capabilityDecision.reason,
      });
    }
    const preflight = checkBashPreflight(command);
    if (!preflight.allowed) {
      return this.deny({
        pluginId,
        agentId,
        capability: "process.spawn",
        deniedLayer: "sandbox",
        reason: "危险命令模式",
        pattern: preflight.pattern,
      });
    }
    return { allowed: true, reason: "进程策略放行" };
  }

  checkSecretAccess(input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly secretName: string;
  }): SandboxDecision {
    const { pluginId, agentId, secretName } = input;
    const capabilityDecision = this.resolveCapability({ pluginId, agentId, capability: "secret.read-own" });
    if (!capabilityDecision.allowed) {
      return this.deny({
        pluginId,
        agentId,
        capability: "secret.read-own",
        deniedLayer: capabilityDecision.deniedBy,
        reason: capabilityDecision.reason,
      });
    }
    void secretName;
    return { allowed: true, reason: "Secret 策略放行" };
  }

  // ── capability 级预检（EffectivePolicy.sandboxCheck 注入点）────

  /**
   * 返回 EffectivePolicy 对某能力的交集决策。签名与 EffectivePolicyDeps.sandboxCheck
   * 兼容（返回 { allowed, reason }；本桥始终有意见，从不返回 null），可直接注入：
   *   new EffectivePolicy({ grants, bindings, sandboxCheck: (input) => bridge.resolveCapability(input) })
   */
  resolveCapability(input: {
    readonly pluginId: string;
    readonly agentId: string;
    readonly capability: CapabilityKind;
  }): { allowed: boolean; deniedBy: PolicyLayer; reason: string } {
    const resolution = this.deps.policy.resolveCapability(input);
    // EffectivePolicy 保证 denied 时 deniedBy 非空（防御性兜底为 grant 层）
    return { allowed: resolution.allowed, deniedBy: resolution.deniedBy ?? "grant", reason: resolution.reason };
  }

  // ── private helpers ───────────────────────────────────────────

  private deny(context: DeniedContext): { allowed: false; reason: string; deniedLayer: PolicyLayer | "sandbox" } {
    this.recordDenied(context);
    return { allowed: false, reason: context.reason, deniedLayer: context.deniedLayer };
  }

  private recordDenied(context: DeniedContext): void {
    instrument.activity({
      eventName: "plugin.sandbox.denied",
      actor: { kind: "plugin", id: context.pluginId },
      executor: { kind: "plugin", id: context.pluginId },
      scope: { ownerAgentId: context.agentId, pluginId: context.pluginId },
      payload: {
        summaryCode: "plugin_sandbox_denied",
        attributes: {
          capability: context.capability,
          deniedLayer: context.deniedLayer,
          ...(context.operation !== undefined ? { operation: context.operation } : {}),
          ...(context.level !== undefined ? { level: context.level } : {}),
          ...(context.required !== undefined ? { required: context.required } : {}),
          ...(context.pattern !== undefined ? { pattern: context.pattern } : {}),
        },
      },
    });
  }
}
