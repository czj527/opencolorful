import crypto from "node:crypto";

import { type Static, Type } from "typebox";

import { SKILL_ERROR_CODES, type SkillErrorCode } from "../../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 一次性确认令牌（plans/phase-13.md §11.4 / §13.2 / §14.2 / §18.5）
//
// - 风险安装、停用、解绑、固定版本迁移必须绑定目标的一次性用户确认；
// - 令牌绑定：sourceRef + 固定版本 + 内容哈希 + agent + session + 操作类型
//   + 过期时间；只能消费一次；
// - consume 校验顺序：不存在 → skill_confirmation_target_mismatch；
//   已消费/重放 → skill_confirmation_reused；过期 → skill_confirmation_expired；
//   目标字段不一致 → skill_confirmation_target_mismatch（fail-closed）；
// - approveSkillAction 是 UI/命令确认入口（只校验 token + agent/session 绑定），
//   consumeConfirmation 是操作执行入口（校验完整目标，防止目标被换）；
// - 内存 registry（T6 不新增 migration；如需跨进程持久化由主 Agent 决定）；
// - 事件：skill.install.confirmation_requested / confirmed / rejected（activity），
//   由核心服务在确认流程各阶段发出，经 Phase 11 SSE 链路自动投影。
// ═══════════════════════════════════════════════════════════════

export const CONFIRMATION_OPERATION_TYPES = [
  "install",
  "unbind",
  "set-selection-disabled",
  "bundle-migrate",
] as const;
export type ConfirmationOperationType = (typeof CONFIRMATION_OPERATION_TYPES)[number];

export const ConfirmationOperationTypeSchema = Type.Union(
  CONFIRMATION_OPERATION_TYPES.map((t) => Type.Literal(t)) as never,
);

/**
 * 确认目标：consume 时逐字段比对（仅比对双方都提供的字段）。
 * 安装确认必须提供 version + contentHash（绑定固定版本与内容哈希）；
 * 解绑/停用/迁移等目标以 sourceRef 承载稳定标识（如 skillRefKey / bundle ref）；
 * sessionId 可选——会话外（CLI/管理页）操作不绑定 Session。
 */
export const ConfirmationTargetSchema = Type.Object(
  {
    sourceRef: Type.String({ minLength: 1, maxLength: 512 }),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    contentHash: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    agentId: Type.String({ minLength: 1, maxLength: 128 }),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    operationType: ConfirmationOperationTypeSchema,
  },
  { additionalProperties: false },
);
export interface ConfirmationTarget {
  readonly sourceRef: string;
  readonly version?: string;
  readonly contentHash?: string;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly operationType: ConfirmationOperationType;
}

/** 确认视图（返回给调用方：不含内部字段，只含展示所需）。 */
export const ConfirmationViewSchema = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 128 }),
    expiresAt: Type.String({ minLength: 1, maxLength: 64 }),
    operationType: ConfirmationOperationTypeSchema,
    reason: Type.String({ minLength: 1, maxLength: 512 }),
    riskLevel: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  },
  { additionalProperties: false },
);
export interface ConfirmationView {
  readonly token: string;
  readonly expiresAt: string;
  readonly operationType: ConfirmationOperationType;
  readonly reason: string;
  readonly riskLevel?: "low" | "medium" | "high";
}

/** 内部记录（含一次性消费状态）。 */
export interface ConfirmationTokenRecord {
  readonly token: string;
  readonly target: ConfirmationTarget;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** UI/命令确认时间（approveSkillAction 成功后写入） */
  readonly approvedAt: string | null;
  /** 操作执行消费时间（consumeConfirmation 成功后写入；一次性） */
  readonly consumedAt: string | null;
  readonly reason: string;
  readonly riskLevel?: "low" | "medium" | "high";
}

export type ConfirmationRejectReasonCode =
  | "skill_confirmation_expired"
  | "skill_confirmation_reused"
  | "skill_confirmation_target_mismatch";

export type ConfirmationOutcome =
  | { readonly status: "approved"; readonly record: ConfirmationTokenRecord }
  | { readonly status: "rejected"; readonly reasonCode: ConfirmationRejectReasonCode; readonly reason: string };

export interface IssueConfirmationInput {
  readonly target: ConfirmationTarget;
  /** 确认原因（风险摘要 / 需要确认的原因） */
  readonly reason: string;
  readonly riskLevel?: "low" | "medium" | "high";
  readonly ttlMs?: number;
}

export interface IssueConfirmationResult {
  readonly token: string;
  readonly expiresAt: string;
}

export interface ConfirmationTokenRegistryDeps {
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class ConfirmationTokenRegistry {
  private readonly registry = new Map<string, ConfirmationTokenRecord>();
  private readonly now: () => Date;
  private readonly defaultTtlMs: number;

  constructor(deps: ConfirmationTokenRegistryDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.defaultTtlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** 签发一次性确认令牌（token 为高熵不透明值；registry 只存内存）。 */
  issue(input: IssueConfirmationInput): IssueConfirmationResult {
    this.assertTarget(input.target);
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new Error("确认原因不能为空");
    }
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs 必须为正数");
    }
    const issuedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    const record: ConfirmationTokenRecord = {
      token: `ct-${crypto.randomUUID()}`,
      target: { ...input.target },
      issuedAt,
      expiresAt,
      approvedAt: null,
      consumedAt: null,
      reason: input.reason,
      ...(input.riskLevel !== undefined ? { riskLevel: input.riskLevel } : {}),
    };
    this.registry.set(record.token, record);
    return { token: record.token, expiresAt };
  }

  /**
   * UI/命令确认入口：校验 token 存在、未消费、未过期，并核对
   * agent/session 绑定（传入时）。成功只标记 approved（证据），
   * 真正的一次性消费在 consumeConfirmation（操作执行前）。
   */
  approveSkillAction(input: { readonly token: string; readonly agentId?: string; readonly sessionId?: string }): ConfirmationOutcome {
    const record = this.registry.get(input.token);
    if (record === undefined) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_target_mismatch",
        reason: "确认令牌不存在或已失效",
      };
    }
    const nowIso = this.now().toISOString();
    if (record.consumedAt !== null || record.approvedAt !== null) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_reused",
        reason: "确认令牌已消费（一次性，禁止重放）",
      };
    }
    if (record.expiresAt < nowIso) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_expired",
        reason: "确认令牌已过期",
      };
    }
    if (input.agentId !== undefined && record.target.agentId !== input.agentId) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_target_mismatch",
        reason: "确认令牌与 Agent 绑定不一致",
      };
    }
    if (input.sessionId !== undefined && record.target.sessionId !== undefined && record.target.sessionId !== input.sessionId) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_target_mismatch",
        reason: "确认令牌与 Session 绑定不一致",
      };
    }
    const approved: ConfirmationTokenRecord = { ...record, approvedAt: nowIso };
    this.registry.set(input.token, approved);
    return { status: "approved", record: approved };
  }

  /**
   * 操作执行入口：校验完整目标（sourceRef/version/contentHash/agent/session/
   * operationType 逐字段比对）+ 必须已通过 approve + 一次性消费。
   * 失败只返回稳定 reasonCode，不返回记录内部细节。
   */
  consumeConfirmation(input: { readonly token: string; readonly target: ConfirmationTarget }): ConfirmationOutcome {
    const record = this.registry.get(input.token);
    if (record === undefined) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_target_mismatch",
        reason: "确认令牌不存在或已失效",
      };
    }
    const nowIso = this.now().toISOString();
    if (record.consumedAt !== null) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_reused",
        reason: "确认令牌已消费（一次性，禁止重放）",
      };
    }
    if (record.expiresAt < nowIso) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_expired",
        reason: "确认令牌已过期",
      };
    }
    if (record.approvedAt === null) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_target_mismatch",
        reason: "确认令牌尚未通过用户确认（approve 未完成）",
      };
    }
    const mismatch = findTargetMismatch(record.target, input.target);
    if (mismatch !== null) {
      return {
        status: "rejected",
        reasonCode: "skill_confirmation_target_mismatch",
        reason: `确认目标已变更（${mismatch}），拒绝执行`,
      };
    }
    const consumed: ConfirmationTokenRecord = { ...record, consumedAt: nowIso };
    this.registry.set(input.token, consumed);
    return { status: "approved", record: consumed };
  }

  /** 只读查询（审计/测试）；返回不可变副本。 */
  get(token: string): ConfirmationTokenRecord | undefined {
    const record = this.registry.get(token);
    return record === undefined ? undefined : { ...record };
  }

  /** 清空注册表（测试隔离 / 服务重启）。 */
  clear(): void {
    this.registry.clear();
  }

  private assertTarget(target: ConfirmationTarget): void {
    if (typeof target.sourceRef !== "string" || target.sourceRef.trim().length === 0) {
      throw new Error("确认目标缺少 sourceRef");
    }
    if (typeof target.agentId !== "string" || target.agentId.trim().length === 0) {
      throw new Error("确认目标缺少 agentId");
    }
    if (!CONFIRMATION_OPERATION_TYPES.includes(target.operationType)) {
      throw new Error(`不支持的操作类型：${String(target.operationType)}`);
    }
  }
}

/** 目标逐字段比对：只比对双方都提供的字段；返回首个不一致字段名或 null。 */
function findTargetMismatch(record: ConfirmationTarget, request: ConfirmationTarget): string | null {
  if (record.sourceRef !== request.sourceRef) {
    return "sourceRef";
  }
  if (record.version !== undefined && request.version !== undefined && record.version !== request.version) {
    return "version";
  }
  if (record.contentHash !== undefined && request.contentHash !== undefined && record.contentHash !== request.contentHash) {
    return "contentHash";
  }
  if (record.agentId !== request.agentId) {
    return "agentId";
  }
  if (record.sessionId !== undefined && request.sessionId !== undefined && record.sessionId !== request.sessionId) {
    return "sessionId";
  }
  if (record.operationType !== request.operationType) {
    return "operationType";
  }
  return null;
}

/** 校验 consume 结果是否为稳定 reasonCode 拒绝（工具层统一映射用）。 */
export function confirmationRejectReasonCode(outcome: ConfirmationOutcome): SkillErrorCode | null {
  if (outcome.status === "approved") {
    return null;
  }
  return outcome.reasonCode as SkillErrorCode;
}

/** 稳定拒绝码全集（测试与文档共用）。 */
export const CONFIRMATION_REJECT_CODES: readonly SkillErrorCode[] = [
  "skill_confirmation_expired",
  "skill_confirmation_reused",
  "skill_confirmation_target_mismatch",
];
