import type Database from "better-sqlite3";

import { SubagentStoreError } from "./errors.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：WorkspaceLeaseStore（plans/phase-14.md §18.3 / §16.2 / §16.4 #8）
//
// subagent_workspace_leases 只存当前有效写 Lease（canonical_workspace PK）：
// - acquire：compare-and-set on canonical_workspace + expires_at ——
//   无行 → 插入成功；行已过期或同 bootId 接管 → 更新成功；其他 → 失败（占用）；
// - renew：仅持有者（bootId + ownerId 匹配）且未过期可续租；
// - release：仅持有者可释放（DELETE，compare-and-set on boot+owner）；
// - deleteExpired：启动恢复/housekeeping 清理过期行（§16.2 / §16.5）。
//
// 注：T3 的 WorkspaceMutationLeaseService 自带本表 SQL 存取（不 import 本
// 目录），本 Store 是独立的底层存取实现，供其他调用方复用。
// ═══════════════════════════════════════════════════════════════

export const SUBAGENT_WORKSPACE_LEASE_KINDS = ["subagent_write", "parent_write"] as const;
export type SubagentWorkspaceLeaseKind = (typeof SUBAGENT_WORKSPACE_LEASE_KINDS)[number];

export const SUBAGENT_WORKSPACE_LEASE_OWNER_KINDS = ["subagent", "parent_agent", "system"] as const;
export type SubagentWorkspaceLeaseOwnerKind = (typeof SUBAGENT_WORKSPACE_LEASE_OWNER_KINDS)[number];

export interface SubagentWorkspaceLeaseRecord {
  readonly canonicalWorkspace: string;
  readonly leaseKind: SubagentWorkspaceLeaseKind;
  readonly ownerKind: SubagentWorkspaceLeaseOwnerKind;
  readonly ownerId: string;
  readonly bootId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AcquireWorkspaceLeaseInput {
  readonly canonicalWorkspace: string;
  readonly leaseKind: SubagentWorkspaceLeaseKind;
  readonly ownerKind: SubagentWorkspaceLeaseOwnerKind;
  readonly ownerId: string;
  readonly bootId: string;
  readonly expiresAt: string;
  /** created_at / updated_at 时间戳 */
  readonly now: string;
}

export interface RenewWorkspaceLeaseInput {
  readonly canonicalWorkspace: string;
  readonly bootId: string;
  readonly ownerId: string;
  readonly expiresAt: string;
  readonly now: string;
}

export interface ReleaseWorkspaceLeaseInput {
  readonly canonicalWorkspace: string;
  readonly bootId: string;
  readonly ownerId: string;
}

interface WorkspaceLeaseRow {
  canonical_workspace: string;
  lease_kind: SubagentWorkspaceLeaseKind;
  owner_kind: SubagentWorkspaceLeaseOwnerKind;
  owner_id: string;
  boot_id: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function mapLeaseRow(row: WorkspaceLeaseRow): SubagentWorkspaceLeaseRecord {
  return {
    canonicalWorkspace: row.canonical_workspace,
    leaseKind: row.lease_kind,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    bootId: row.boot_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceLeaseStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * 获取/接管 Lease（compare-and-set on canonical_workspace + expires_at）：
   * - 无现有行 → 插入，返回 true；
   * - 现有行已过期（expires_at <= now）或同 bootId（同一进程重新获取）→ 覆盖，返回 true；
   * - 现有行未过期且 bootId 不同（其他执行者持有）→ 返回 false（占用，fail-closed）。
   */
  acquire(input: AcquireWorkspaceLeaseInput): boolean {
    this.#validate(input.leaseKind, input.ownerKind);
    return this.database
      .transaction(() => {
        const existing = this.database
          .prepare("SELECT * FROM subagent_workspace_leases WHERE canonical_workspace = ?")
          .get(input.canonicalWorkspace) as WorkspaceLeaseRow | undefined;
        if (existing === undefined) {
          this.database
            .prepare(
              `INSERT INTO subagent_workspace_leases
                (canonical_workspace, lease_kind, owner_kind, owner_id, boot_id, expires_at, created_at, updated_at)
               VALUES
                (@canonicalWorkspace, @leaseKind, @ownerKind, @ownerId, @bootId, @expiresAt, @now, @now)`,
            )
            .run({ ...input });
          return true;
        }
        if (existing.boot_id === input.bootId || existing.expires_at <= input.now) {
          this.database
            .prepare(
              `UPDATE subagent_workspace_leases SET
                 lease_kind = @leaseKind,
                 owner_kind = @ownerKind,
                 owner_id = @ownerId,
                 boot_id = @bootId,
                 expires_at = @expiresAt,
                 updated_at = @now
               WHERE canonical_workspace = @canonicalWorkspace`,
            )
            .run({ ...input });
          return true;
        }
        return false;
      })
      .immediate();
  }

  /** 仅持有者（bootId + ownerId 匹配）且未过期可续租；返回是否续租成功 */
  renew(input: RenewWorkspaceLeaseInput): boolean {
    const result = this.database
      .prepare(
        `UPDATE subagent_workspace_leases SET
           expires_at = @expiresAt,
           updated_at = @now
         WHERE canonical_workspace = @canonicalWorkspace
           AND boot_id = @bootId
           AND owner_id = @ownerId
           AND expires_at > @now`,
      )
      .run(input);
    return result.changes > 0;
  }

  /** 仅持有者可释放（compare-and-set on bootId + ownerId）；返回是否释放成功 */
  release(input: ReleaseWorkspaceLeaseInput): boolean {
    const result = this.database
      .prepare(
        `DELETE FROM subagent_workspace_leases
         WHERE canonical_workspace = @canonicalWorkspace
           AND boot_id = @bootId
           AND owner_id = @ownerId`,
      )
      .run(input);
    return result.changes > 0;
  }

  get(canonicalWorkspace: string): SubagentWorkspaceLeaseRecord | null {
    const row = this.database
      .prepare("SELECT * FROM subagent_workspace_leases WHERE canonical_workspace = ?")
      .get(canonicalWorkspace) as WorkspaceLeaseRow | undefined;
    return row === undefined ? null : mapLeaseRow(row);
  }

  /** 当前未过期 Lease 列表 */
  listActive(now: string): SubagentWorkspaceLeaseRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM subagent_workspace_leases WHERE expires_at > ? ORDER BY expires_at ASC")
      .all(now) as WorkspaceLeaseRow[];
    return rows.map(mapLeaseRow);
  }

  /** 过期行清理（§16.2 / §16.5：启动恢复与定期 housekeeping）；返回删除行数 */
  deleteExpired(now: string): number {
    const result = this.database.prepare("DELETE FROM subagent_workspace_leases WHERE expires_at <= ?").run(now);
    return result.changes;
  }

  #validate(leaseKind: SubagentWorkspaceLeaseKind, ownerKind: SubagentWorkspaceLeaseOwnerKind): void {
    if (!(SUBAGENT_WORKSPACE_LEASE_KINDS as readonly string[]).includes(leaseKind)) {
      throw new SubagentStoreError("subagent_operation_failed", `invalid workspace lease kind ${leaseKind}`);
    }
    if (!(SUBAGENT_WORKSPACE_LEASE_OWNER_KINDS as readonly string[]).includes(ownerKind)) {
      throw new SubagentStoreError("subagent_operation_failed", `invalid workspace lease owner kind ${ownerKind}`);
    }
  }
}
