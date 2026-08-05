import type Database from "better-sqlite3";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 SkillOperationStore（plans/phase-13.md §9.1 / §13.2）
//
// - skill_operations 是安装/更新/回滚/卸载等文件型高风险操作与补偿状态事实
//   （started/completed/failed/compensated），中断可恢复（T10 启动扫描）；
// - 迁移 v11 已建表（T1 冻结），本模块只做读写，不建新表；
// - 领域写入与审计/操作的原子性由上层生命周期（T6/T7 组合根）负责，
//   本 Store 只提供低层单语句方法，不在方法内部开事务。
// ═══════════════════════════════════════════════════════════════

/** skill_operations.kind CHECK 枚举（与 migration v11 一致）。 */
export const SKILL_OPERATION_KINDS = [
  "install",
  "update",
  "rollback",
  "uninstall",
  "bind",
  "unbind",
  "activate",
  "link",
  "unlink",
] as const;
export type SkillOperationKind = (typeof SKILL_OPERATION_KINDS)[number];

/** skill_operations.status CHECK 枚举（与 migration v11 一致）。 */
export const SKILL_OPERATION_STATUSES = ["started", "completed", "failed", "compensated"] as const;
export type SkillOperationStatus = (typeof SKILL_OPERATION_STATUSES)[number];

export interface SkillOperationRecord {
  readonly operationId: string;
  readonly kind: SkillOperationKind;
  readonly sourceRef: string | null;
  readonly agentId: string | null;
  readonly sessionId: string | null;
  readonly status: SkillOperationStatus;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface OperationRow {
  operation_id: string;
  kind: string;
  source_ref: string | null;
  agent_id: string | null;
  session_id: string | null;
  status: string;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

function mapRow(row: OperationRow | undefined): SkillOperationRecord | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    operationId: row.operation_id,
    kind: row.kind as SkillOperationKind,
    sourceRef: row.source_ref,
    agentId: row.agent_id,
    sessionId: row.session_id,
    status: row.status as SkillOperationStatus,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function assertOperationKind(kind: string): asserts kind is SkillOperationKind {
  if (!(SKILL_OPERATION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`不支持的 Skill 操作类型：${kind}`);
  }
}

export class SkillOperationStore {
  constructor(private readonly database: Database.Database) {}

  startOperation(input: {
    readonly operationId: string;
    readonly kind: SkillOperationKind;
    readonly sourceRef?: string;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly createdAt?: string;
  }): void {
    assertOperationKind(input.kind);
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO skill_operations
          (operation_id, kind, source_ref, agent_id, session_id, status, created_at)
         VALUES (@operationId, @kind, @sourceRef, @agentId, @sessionId, 'started', @createdAt)`,
      )
      .run({
        operationId: input.operationId,
        kind: input.kind,
        sourceRef: input.sourceRef ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        createdAt,
      });
  }

  finishOperation(
    operationId: string,
    status: SkillOperationStatus,
    options: { readonly errorCode?: string } = {},
    completedAt = new Date().toISOString(),
  ): void {
    this.database
      .prepare("UPDATE skill_operations SET status = @status, error_code = @errorCode, completed_at = @completedAt WHERE operation_id = @operationId")
      .run({
        operationId,
        status,
        errorCode: options.errorCode ?? null,
        completedAt,
      });
  }

  getOperation(operationId: string): SkillOperationRecord | undefined {
    const row = this.database.prepare("SELECT * FROM skill_operations WHERE operation_id = ?").get(operationId) as OperationRow | undefined;
    return mapRow(row);
  }

  /** 全部未终结操作（T10 启动恢复扫描用）。 */
  findOpenOperations(): SkillOperationRecord[] {
    const rows = this.database.prepare("SELECT * FROM skill_operations WHERE status = 'started' ORDER BY created_at ASC").all() as OperationRow[];
    return rows.map((row) => mapRow(row) as SkillOperationRecord);
  }

  listOperations(): SkillOperationRecord[] {
    const rows = this.database.prepare("SELECT * FROM skill_operations ORDER BY created_at ASC").all() as OperationRow[];
    return rows.map((row) => mapRow(row) as SkillOperationRecord);
  }
}
