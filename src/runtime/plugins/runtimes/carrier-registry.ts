import crypto from "node:crypto";

import Value from "typebox/value";

import { PluginIpcCarrierSchema, type PluginIpcCarrier } from "../../../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 一次性 IPC token（plans/phase-12.md §9.2 / §17.4）
//
// - 平台向 worker 签发只读、短期、一次性 trace carrier；
// - carrier 绑定 pluginId + runtimeInstanceId + operationId，单次消费；
// - 重复使用、过期、跨实例/跨操作复用一律拒绝；
// - worker 回传的 actor/executor/scope/trace/eventId 一律不可信，
//   本注册表只认证"这次调用是否真的是该运行实例发出的"；
//   Host 对执行结果的权威字段重新盖章（见 runtime-host.ts）。
// ═══════════════════════════════════════════════════════════════

export const CARRIER_DEFAULT_TTL_MS = 30_000;

export interface CarrierIssueInput {
  readonly pluginId: string;
  readonly runtimeInstanceId: string;
  readonly operationId: string;
  /** 可覆盖的 TTL（毫秒）；缺省 30s */
  readonly ttlMs?: number;
  /** 可覆盖的只读 traceId/spanId（缺省平台新生成） */
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface CarrierRegistryDeps {
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

export type CarrierConsumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid-schema" | "unknown-token" | "expired" | "already-consumed" | "mismatch"; readonly reason: string };

interface IssuedCarrier {
  readonly pluginId: string;
  readonly runtimeInstanceId: string;
  readonly operationId: string;
  readonly token: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  consumed: boolean;
}

export class CarrierRegistry {
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly tokens = new Map<string, IssuedCarrier>();

  constructor(deps: CarrierRegistryDeps = {}) {
    this.ttlMs = deps.ttlMs ?? CARRIER_DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => new Date());
    this.tokenFactory = deps.tokenFactory ?? (() => crypto.randomBytes(24).toString("hex"));
  }

  /** 平台签发一次性 carrier（绑定插件/实例/操作三要素）。 */
  issue(input: CarrierIssueInput): PluginIpcCarrier {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + (input.ttlMs ?? this.ttlMs));
    const token = this.tokenFactory();
    const traceId = input.traceId ?? `trace-${crypto.randomUUID()}`;
    const spanId = input.spanId ?? `span-${crypto.randomUUID()}`;
    const carrier: PluginIpcCarrier = {
      pluginId: input.pluginId,
      runtimeInstanceId: input.runtimeInstanceId,
      operationId: input.operationId,
      token,
      traceId,
      spanId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    if (!Value.Check(PluginIpcCarrierSchema, carrier)) {
      throw new Error("签发的 IPC carrier 不符合协议 schema");
    }
    this.tokens.set(token, {
      pluginId: carrier.pluginId,
      runtimeInstanceId: carrier.runtimeInstanceId,
      operationId: carrier.operationId,
      token,
      issuedAtMs: issuedAt.getTime(),
      expiresAtMs: expiresAt.getTime(),
      consumed: false,
    });
    return carrier;
  }

  /** 非消费性校验（供 Host 内部判断，不改变单次消费语义；已消费/过期同样报告不可用）。 */
  validate(carrier: unknown): { readonly ok: boolean; readonly reason?: string } {
    if (!isCarrierObject(carrier)) {
      return { ok: false, reason: "carrier 不是对象或不符合协议 schema" };
    }
    const record = this.tokens.get(carrier.token);
    if (record === undefined) {
      return { ok: false, reason: "token 未签发或已失效" };
    }
    if (this.now().getTime() > record.expiresAtMs) {
      return { ok: false, reason: "token 已过期" };
    }
    if (record.consumed) {
      return { ok: false, reason: "token 已被消费" };
    }
    const mismatch = this.bindingMismatch(record, carrier);
    if (mismatch !== null) {
      return { ok: false, reason: mismatch };
    }
    return { ok: true };
  }

  /**
   * 单次消费：worker 回传 carrier（通知/请求）时校验并一次性消费。
   * 重复使用、跨实例/跨操作、过期、未签发一律拒绝。
   */
  consume(carrier: unknown): CarrierConsumeResult {
    if (!isCarrierObject(carrier)) {
      return { ok: false, code: "invalid-schema", reason: "carrier 不是对象或不符合协议 schema" };
    }
    const record = this.tokens.get(carrier.token);
    if (record === undefined) {
      return { ok: false, code: "unknown-token", reason: "token 未签发或已失效" };
    }
    if (this.now().getTime() > record.expiresAtMs) {
      return { ok: false, code: "expired", reason: "token 已过期" };
    }
    if (record.consumed) {
      return { ok: false, code: "already-consumed", reason: "token 已被消费，拒绝重复使用" };
    }
    const mismatch = this.bindingMismatch(record, carrier);
    if (mismatch !== null) {
      return { ok: false, code: "mismatch", reason: mismatch };
    }
    record.consumed = true;
    return { ok: true };
  }

  /** 操作结束（终态/取消）时回收该操作的 token；幂等。 */
  revokeOperation(pluginId: string, runtimeInstanceId: string, operationId: string): void {
    for (const [token, record] of this.tokens) {
      if (record.pluginId === pluginId && record.runtimeInstanceId === runtimeInstanceId && record.operationId === operationId) {
        this.tokens.delete(token);
      }
    }
  }

  /** 清理过期 token（RuntimeHost 每次启动/停止时调用；返回清理数量）。 */
  sweepExpired(): number {
    const nowMs = this.now().getTime();
    let removed = 0;
    for (const [token, record] of this.tokens) {
      if (nowMs > record.expiresAtMs) {
        this.tokens.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  /** 当前未消费 token 数（诊断/测试）。 */
  size(): number {
    return this.tokens.size;
  }

  private bindingMismatch(record: IssuedCarrier, carrier: PluginIpcCarrier): string | null {
    if (record.pluginId !== carrier.pluginId) {
      return "token 绑定的插件与 carrier 不一致（跨插件复用拒绝）";
    }
    if (record.runtimeInstanceId !== carrier.runtimeInstanceId) {
      return "token 绑定的运行实例与 carrier 不一致（跨实例复用拒绝）";
    }
    if (record.operationId !== carrier.operationId) {
      return "token 绑定的操作与 carrier 不一致（跨操作复用拒绝）";
    }
    return null;
  }
}

function isCarrierObject(value: unknown): value is PluginIpcCarrier {
  return typeof value === "object" && value !== null && Value.Check(PluginIpcCarrierSchema, value);
}
