import crypto from "node:crypto";

import Value from "typebox/value";

import {
  SkillLoadHandleSchema,
  skillRefKey,
  type SkillLoadHandle,
  type SkillRef,
} from "../../../contracts/skill-protocol.js";
import { SkillError, assertSkillRef } from "../errors.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 loadHandle 受控读取（plans/phase-13.md §10.2 / §18.4）
//
// - 单 turn 一次性受控读取入口：绑定 turnId + sessionId + skillRef + contentHash；
// - issueLoadHandle：签发（TTL）；consumeLoadHandle：单次有效；
// - 过期（skill_load_handle_expired）/已消费或重放（skill_load_handle_consumed）
//   /绑定不符或不存在（skill_content_read_denied）→ 只返回失效诊断，不返回正文；
// - turn 结束（invalidateTurn）→ 该 turn 全部 handle 失效（过期语义）；
// - 每次读取仍经 SkillContentService 完整哈希/预算/审计校验（本模块不做正文读取）；
// - 跨边界输出过 SkillLoadHandleSchema（T1 冻结 TypeBox 契约）。
// ═══════════════════════════════════════════════════════════════

export interface IssueLoadHandleInput {
  readonly turnId: string;
  readonly sessionId: string;
  readonly skillRef: SkillRef;
  readonly contentHash: string;
  readonly ttlMs: number;
}

export interface ConsumeLoadHandleInput {
  readonly handleId: string;
  readonly turnId: string;
  readonly sessionId: string;
}

export type ConsumeLoadHandleResult =
  | { readonly status: "granted"; readonly handle: SkillLoadHandle }
  | {
      readonly status: "rejected";
      readonly reasonCode: "skill_load_handle_expired" | "skill_load_handle_consumed" | "skill_content_read_denied";
      readonly reason: string;
      readonly handle: SkillLoadHandle | null;
    };

/** 注册表内部记录：冻结契约字段 + turn 结束撤销标记。 */
interface RegistryRecord {
  readonly handle: SkillLoadHandle;
  readonly revokedAt?: string;
}

export interface LoadHandleRegistryDeps {
  readonly now?: () => Date;
}

export class LoadHandleRegistry {
  private readonly registry = new Map<string, RegistryRecord>();
  private readonly now: () => Date;

  constructor(deps: LoadHandleRegistryDeps = {}) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 签发单 turn 一次性 loadHandle。输入 skillRef 过冻结 Schema（fail-closed）。
   * 安装流程（T6）在激活授权消费后调用，把结果交给模型受控读取入口。
   */
  issueLoadHandle(input: IssueLoadHandleInput): SkillLoadHandle {
    const ref = assertSkillRef(input.skillRef);
    this.validateId(input.turnId, "turnId");
    this.validateId(input.sessionId, "sessionId");
    if (typeof input.contentHash !== "string" || input.contentHash.length < 1 || input.contentHash.length > 64) {
      throw new SkillError("skill_operation_failed", "contentHash 不合法");
    }
    if (input.contentHash !== ref.contentHash) {
      throw new SkillError("skill_operation_failed", "contentHash 与 SkillRef 内容哈希不一致");
    }
    if (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new SkillError("skill_operation_failed", "ttlMs 必须为正数");
    }
    const now = this.now();
    const handle: SkillLoadHandle = {
      handleId: `load-${crypto.randomUUID()}`,
      turnId: input.turnId,
      sessionId: input.sessionId,
      skillRef: ref,
      contentHash: ref.contentHash,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      consumed: false,
    };
    if (!Value.Check(SkillLoadHandleSchema, handle)) {
      throw new SkillError("skill_operation_failed", "loadHandle 不符合冻结契约 schema");
    }
    this.registry.set(handle.handleId, { handle });
    return { ...handle };
  }

  /**
   * 消费 loadHandle（单次有效）。过期/重放/绑定不符只返回失效诊断，
   * 绝不返回正文或绕过 ContentService 的信息。
   */
  consumeLoadHandle(input: ConsumeLoadHandleInput): ConsumeLoadHandleResult {
    this.validateId(input.turnId, "turnId");
    this.validateId(input.sessionId, "sessionId");
    const record = this.registry.get(input.handleId);
    if (record === undefined) {
      return {
        status: "rejected",
        reasonCode: "skill_content_read_denied",
        reason: "loadHandle 不存在或已被清理",
        handle: null,
      };
    }
    const { handle } = record;
    const nowIso = this.now().toISOString();
    if (record.revokedAt !== undefined || handle.expiresAt < nowIso) {
      return {
        status: "rejected",
        reasonCode: "skill_load_handle_expired",
        reason: "loadHandle 已过期（turn 结束或 TTL 到期）",
        handle: { ...handle },
      };
    }
    if (handle.consumed) {
      return {
        status: "rejected",
        reasonCode: "skill_load_handle_consumed",
        reason: "loadHandle 已消费（一次性，禁止重放）",
        handle: { ...handle },
      };
    }
    if (handle.turnId !== input.turnId || handle.sessionId !== input.sessionId) {
      return {
        status: "rejected",
        reasonCode: "skill_content_read_denied",
        reason: "loadHandle 与当前 turn/session 绑定不符",
        handle: { ...handle },
      };
    }
    const consumed: SkillLoadHandle = { ...handle, consumed: true };
    this.registry.set(input.handleId, { handle: consumed });
    return { status: "granted", handle: consumed };
  }

  /**
   * turn 结束清理：该 turn 全部 handle 标记撤销（后续消费 → 过期诊断）。
   * 返回受影响 handle 数量。
   */
  invalidateTurn(turnId: string): number {
    this.validateId(turnId, "turnId");
    let count = 0;
    const revokedAt = this.now().toISOString();
    for (const [handleId, record] of this.registry) {
      if (record.handle.turnId === turnId && record.revokedAt === undefined) {
        this.registry.set(handleId, { ...record, revokedAt });
        count += 1;
      }
    }
    return count;
  }

  /** 只读查询（审计/测试）；返回不可变副本。 */
  get(handleId: string): SkillLoadHandle | undefined {
    const record = this.registry.get(handleId);
    return record === undefined ? undefined : { ...record.handle };
  }

  /** 清空注册表（测试隔离）。 */
  clear(): void {
    this.registry.clear();
  }

  private validateId(value: string, what: string): void {
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new SkillError("skill_operation_failed", `${what} 不合法`);
    }
  }
}

/** 便捷：turn 内一次读取的完整校验链（registry 消费 + ContentService 绑定校验）。 */
export function assertLoadHandleMatches(handle: SkillLoadHandle, skillRef: SkillRef, contentHash: string): void {
  if (skillRefKey(handle.skillRef) !== skillRefKey(skillRef) || handle.contentHash !== contentHash) {
    throw new SkillError("skill_content_read_denied", "loadHandle 与目标 SkillRef 绑定不符，已拒绝");
  }
}
