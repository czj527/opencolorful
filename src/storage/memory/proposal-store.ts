import type Database from "better-sqlite3";
import type {
  MemoryMutationProposal,
  MemoryProposalStatus,
  MemoryProposalType,
  MemoryRecallTargetType,
} from "../../contracts/memory.js";

interface ProposalRow {
  id: string; agent_id: string; run_id: string; type: string;
  target_type: string | null; target_id: string | null; payload: string;
  previous_state: string | null; evidence_refs: string; reason: string;
  confidence: number; status: string; policy_reason: string | null;
  created_at: string; applied_at: string | null;
}

function mapRow(row: ProposalRow): MemoryMutationProposal {
  return {
    id: row.id, agentId: row.agent_id, runId: row.run_id,
    type: row.type as MemoryProposalType,
    ...(row.target_type !== null ? { targetType: row.target_type as MemoryRecallTargetType } : {}),
    ...(row.target_id !== null ? { targetId: row.target_id } : {}),
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    ...(row.previous_state !== null ? { previousState: JSON.parse(row.previous_state) as Record<string, unknown> } : {}),
    evidenceRefs: JSON.parse(row.evidence_refs) as readonly string[], reason: row.reason,
    confidence: row.confidence, status: row.status as MemoryProposalStatus,
    ...(row.policy_reason !== null ? { policyReason: row.policy_reason } : {}),
    createdAt: row.created_at, ...(row.applied_at !== null ? { appliedAt: row.applied_at } : {}),
  };
}

export interface MemoryProposalInput {
  id: string; agentId: string; runId: string; type: MemoryProposalType;
  targetType?: MemoryRecallTargetType; targetId?: string;
  payload: Record<string, unknown>; previousState?: Record<string, unknown>;
  evidenceRefs: readonly string[]; reason: string; confidence: number;
}

export class MemoryProposalStore {
  constructor(private readonly database: Database.Database) {}

  createProposal(input: MemoryProposalInput): MemoryMutationProposal {
    const createdAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO memory_mutation_proposals
      (id, agent_id, run_id, type, target_type, target_id, payload, previous_state,
       evidence_refs, reason, confidence, status, created_at)
      VALUES (@id,@agentId,@runId,@type,@targetType,@targetId,@payload,@previousState,
       @evidenceRefs,@reason,@confidence,'pending',@createdAt)`).run({
      id: input.id, agentId: input.agentId, runId: input.runId, type: input.type,
      targetType: input.targetType ?? null, targetId: input.targetId ?? null,
      payload: JSON.stringify(input.payload), previousState: input.previousState ? JSON.stringify(input.previousState) : null,
      evidenceRefs: JSON.stringify(input.evidenceRefs), reason: input.reason,
      confidence: input.confidence, createdAt,
    });
    return this.getById(input.id) as MemoryMutationProposal;
  }

  getById(id: string): MemoryMutationProposal | undefined {
    const row = this.database.prepare("SELECT * FROM memory_mutation_proposals WHERE id = ?").get(id) as ProposalRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByRun(runId: string): MemoryMutationProposal[] { return this.list("run_id = ?", [runId]); }
  listPendingByAgent(agentId: string): MemoryMutationProposal[] { return this.list("agent_id = ? AND status = 'pending'", [agentId]); }
  listAppliedByRun(runId: string): MemoryMutationProposal[] { return this.list("run_id = ? AND status = 'applied'", [runId]); }

  /** 应用后回写负载（applyMutation 生成的 createdFactId/newFactId/mergedFactId 等），
   *  供回滚依据 stored payload 定位新建事实 */
  updatePayload(id: string, payload: Record<string, unknown>): MemoryMutationProposal {
    const result = this.database.prepare("UPDATE memory_mutation_proposals SET payload = ? WHERE id = ?")
      .run(JSON.stringify(payload), id);
    if (result.changes !== 1) throw new Error(`提案不存在: ${id}`);
    return this.getById(id) as MemoryMutationProposal;
  }

  markStatus(id: string, status: MemoryProposalStatus, opts?: { policyReason?: string; appliedAt?: string }): MemoryMutationProposal {
    const appliedAt = opts?.appliedAt ?? (status === "applied" ? new Date().toISOString() : null);
    const result = this.database.prepare("UPDATE memory_mutation_proposals SET status = ?, policy_reason = ?, applied_at = ? WHERE id = ?")
      .run(status, opts?.policyReason ?? null, appliedAt, id);
    if (result.changes !== 1) throw new Error(`记忆提案不存在: ${id}`);
    return this.getById(id) as MemoryMutationProposal;
  }

  private list(where: string, params: readonly unknown[]): MemoryMutationProposal[] {
    const rows = this.database.prepare(`SELECT * FROM memory_mutation_proposals WHERE ${where} ORDER BY created_at ASC`).all(...params) as ProposalRow[];
    return rows.map(mapRow);
  }
}
