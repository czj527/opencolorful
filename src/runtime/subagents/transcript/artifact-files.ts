import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import {
  SUBAGENT_ARTIFACT_ID_PREFIX,
  type SubagentArtifactId,
  type SubagentArtifactRef,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import {
  ArtifactStore,
  type SubagentArtifactRecord,
  type SubagentArtifactVisibility,
} from "../stores/artifact-store.js";
import { SubagentStoreError } from "../stores/errors.js";
import { ThreadStore } from "../stores/thread-store.js";
import type { SubagentOwnership } from "../stores/types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Artifact 文件路由与完整性（plans/phase-14.md §17.3）
//
// 目录约定（§16.3 / paths.subagentsBase）：
//   <subagentsBase>/<ownerAgentId>/subagents/<threadId>/artifacts/<artifactId>
// - threadId/artifactId 均为平台生成的稳定 ID（T1 pattern），本模块在拼路径
//   前再次校验 pattern，不接受用户提供的路径片段（防穿越）；
// - 平台生成的文本/数据 Artifact 写入 Thread artifacts/ 并登记元数据
//   （resource_kind='subagent_artifact'）；Workspace 文件只登记引用
//   （resource_kind='workspace_file'），不复制为平台所有（§17.3）；
// - contentHash = sha256(content)（≥8 字符）；读取时重新计算并比对，
//   不匹配抛 subagent_artifact_integrity_failed 并触发 integrity 回调
//   （投影层记录 subagent.artifact.integrity_failed）；
// - 删除父 Session 时删除平台 Artifact（含文件），外部 Workspace 文件不删除；
// - HTTP 下载由路由层设置 nosniff + 安全 Content-Disposition（本模块不含 HTTP）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentArtifactFileServiceDeps {
  readonly artifacts: ArtifactStore;
  readonly threads: ThreadStore;
  readonly paths: RuntimePaths;
  /** 完整性校验失败回调（投影层埋点 subagent.artifact.integrity_failed） */
  readonly onIntegrityFailed?: (event: {
    readonly artifactId: SubagentArtifactId;
    readonly threadId: SubagentThreadId;
    readonly runId: SubagentRunId | null;
    readonly expectedHash: string;
    readonly reason: string;
  }) => void;
}

export interface WritePlatformArtifactInput {
  readonly artifactId: SubagentArtifactId;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  /** 'text' | 'data'（平台生成）；workspace 文件用 registerWorkspaceFileRef */
  readonly kind: "text" | "data";
  readonly name: string;
  readonly mimeType: string | null;
  readonly content: string | Buffer;
  readonly visibility: SubagentArtifactVisibility;
  readonly ownership: SubagentOwnership;
  readonly createdAt: string;
}

export interface RegisterWorkspaceFileRefInput {
  readonly artifactId: SubagentArtifactId;
  readonly threadId: SubagentThreadId;
  readonly runId: SubagentRunId;
  readonly name: string;
  /** 外部文件 contentHash（读取时校验失败不删除外部文件，只登记失败） */
  readonly contentHash: string;
  readonly sizeBytes: number | null;
  /** 外部文件唯一标识（工作区相对路径或 ResourceRef id） */
  readonly resourceId: string;
  readonly visibility: SubagentArtifactVisibility;
  readonly ownership: SubagentOwnership;
  readonly createdAt: string;
}

export interface ArtifactContentResult {
  readonly record: SubagentArtifactRecord;
  readonly content: Buffer;
}

/** sha256 hex（64 字符，满足 contentHash ≥8 契约） */
export function hashContent(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Artifact 引用（T1 冻结契约形状：artifactId/name/contentHash；§17.3 的
 * kind/mimeType/sizeBytes/resourceRef 等展示字段由面板从 transcript 的
 * artifacts 列表（SubagentArtifactRecord 全量元数据）读取，不塞进契约引用）。
 */
export function subagentArtifactRefOf(record: SubagentArtifactRecord): SubagentArtifactRef {
  return {
    artifactId: record.artifactId,
    name: record.name,
    contentHash: record.contentHash,
  };
}

export class SubagentArtifactFileService {
  constructor(private readonly deps: SubagentArtifactFileServiceDeps) {}

  /**
   * 平台 Artifact 写入：目录创建 → 原子写文件 → contentHash 计算 → 元数据登记
   * （幂等：artifactId 已存在则返回原记录，不重复写文件）。
   */
  writePlatformArtifact(input: WritePlatformArtifactInput): SubagentArtifactRecord {
    assertStableArtifactId(input.artifactId);
    const filePath = this.artifactFilePath(input.ownership.ownerAgentId, input.threadId, input.artifactId);
    const existing = this.deps.artifacts.get(input.artifactId, input.ownership);
    if (existing !== null) {
      return existing;
    }
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
    const contentHash = hashContent(content);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 原子写（临时文件 + rename），避免半写 Artifact 被完整性校验读取
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
    return this.deps.artifacts.create(
      {
        artifactId: input.artifactId,
        threadId: input.threadId,
        runId: input.runId,
        kind: input.kind,
        name: input.name,
        mimeType: input.mimeType,
        contentHash,
        sizeBytes: content.byteLength,
        resourceKind: "subagent_artifact",
        resourceId: input.artifactId,
        canonicalPath: filePath,
        visibility: input.visibility,
        createdAt: input.createdAt,
      },
      input.ownership,
    );
  }

  /**
   * Workspace 文件只登记引用，不复制正文（§17.3）。
   * resource_kind='workspace_file'、canonical_path=NULL。
   */
  registerWorkspaceFileRef(input: RegisterWorkspaceFileRefInput): SubagentArtifactRecord {
    assertStableArtifactId(input.artifactId);
    return this.deps.artifacts.create(
      {
        artifactId: input.artifactId,
        threadId: input.threadId,
        runId: input.runId,
        kind: "file",
        name: input.name,
        mimeType: null,
        contentHash: input.contentHash,
        sizeBytes: input.sizeBytes,
        resourceKind: "workspace_file",
        resourceId: input.resourceId,
        canonicalPath: null,
        visibility: input.visibility,
        createdAt: input.createdAt,
      },
      input.ownership,
    );
  }

  /**
   * 受控读取：归属校验（Store 层）→ 文件存在校验 → contentHash 完整性校验。
   * 不匹配抛 subagent_artifact_integrity_failed（§17.3：拒绝 + 记录）。
   */
  readArtifactContent(artifactId: SubagentArtifactId, ownership: SubagentOwnership): ArtifactContentResult {
    const record = this.requireRecord(artifactId, ownership);
    if (record.resourceKind === "workspace_file" || record.canonicalPath === null) {
      throw new SubagentStoreError(
        "subagent_artifact_integrity_failed",
        `artifact ${artifactId} is a workspace file reference without platform content`,
      );
    }
    const filePath = this.artifactFilePath(ownership.ownerAgentId, record.threadId, artifactId);
    if (!fs.existsSync(filePath)) {
      const reason = "artifact file missing";
      this.reportIntegrityFailed(record, record.contentHash, reason);
      throw new SubagentStoreError("subagent_artifact_integrity_failed", reason);
    }
    const content = fs.readFileSync(filePath);
    const actualHash = hashContent(content);
    if (actualHash !== record.contentHash) {
      const reason = "contentHash mismatch";
      this.reportIntegrityFailed(record, record.contentHash, reason);
      throw new SubagentStoreError("subagent_artifact_integrity_failed", reason);
    }
    return { record, content };
  }

  /** Thread Artifact 元数据列表（只读；T8 面板与 API 用） */
  listByThread(threadId: SubagentThreadId, ownership: SubagentOwnership): SubagentArtifactRecord[] {
    return this.deps.artifacts.listByThread(threadId, ownership);
  }

  /** 元数据 + 文件删除（父 Session 删除清理用；workspace_file 引用不删外部文件） */
  deleteArtifact(artifactId: SubagentArtifactId, ownership: SubagentOwnership): boolean {
    const record = this.requireRecord(artifactId, ownership);
    let removed = false;
    if (record.resourceKind !== "workspace_file" && record.canonicalPath !== null) {
      const filePath = this.artifactFilePath(ownership.ownerAgentId, record.threadId, artifactId);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          removed = true;
        }
      } catch {
        // 文件删除失败不阻断元数据清理（孤儿文件由 housekeeping 兜底）
      }
    }
    const metaRemoved = this.deps.artifacts.delete(artifactId, ownership);
    return metaRemoved || removed;
  }

  /** Thread artifacts 目录（仅平台内部使用；API 层不得直接暴露） */
  threadArtifactsDir(ownerAgentId: string, threadId: SubagentThreadId): string {
    assertOwnerAgentId(ownerAgentId);
    assertStableThreadId(threadId);
    return path.join(this.deps.paths.subagentsBase, ownerAgentId, "subagents", threadId, "artifacts");
  }

  private artifactFilePath(ownerAgentId: string, threadId: SubagentThreadId, artifactId: SubagentArtifactId): string {
    assertStableArtifactId(artifactId);
    return path.join(this.threadArtifactsDir(ownerAgentId, threadId), artifactId);
  }

  private requireRecord(artifactId: SubagentArtifactId, ownership: SubagentOwnership): SubagentArtifactRecord {
    const record = this.deps.artifacts.get(artifactId, ownership);
    if (record === null) {
      throw new SubagentStoreError("subagent_not_found", `subagent artifact ${artifactId} not found`);
    }
    return record;
  }

  private reportIntegrityFailed(
    record: SubagentArtifactRecord,
    expectedHash: string,
    reason: string,
  ): void {
    try {
      this.deps.onIntegrityFailed?.({
        artifactId: record.artifactId,
        threadId: record.threadId,
        runId: record.runId,
        expectedHash,
        reason,
      });
    } catch {
      // 埋点失败不阻断拒绝语义（§17.3：contentHash 不匹配时拒绝是硬约束）
    }
  }
}

/** 稳定 ID pattern 复检（T1 pattern 前缀后至少 8 字符；防路径注入） */
export function assertStableArtifactId(artifactId: SubagentArtifactId): void {
  if (!/^saa_[A-Za-z0-9_-]{8,128}$/.test(artifactId)) {
    throw new SubagentStoreError("subagent_operation_failed", `invalid artifact id ${artifactId}`);
  }
}

export function assertStableThreadId(threadId: SubagentThreadId): void {
  if (!/^sat_[A-Za-z0-9_-]{8,128}$/.test(threadId)) {
    throw new SubagentStoreError("subagent_operation_failed", `invalid thread id ${threadId}`);
  }
}

/** ownerAgentId 白名单字符（路径片段安全；API 层查询参数也复用） */
export function assertOwnerAgentId(ownerAgentId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(ownerAgentId)) {
    throw new SubagentStoreError("subagent_operation_failed", "invalid owner agent id");
  }
}

export function newArtifactId(): SubagentArtifactId {
  return `${SUBAGENT_ARTIFACT_ID_PREFIX}${crypto.randomBytes(12).toString("hex")}` as SubagentArtifactId;
}
