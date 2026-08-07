import type Database from "better-sqlite3";

import type { AgentMessageId, SubagentArtifactId, SubagentRunId, SubagentThreadId } from "../../../contracts/subagents.js";
import { SubagentStoreError } from "./errors.js";
import { ThreadStore } from "./thread-store.js";
import type { SubagentOwnership } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：ArtifactStore（plans/phase-14.md §16.2 / §17.3 / §22.1）
//
// subagent_artifacts 是 Artifact 元数据（正文在 agents/<owner>/subagents/
// <threadId>/artifacts/ 目录，T7 负责文件侧）：
// - artifact_id 幂等：重复 create 返回原记录（不重复副作用）；
// - run 必须存在且属于同一 thread（protocol 引用 fail-closed，§22.1）；
// - 所有查询/变更携带 SubagentOwnership（经 thread join 过滤）；
// - canonical_path 只用于平台内部（§16.2），API 层不得直接暴露。
// ═══════════════════════════════════════════════════════════════

export const SUBAGENT_ARTIFACT_VISIBILITIES = ["parent", "user", "private"] as const;
export type SubagentArtifactVisibility = (typeof SUBAGENT_ARTIFACT_VISIBILITIES)[number];

export interface SubagentArtifactRecord {
  readonly artifactId: SubagentArtifactId;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly kind: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly contentHash: string;
  readonly sizeBytes: number | null;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly canonicalPath: string | null;
  readonly visibility: SubagentArtifactVisibility;
  readonly createdAt: string;
}

export interface CreateSubagentArtifactInput {
  readonly artifactId: SubagentArtifactId;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly kind: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly contentHash: string;
  readonly sizeBytes: number | null;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly canonicalPath: string | null;
  readonly visibility: SubagentArtifactVisibility;
  readonly createdAt: string;
}

export interface UpdateArtifactMetadataInput {
  readonly name?: string;
  readonly mimeType?: string | null;
  readonly sizeBytes?: number | null;
  readonly canonicalPath?: string | null;
  readonly visibility?: SubagentArtifactVisibility;
}

interface ArtifactRow {
  artifact_id: SubagentArtifactId;
  thread_id: SubagentThreadId;
  run_id: SubagentRunId;
  kind: string;
  name: string;
  mime_type: string | null;
  content_hash: string;
  size_bytes: number | null;
  resource_kind: string;
  resource_id: string;
  canonical_path: string | null;
  visibility: SubagentArtifactVisibility;
  created_at: string;
}

function mapArtifactRow(row: ArtifactRow): SubagentArtifactRecord {
  return {
    artifactId: row.artifact_id,
    threadId: row.thread_id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    canonicalPath: row.canonical_path,
    visibility: row.visibility,
    createdAt: row.created_at,
  };
}

export class ArtifactStore {
  constructor(
    private readonly database: Database.Database,
    private readonly threadStore: ThreadStore,
  ) {}

  /** 元数据登记；artifactId 重复写返回原记录（幂等） */
  create(input: CreateSubagentArtifactInput, ownership: SubagentOwnership): SubagentArtifactRecord {
    return this.database
      .transaction(() => {
        if (!(SUBAGENT_ARTIFACT_VISIBILITIES as readonly string[]).includes(input.visibility)) {
          throw new SubagentStoreError("subagent_operation_failed", `invalid artifact visibility ${input.visibility}`);
        }
        const thread = this.threadStore.get(input.threadId, ownership);
        if (thread === null) {
          throw new SubagentStoreError("subagent_not_found", `subagent thread ${input.threadId} not found`);
        }
        const runRow = this.database
          .prepare("SELECT thread_id FROM subagent_runs WHERE run_id = ?")
          .get(input.runId) as { thread_id: SubagentThreadId } | undefined;
        if (runRow === undefined) {
          throw new SubagentStoreError("subagent_not_found", `subagent run ${input.runId} not found`);
        }
        if (runRow.thread_id !== input.threadId) {
          throw new SubagentStoreError(
            "subagent_operation_failed",
            `artifact run/thread mismatch: run ${input.runId} belongs to thread ${runRow.thread_id}, not ${input.threadId}`,
          );
        }
        this.database
          .prepare(
            `INSERT OR IGNORE INTO subagent_artifacts
              (artifact_id, thread_id, run_id, kind, name, mime_type, content_hash, size_bytes,
               resource_kind, resource_id, canonical_path, visibility, created_at)
             VALUES
              (@artifactId, @threadId, @runId, @kind, @name, @mimeType, @contentHash, @sizeBytes,
               @resourceKind, @resourceId, @canonicalPath, @visibility, @createdAt)`,
          )
          .run({
            artifactId: input.artifactId,
            threadId: input.threadId,
            runId: input.runId,
            kind: input.kind,
            name: input.name,
            mimeType: input.mimeType,
            contentHash: input.contentHash,
            sizeBytes: input.sizeBytes,
            resourceKind: input.resourceKind,
            resourceId: input.resourceId,
            canonicalPath: input.canonicalPath,
            visibility: input.visibility,
            createdAt: input.createdAt,
          });
        const row = this.database
          .prepare("SELECT * FROM subagent_artifacts WHERE artifact_id = ?")
          .get(input.artifactId) as ArtifactRow | undefined;
        if (row === undefined) {
          throw new SubagentStoreError("subagent_operation_failed", `artifact ${input.artifactId} insert failed`);
        }
        return mapArtifactRow(row);
      })
      .immediate();
  }

  /** 归属过滤查询：存在但归属不匹配抛 subagent_ownership_denied；不存在返回 null */
  get(artifactId: SubagentArtifactId, ownership: SubagentOwnership): SubagentArtifactRecord | null {
    const row = this.#findOwned(artifactId, ownership);
    if (row !== undefined) return mapArtifactRow(row);
    const exists = this.database.prepare("SELECT 1 FROM subagent_artifacts WHERE artifact_id = ?").get(artifactId);
    if (exists !== undefined) {
      throw new SubagentStoreError("subagent_ownership_denied", `artifact ${artifactId} belongs to another owner/session`);
    }
    return null;
  }

  listByThread(threadId: SubagentThreadId, ownership: SubagentOwnership): SubagentArtifactRecord[] {
    const rows = this.database
      .prepare(
        `SELECT a.* FROM subagent_artifacts a
         JOIN subagent_threads t ON t.thread_id = a.thread_id
         WHERE a.thread_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?
         ORDER BY a.created_at ASC`,
      )
      .all(threadId, ownership.ownerAgentId, ownership.parentSessionId) as ArtifactRow[];
    return rows.map(mapArtifactRow);
  }

  listByRun(runId: SubagentRunId, ownership: SubagentOwnership): SubagentArtifactRecord[] {
    const rows = this.database
      .prepare(
        `SELECT a.* FROM subagent_artifacts a
         JOIN subagent_threads t ON t.thread_id = a.thread_id
         WHERE a.run_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?
         ORDER BY a.created_at ASC`,
      )
      .all(runId, ownership.ownerAgentId, ownership.parentSessionId) as ArtifactRow[];
    return rows.map(mapArtifactRow);
  }

  /** 可变元数据更新（name/mimeType/sizeBytes/canonicalPath/visibility；null = 保留原值） */
  updateMetadata(
    artifactId: SubagentArtifactId,
    ownership: SubagentOwnership,
    input: UpdateArtifactMetadataInput,
  ): boolean {
    if (input.visibility !== undefined && !(SUBAGENT_ARTIFACT_VISIBILITIES as readonly string[]).includes(input.visibility)) {
      throw new SubagentStoreError("subagent_operation_failed", `invalid artifact visibility ${input.visibility}`);
    }
    const result = this.database
      .prepare(
        `UPDATE subagent_artifacts SET
           name = COALESCE(@name, name),
           mime_type = COALESCE(@mimeType, mime_type),
           size_bytes = COALESCE(@sizeBytes, size_bytes),
           canonical_path = COALESCE(@canonicalPath, canonical_path),
           visibility = COALESCE(@visibility, visibility)
         WHERE artifact_id = @artifactId
           AND EXISTS (
             SELECT 1 FROM subagent_threads t
             WHERE t.thread_id = subagent_artifacts.thread_id
               AND t.owner_agent_id = @owner AND t.parent_session_id = @session
           )`,
      )
      .run({
        artifactId,
        name: input.name ?? null,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        canonicalPath: input.canonicalPath ?? null,
        visibility: input.visibility ?? null,
        owner: ownership.ownerAgentId,
        session: ownership.parentSessionId,
      });
    return result.changes > 0;
  }

  /** 删除元数据（父 Session 删除清理用；平台 Artifact 文件删除由 T7 负责） */
  delete(artifactId: SubagentArtifactId, ownership: SubagentOwnership): boolean {
    const result = this.database
      .prepare(
        `DELETE FROM subagent_artifacts
         WHERE artifact_id = @artifactId
           AND EXISTS (
             SELECT 1 FROM subagent_threads t
             WHERE t.thread_id = subagent_artifacts.thread_id
               AND t.owner_agent_id = @owner AND t.parent_session_id = @session
           )`,
      )
      .run({ artifactId, owner: ownership.ownerAgentId, session: ownership.parentSessionId });
    return result.changes > 0;
  }

  // ── 内部 helpers ──────────────────────────────────────────────

  #findOwned(artifactId: SubagentArtifactId, ownership: SubagentOwnership): ArtifactRow | undefined {
    return this.database
      .prepare(
        `SELECT a.* FROM subagent_artifacts a
         JOIN subagent_threads t ON t.thread_id = a.thread_id
         WHERE a.artifact_id = ? AND t.owner_agent_id = ? AND t.parent_session_id = ?`,
      )
      .get(artifactId, ownership.ownerAgentId, ownership.parentSessionId) as ArtifactRow | undefined;
  }
}
