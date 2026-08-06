import crypto from "node:crypto";

import type { EventScope, ExecutorRef } from "../../../contracts/observability.js";
import { skillRefKey, type SkillRef, type SkillSelectionMode } from "../../../contracts/skill-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import type { SkillActivationGrantRecord, SkillActivationGrantStore } from "../../../storage/skill-activation-grant-store.js";
import type { SessionSkillBindingStore } from "../../../storage/session-skill-binding-store.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import { SkillError } from "../errors.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 无 Agent Session 临时绑定与一次性激活授权
// （plans/phase-13.md §9.4 / §10.2 / §11.5 / §13.2）
//
// - 无 Agent Session 不继承 Agent Bundle；只能显式临时绑定或通过
//   一次性激活授权使用精确 SkillRef；
// - bindTemporary：session_skill_bindings（expires_at 由 ttlMs 给出），
//   Session 结束**不自动升级**为 Agent 持久绑定；
// - issueActivationGrant：当前 turn 的 append-only 精确覆盖层（不修改
//   已开始的 Snapshot、不扩大任何平台权限）；一次性 + 过期；
// - consumeActivationGrant 拒绝路径返回稳定 reasonCode：
//   skill_activation_expired / skill_activation_reused / skill_activation_denied；
// - 事件：skill.activation.granted / consumed / expired / rejected（activity）。
// ═══════════════════════════════════════════════════════════════

export interface SessionSkillServiceDeps {
  readonly catalog: SkillCatalog;
  readonly sessionBindings: SessionSkillBindingStore;
  readonly grants: SkillActivationGrantStore;
  readonly now?: () => Date;
}

export interface BindTemporaryInput {
  readonly sessionId: string;
  readonly skillRef: SkillRef;
  readonly selection?: SkillSelectionMode;
  /** 临时绑定有效时长（ms）；缺省不过期 */
  readonly ttlMs?: number;
}

export interface TemporaryBindingResult {
  readonly sessionId: string;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface SessionSkillsView {
  readonly sessionId: string;
  readonly active: readonly SessionSkillBindingView[];
  readonly expired: readonly SessionSkillBindingView[];
}

export interface SessionSkillBindingView {
  readonly sessionId: string;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface IssueActivationGrantInput {
  readonly agentId: string;
  readonly sessionId: string;
  readonly skillRef: SkillRef;
  readonly issuedTurnId: string;
  readonly ttlMs: number;
  readonly reason?: string;
}

export interface ConsumeActivationGrantInput {
  readonly grantId: string;
  readonly sessionId: string;
  readonly skillRef: SkillRef;
  readonly contentHash: string;
}

export type ConsumeActivationGrantResult =
  | { readonly status: "consumed"; readonly grant: SkillActivationGrantRecord }
  | { readonly status: "rejected"; readonly grant: SkillActivationGrantRecord | null; readonly reasonCode: "skill_activation_expired" | "skill_activation_reused" | "skill_activation_denied"; readonly reason: string };

const EXECUTOR: ExecutorRef = { kind: "service", id: "skill-session" };
const PERSISTED_SELECTIONS = new Set<SkillSelectionMode>(["implicit", "explicit-only", "disabled"]);

export class SessionSkillService {
  private readonly now: () => Date;

  constructor(private readonly deps: SessionSkillServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 无 Agent Session 临时绑定（TTL 到期自动失效；不自动升级为持久绑定）。 */
  bindTemporary(input: BindTemporaryInput): TemporaryBindingResult {
    this.validateSessionId(input.sessionId);
    const registered = this.deps.catalog.resolveBySkillRef(input.skillRef);
    const selection = input.selection ?? "implicit";
    if (!PERSISTED_SELECTIONS.has(selection)) {
      throw new SkillError("skill_operation_failed", `不支持的选择模式：${String(selection)}`);
    }
    const now = this.now();
    const expiresAt = input.ttlMs !== undefined ? new Date(now.getTime() + input.ttlMs).toISOString() : undefined;
    const createdAt = now.toISOString();
    const skillRefKeyOf = skillRefKey(registered.skillRef);
    this.deps.sessionBindings.upsert({
      sessionId: input.sessionId,
      skillRefKey: skillRefKeyOf,
      selection,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      createdAt,
    });
    return {
      sessionId: input.sessionId,
      skillRefKey: skillRefKeyOf,
      selection,
      expiresAt: expiresAt ?? null,
      createdAt,
    };
  }

  /** 当前 Session 可见 Skill 列表（临时绑定；过期项单独列出不进入可见集）。 */
  listSessionSkills(sessionId: string): SessionSkillsView {
    this.validateSessionId(sessionId);
    const nowIso = this.now().toISOString();
    const all = this.deps.sessionBindings.listBySession(sessionId);
    const active: SessionSkillBindingView[] = [];
    const expired: SessionSkillBindingView[] = [];
    for (const binding of all) {
      if (binding.expiresAt !== null && binding.expiresAt < nowIso) {
        expired.push(binding);
      } else {
        active.push(binding);
      }
    }
    return { sessionId, active, expired };
  }

  /**
   * T10：当前 Session 未消费且未过期的激活授权（turn 快照冻结摘要用）。
   * 只暴露摘要字段（grantId/skillRefKey/contentHash/issuedTurnId/expiresAt/consumedAt），
   * 不暴露任何 Secret 或正文。
   */
  listActiveGrants(sessionId: string): readonly SkillActivationGrantRecord[] {
    this.validateSessionId(sessionId);
    const nowIso = this.now().toISOString();
    return this.deps.grants.listBySession(sessionId).filter(
      (grant) => grant.consumedAt === null && grant.expiresAt > nowIso,
    );
  }

  /**
   * 签发一次性激活授权（会话内安装后当前 turn 立即使用）。
   * grant 绑定 agentId + sessionId + skillRefKey + contentHash + issuedTurnId。
   */
  issueActivationGrant(input: IssueActivationGrantInput): SkillActivationGrantRecord {
    this.validateSessionId(input.sessionId);
    const registered = this.deps.catalog.resolveBySkillRef(input.skillRef);
    const grantId = `grant-${crypto.randomUUID()}`;
    const expiresAt = new Date(this.now().getTime() + input.ttlMs).toISOString();
    const grant: SkillActivationGrantRecord = {
      grantId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      skillRefKey: skillRefKey(registered.skillRef),
      contentHash: registered.contentHash,
      issuedTurnId: input.issuedTurnId,
      expiresAt,
      consumedAt: null,
      reason: input.reason ?? "session-install",
    };
    this.deps.grants.insert(grant);
    const scope: EventScope = { ownerAgentId: input.agentId, sessionId: input.sessionId, turnId: input.issuedTurnId };
    instrument.activity({
      eventName: "skill.activation.granted",
      actor: { kind: "system", id: "skill-session" },
      executor: EXECUTOR,
      scope,
      payload: {
        summaryCode: "skill_activation_granted",
        attributes: {
          grantId,
          skillRefKey: grant.skillRefKey,
          contentHash: grant.contentHash.slice(0, 24),
          issuedTurnId: input.issuedTurnId,
          reason: grant.reason.slice(0, 96),
        },
      },
    });
    return grant;
  }

  /**
   * 消费一次性激活授权。拒绝路径（fail-closed，不吞错误）：
   * - 不存在 → skill_activation_denied；
   * - 已消费（含并发重放）→ skill_activation_reused；
   * - 已过期 → skill_activation_expired（消费被拒绝，grant 保留证据）；
   * - Session / skillRefKey / contentHash 不匹配 → skill_activation_denied。
   */
  consumeActivationGrant(input: ConsumeActivationGrantInput): ConsumeActivationGrantResult {
    this.validateSessionId(input.sessionId);
    const grant = this.deps.grants.get(input.grantId);
    if (grant === null) {
      throw new SkillError("skill_activation_denied", `激活授权不存在：${input.grantId}`);
    }
    const consumedAt = this.now().toISOString();
    if (grant.consumedAt !== null) {
      this.emitRejected("skill_activation_reused", grant, input.sessionId);
      return { status: "rejected", grant, reasonCode: "skill_activation_reused", reason: "激活授权已消费（一次性，禁止重放）" };
    }
    if (grant.expiresAt < consumedAt) {
      this.emitRejected("skill_activation_expired", grant, input.sessionId);
      return { status: "rejected", grant, reasonCode: "skill_activation_expired", reason: "激活授权已过期" };
    }
    if (grant.sessionId !== input.sessionId) {
      this.emitRejected("skill_activation_denied", grant, input.sessionId);
      return { status: "rejected", grant, reasonCode: "skill_activation_denied", reason: "激活授权与当前 Session 不一致" };
    }
    const requestKey = skillRefKey(input.skillRef);
    if (grant.skillRefKey !== requestKey || grant.contentHash !== input.contentHash) {
      this.emitRejected("skill_activation_denied", grant, input.sessionId);
      return { status: "rejected", grant, reasonCode: "skill_activation_denied", reason: "激活授权目标（skillRef/contentHash）与请求不一致" };
    }
    if (!this.deps.grants.markConsumed(input.grantId, consumedAt)) {
      // 并发竞争：另一消费者已抢先消费
      const latest = this.deps.grants.get(input.grantId);
      this.emitRejected("skill_activation_reused", latest ?? grant, input.sessionId);
      return { status: "rejected", grant: latest ?? grant, reasonCode: "skill_activation_reused", reason: "激活授权已被并发消费" };
    }
    const consumed: SkillActivationGrantRecord = { ...grant, consumedAt };
    const scope: EventScope = { ownerAgentId: grant.agentId, sessionId: input.sessionId };
    instrument.activity({
      eventName: "skill.activation.consumed",
      actor: { kind: "system", id: "skill-session" },
      executor: EXECUTOR,
      scope,
      payload: {
        summaryCode: "skill_activation_consumed",
        attributes: { grantId: input.grantId, skillRefKey: grant.skillRefKey, issuedTurnId: grant.issuedTurnId },
      },
    });
    return { status: "consumed", grant: consumed };
  }

  /**
   * T12（P1-2）：撤销一次性激活授权（补偿路径）——loadHandle 签发失败等后续
   * 步骤异常时调用，把刚签发的 grant 标记为已消费（append-only 证据保留，
   * listActiveGrants 不再返回），并记录 skill.activation.revoked 事件。
   * 撤销失败抛错（fail-closed：不得静默保留"结果失败但授权仍有效"的状态）。
   */
  revokeActivationGrant(input: { readonly grantId: string; readonly sessionId: string; readonly reason?: string }): void {
    this.validateSessionId(input.sessionId);
    const revokedAt = this.now().toISOString();
    if (!this.deps.grants.markConsumed(input.grantId, revokedAt)) {
      throw new SkillError("skill_activation_denied", `激活授权撤销失败：${input.grantId}（不存在或已被消费）`);
    }
    const scope: EventScope = { sessionId: input.sessionId };
    instrument.activity({
      eventName: "skill.activation.revoked",
      actor: { kind: "system", id: "skill-session" },
      executor: EXECUTOR,
      scope,
      payload: {
        summaryCode: "skill_activation_revoked",
        attributes: {
          grantId: input.grantId,
          ...(input.reason !== undefined ? { reason: input.reason.slice(0, 96) } : {}),
        },
      },
    });
  }

  // ── 内部辅助 ─────────────────────────────────────────────────

  private emitRejected(reasonCode: "skill_activation_expired" | "skill_activation_reused" | "skill_activation_denied", grant: SkillActivationGrantRecord, sessionId: string): void {
    // 过期走 skill.activation.expired；重放/目标不一致走 skill.activation.rejected
    const eventName = reasonCode === "skill_activation_expired" ? "skill.activation.expired" : "skill.activation.rejected";
    const scope: EventScope = { ownerAgentId: grant.agentId, sessionId };
    instrument.activity({
      eventName,
      actor: { kind: "system", id: "skill-session" },
      executor: EXECUTOR,
      scope,
      payload: {
        summaryCode: "skill_activation_" + reasonCode.replace("skill_activation_", ""),
        attributes: { grantId: grant.grantId, skillRefKey: grant.skillRefKey, reasonCode },
      },
    });
  }

  private validateSessionId(sessionId: string): void {
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 128) {
      throw new SkillError("skill_operation_failed", "Session ID 不合法");
    }
  }
}
