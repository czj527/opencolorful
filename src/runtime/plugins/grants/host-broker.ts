import crypto from "node:crypto";

import type { CapabilityKind, PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import { PLUGIN_ID_PATTERN } from "../../../contracts/plugin-protocol.js";
import { sanitizeError } from "../../../observability/safe-value.js";
import type { EffectivePolicy } from "./effective-policy.js";
import type { ResolveState } from "./execution-snapshot.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Host capability broker（plans/phase-12.md §十 / §22.2）
//
// - 插件不能直接调用平台内部对象；只能经本 broker 调用白名单 Host API；
// - 调用必须携带平台签发的身份（pluginId + runtimeInstanceId），
//   伪造/缺失/未注册实例一律拒绝；
// - 调用参数携带平台权威字段（scope/trace/actor/executor/producer/
//   eventId/recordedAt/audit 等）一律拒绝 —— 插件不能自报权威字段；
// - 本 broker 不暴露 Store/spool/Audit 直接写入口：handler 由平台
//   以白名单方式注册，只收到 ctx（身份 + Agent/Session scope）与参数；
// - 每个 API 可声明 requiredCapabilities，调用前经 EffectivePolicy 校验。
// ═══════════════════════════════════════════════════════════════

export interface HostIdentity {
  readonly pluginId: string;
  readonly runtimeInstanceId: string;
}

export interface HostCallContext {
  readonly identity: HostIdentity;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly snapshot?: PluginExecutionSnapshot;
  /** P1-1：in-flight turn 冻结的授权/绑定状态（与 snapshot 同源，由运行时随 operation 绑定） */
  readonly state?: ResolveState;
}

export interface HostApiEntry {
  readonly name: string;
  readonly description: string;
  /** 调用所需的能力（全部 allowed 才放行）；缺省无能力要求 */
  readonly requiredCapabilities?: readonly CapabilityKind[];
  readonly handler: (ctx: HostCallContext, args: unknown) => unknown;
}

export interface HostBrokerDeps {
  readonly policy: EffectivePolicy;
  readonly now?: () => Date;
}

export type HostCallResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; code: HostRejectCode };

export type HostRejectCode =
  | "unauthorized-identity"
  | "unknown-api"
  | "forged-authority-fields"
  | "capability-denied"
  | "handler-error";

/** 插件参数中禁止出现的平台权威字段（伪造即拒绝） */
const FORBIDDEN_AUTHORITY_KEYS: readonly string[] = [
  "scope",
  "trace",
  "actor",
  "executor",
  "producer",
  "eventId",
  "eventName",
  "recordedAt",
  "occurredAt",
  "audit",
  "channel",
  "significance",
  "operationId",
];

export class HostBroker {
  private readonly apis = new Map<string, HostApiEntry>();
  /** 平台已签发的运行实例（runtimeInstanceId → 归属身份） */
  private readonly instances = new Map<string, HostIdentity>();

  constructor(private readonly deps: HostBrokerDeps) {
    // 平台内置白名单 Host API（无能力要求，供运行时健康/身份自检）
    this.registerApi({
      name: "host.ping",
      description: "宿主连通性自检",
      handler: (ctx) => ({ pong: true, pluginId: ctx.identity.pluginId, runtimeInstanceId: ctx.identity.runtimeInstanceId }),
    });
    this.registerApi({
      name: "host.runtime-info",
      description: "读取当前运行实例信息（平台签发身份）",
      handler: (ctx) => ({ pluginId: ctx.identity.pluginId, runtimeInstanceId: ctx.identity.runtimeInstanceId }),
    });
  }

  /** 平台注册白名单 Host API（重名拒绝） */
  registerApi(entry: HostApiEntry): void {
    if (this.apis.has(entry.name)) {
      throw new Error(`Host API 已注册：${entry.name}`);
    }
    this.apis.set(entry.name, entry);
  }

  unregisterApi(name: string): void {
    this.apis.delete(name);
  }

  /** 平台签发运行实例（Runtime 启动时调用）；重名实例覆盖旧身份 */
  registerRuntimeInstance(identity: HostIdentity): void {
    this.instances.set(identity.runtimeInstanceId, { ...identity });
  }

  /** 实例销毁/崩溃后吊销（旧实例不能继续调用 Host API） */
  invalidateRuntimeInstance(runtimeInstanceId: string): void {
    this.instances.delete(runtimeInstanceId);
  }

  listApis(): readonly HostApiEntry[] {
    return [...this.apis.values()];
  }

  call(input: {
    readonly identity: HostIdentity;
    readonly apiName: string;
    readonly args?: unknown;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly snapshot?: PluginExecutionSnapshot;
    /** in-flight turn 冻结的授权/绑定状态（与 snapshot 一同由运行时持有） */
    readonly state?: ResolveState;
  }): HostCallResult {
    // ── 1. 身份：必须平台签发且实例有效 ───────────────────────────
    const identityIssue = this.checkIdentity(input.identity);
    if (identityIssue !== null) {
      return { ok: false, reason: identityIssue, code: "unauthorized-identity" };
    }

    // ── 2. 白名单 API ─────────────────────────────────────────────
    const api = this.apis.get(input.apiName);
    if (api === undefined) {
      return { ok: false, reason: `未知 Host API：${input.apiName}`, code: "unknown-api" };
    }

    // ── 3. 伪造平台权威字段 → 拒绝 ────────────────────────────────
    if (this.containsAuthorityFields(input.args)) {
      return { ok: false, reason: "调用参数包含平台权威字段，拒绝", code: "forged-authority-fields" };
    }

    // ── 4. 能力校验（requiredCapabilities 全部 allowed 才放行） ───
    const required = api.requiredCapabilities ?? [];
    if (required.length > 0) {
      if (input.agentId === undefined) {
        return { ok: false, reason: "缺少 Agent 上下文，无法校验能力", code: "capability-denied" };
      }
      for (const capability of required) {
        const resolution = this.deps.policy.resolveCapability({
          pluginId: input.identity.pluginId,
          agentId: input.agentId,
          capability,
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        });
        if (!resolution.allowed) {
          return {
            ok: false,
            reason: `Host API ${api.name} 需要能力 ${capability}（被 ${resolution.deniedBy} 层拒绝）`,
            code: "capability-denied",
          };
        }
      }
    }

    // ── 5. 执行白名单 handler ─────────────────────────────────────
    const ctx: HostCallContext = {
      identity: { ...input.identity },
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
    };
    try {
      const value = api.handler(ctx, input.args);
      return { ok: true, value };
    } catch (error) {
      const cleaned = sanitizeError(error);
      return { ok: false, reason: cleaned.message.slice(0, 400), code: "handler-error" };
    }
  }

  // ── private helpers ───────────────────────────────────────────

  private checkIdentity(identity: HostIdentity): string | null {
    if (
      identity === null ||
      typeof identity !== "object" ||
      typeof identity.pluginId !== "string" ||
      typeof identity.runtimeInstanceId !== "string"
    ) {
      return "调用身份缺失";
    }
    if (!new RegExp(PLUGIN_ID_PATTERN).test(identity.pluginId)) {
      return "插件 ID 不合法";
    }
    if (identity.runtimeInstanceId.length < 1 || identity.runtimeInstanceId.length > 128) {
      return "运行实例 ID 不合法";
    }
    const instance = this.instances.get(identity.runtimeInstanceId);
    if (instance === undefined || instance.pluginId !== identity.pluginId) {
      return "运行实例未由平台签发或已失效";
    }
    return null;
  }

  private containsAuthorityFields(args: unknown): boolean {
    if (args === undefined || args === null) return false;
    if (typeof args !== "object") return false;
    const keys = Object.keys(args as Record<string, unknown>);
    return keys.some((key) => (FORBIDDEN_AUTHORITY_KEYS as readonly string[]).includes(key));
  }
}
