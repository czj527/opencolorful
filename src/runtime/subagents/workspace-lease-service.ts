import { WorkspaceLeaseStore, type SubagentWorkspaceLeaseKind, type SubagentWorkspaceLeaseOwnerKind, type SubagentWorkspaceLeaseRecord } from "./stores/workspace-lease-store.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T3：WorkspaceMutationLeaseService（plans/phase-14.md §18.3）
//
// 基于 WorkspaceLeaseStore（T2，subagent_workspace_leases 表）的工作区写
// Lease 业务层：
// - read-only Subagent Run 不获取 mutation lease；
// - write Subagent Run 获取 run-scoped 独占长 Lease（subagent_write）；
// - 父 Agent 普通写 Tool 获取 operation-scoped 短 permit（parent_write）；
// - 同一 canonical workspace 同一时间只有一个有效持有者——父 Agent 与
//   Subagent 写互斥（子 Run 持有时父写被拒，反之亦然）；
// - 获取/续租/释放均为事务内 compare-and-set（Store 实现）；过期行由
//   acquire 接管或 cleanupExpired 清理；Host 崩溃后依靠 TTL 释放。
//
// 底层 SQLite 存取统一收敛在 WorkspaceLeaseStore（唯一路径，避免约束漂移）。
// ═══════════════════════════════════════════════════════════════

/** write Subagent Run 独占长 Lease 默认 TTL（§18.3：独占长 Lease，运行中续租） */
export const SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS = 30 * 60_000;
/** 父 Agent 写 Tool operation-scoped 短 permit 默认 TTL */
export const PARENT_WRITE_LEASE_DEFAULT_TTL_MS = 60_000;

export type { SubagentWorkspaceLeaseKind as WorkspaceLeaseKind, SubagentWorkspaceLeaseOwnerKind as WorkspaceLeaseOwnerKind, SubagentWorkspaceLeaseRecord as WorkspaceLease };

export interface WorkspaceLeaseRequest {
  readonly leaseKind: SubagentWorkspaceLeaseKind;
  readonly ownerKind: SubagentWorkspaceLeaseOwnerKind;
  readonly ownerId: string;
  readonly bootId: string;
  readonly ttlMs: number;
}

export type WorkspaceLeaseAcquireResult =
  | { readonly status: "acquired"; readonly lease: SubagentWorkspaceLeaseRecord }
  | { readonly status: "denied"; readonly heldBy: SubagentWorkspaceLeaseRecord; readonly reason: string };

export type WorkspaceLeaseRenewResult =
  | { readonly status: "renewed"; readonly lease: SubagentWorkspaceLeaseRecord }
  | { readonly status: "lost"; readonly reason: string };

export type WorkspaceLeaseReleaseResult =
  | { readonly status: "released" }
  | { readonly status: "not_held"; readonly reason: string };

export interface WorkspaceMutationLeaseOptions {
  /** 时钟注入（测试用），默认 Date.now */
  readonly now?: () => number;
}

export class WorkspaceMutationLeaseService {
  private readonly now: () => number;

  constructor(
    private readonly store: WorkspaceLeaseStore,
    options: WorkspaceMutationLeaseOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前有效租约（过期行视为不存在）；无租约返回 null */
  get(canonicalWorkspace: string): SubagentWorkspaceLeaseRecord | null {
    const lease = this.store.get(canonicalWorkspace);
    if (lease === null || Date.parse(lease.expiresAt) <= this.now()) {
      return null;
    }
    return lease;
  }

  /**
   * 获取独占写 Lease（Store compare-and-set，单事务）。
   * 无行 → acquired；已过期或同 bootId 且同 ownerId（同一进程同一持有者重新
   * 获取）→ 接管；未过期且 bootId 不同 → denied（其他执行者持有，返回 heldBy）。
   *
   * T9b（§18.3 互斥补强）：同一 bootId 但不同 ownerId（同进程内父 Agent 与
   * Subagent 是两个持有者）也 → denied——否则单进程内父写 permit 会被子 Run
   * 同 bootId 接管，互斥失效。
   */
  acquire(canonicalWorkspace: string, request: WorkspaceLeaseRequest): WorkspaceLeaseAcquireResult {
    const nowMs = this.now();
    // 同进程（同 bootId）不同持有者：直接拒绝，不让 Store 的"同 bootId 接管"生效
    const held = this.get(canonicalWorkspace);
    if (held !== null && held.bootId === request.bootId && held.ownerId !== request.ownerId) {
      return {
        status: "denied",
        heldBy: held,
        reason: `工作区 ${canonicalWorkspace} 已被 ${held.ownerKind}（${held.ownerId}）持有写 Lease（同进程不同持有者互斥）`,
      };
    }
    const acquired = this.store.acquire({
      canonicalWorkspace,
      leaseKind: request.leaseKind,
      ownerKind: request.ownerKind,
      ownerId: request.ownerId,
      bootId: request.bootId,
      expiresAt: new Date(nowMs + request.ttlMs).toISOString(),
      now: new Date(nowMs).toISOString(),
    });
    if (acquired) {
      const lease = this.store.get(canonicalWorkspace);
      if (lease === null) {
        return { status: "denied", heldBy: this.placeholderLease(canonicalWorkspace, request), reason: "获取后租约不可读（存储异常），fail-closed" };
      }
      return { status: "acquired", lease };
    }
    const heldBy = this.store.get(canonicalWorkspace);
    if (heldBy === null) {
      return { status: "denied", heldBy: this.placeholderLease(canonicalWorkspace, request), reason: `工作区 ${canonicalWorkspace} 写 Lease 获取失败（无可见持有者）` };
    }
    return {
      status: "denied",
      heldBy,
      reason: `工作区 ${canonicalWorkspace} 已被 ${heldBy.ownerKind}（${heldBy.ownerId}）持有写 Lease`,
    };
  }

  /**
   * 续租（compare-and-set）：只有当前持有者（ownerId + bootId 匹配）且
   * 租约未过期时才延长；其余情况返回 lost（已过期/被接管/从未持有）。
   */
  renew(canonicalWorkspace: string, ownerId: string, bootId: string, ttlMs: number): WorkspaceLeaseRenewResult {
    const nowMs = this.now();
    const renewed = this.store.renew({
      canonicalWorkspace,
      bootId,
      ownerId,
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      now: new Date(nowMs).toISOString(),
    });
    if (renewed) {
      const lease = this.store.get(canonicalWorkspace);
      if (lease === null) {
        return { status: "lost", reason: "续租后租约不可读（存储异常），fail-closed" };
      }
      return { status: "renewed", lease };
    }
    return { status: "lost", reason: "当前调用方不持有该工作区有效写 Lease（已过期/被接管/从未持有）" };
  }

  /** 释放租约（compare-and-set）：仅持有者（ownerId + bootId 匹配）可释放 */
  release(canonicalWorkspace: string, ownerId: string, bootId: string): WorkspaceLeaseReleaseResult {
    const released = this.store.release({ canonicalWorkspace, bootId, ownerId });
    if (released) {
      return { status: "released" };
    }
    return { status: "not_held", reason: "当前调用方不持有该工作区写 Lease（已被释放或归属他人）" };
  }

  /** 清理全部过期租约（启动恢复与定期 housekeeping 调用）；返回清理条数 */
  cleanupExpired(): number {
    return this.store.deleteExpired(new Date(this.now()).toISOString());
  }

  private placeholderLease(canonicalWorkspace: string, request: WorkspaceLeaseRequest): SubagentWorkspaceLeaseRecord {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    return {
      canonicalWorkspace,
      leaseKind: request.leaseKind,
      ownerKind: request.ownerKind,
      ownerId: request.ownerId,
      bootId: request.bootId,
      expiresAt: new Date(nowMs + request.ttlMs).toISOString(),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }
}
