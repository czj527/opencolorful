import path from "node:path";

import Value from "typebox/value";

import {
  SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES,
  SUBAGENT_CONTEXT_TOTAL_MAX_BYTES,
  SubagentContextPacketV1Schema,
  type ParentMessageRef,
  type SubagentContextPacketV1,
  type SubagentContextRefV1,
} from "../../contracts/subagents.js";
import type { SkillRef } from "../../contracts/skill-protocol.js";
import { skillRefKey } from "../../contracts/skill-protocol.js";
import { sha256Hex, stableSerialize } from "./delegation-policy.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T3：ContextResolver（plans/phase-14.md §9.2 / §22.1）
//
// - messageRefs/resources 引用验证与归属检查（fail-closed）：
//   parent_message 只允许当前父 Session；workspace_file 必须落在父工作区
//   canonical 内；artifact/skill 引用存在性与 contentHash 校验；
// - messageRefs 有界快照：单条 ≤ 16KB、总计 ≤ 128KB，超限截断并标记
//   truncated（消除父 Session compaction/分支变化对引用的影响）；
// - ContextPacket 在 Thread 创建时冻结，本模块输出冻结快照与 packetHash。
//
// 本文件是 T3 独占文件（src/runtime/subagents/），不 import T2 stores。
// ═══════════════════════════════════════════════════════════════

// ── 依赖注入（生产接线由 T6 组装；测试注入内存 fixture）──────────

export interface ContextResolverDeps {
  /** 当前父 Session（parent_message 引用的归属唯一允许值） */
  readonly parentSessionId: string;
  /** 父工作区 canonical 根（解析 workspace_file 相对路径；§12.7） */
  readonly workspaceCwd: string;
  /** 读取父 Session 消息正文；不存在返回 null */
  loadParentMessage(messageId: string): { readonly sessionId: string; readonly content: string } | null;
  /** 解析工作区文件；不存在返回 null */
  resolveWorkspaceFile(relativePath: string): { readonly contentHash: string } | null;
  /** 解析 Subagent Artifact；不存在返回 null */
  resolveArtifact(artifactId: string): { readonly contentHash: string } | null;
  /** 解析 SkillRef；不存在返回 null */
  resolveSkill(ref: SkillRef): { readonly contentHash: string } | null;
}

// ── 结果结构 ───────────────────────────────────────────────────

export type ContextRefProblemKind =
  | "invalid_packet"
  | "parent_message_cross_session"
  | "parent_message_not_found"
  | "parent_message_hash_mismatch"
  | "workspace_file_outside_workspace"
  | "workspace_file_not_found"
  | "workspace_file_hash_mismatch"
  | "artifact_not_found"
  | "artifact_hash_mismatch"
  | "skill_not_found"
  | "skill_hash_mismatch";

export interface ContextRefProblem {
  readonly kind: ContextRefProblemKind;
  /** 定位路径，如 messageRefs[2] / resources[1] / $（包级） */
  readonly path: string;
  readonly detail: string;
}

/** messageRefs 有界快照条目（单条 ≤ 16KB；超限截断并标记 truncated） */
export interface MessageSnapshotEntry {
  readonly ref: ParentMessageRef;
  /** 快照正文（已做 UTF-8 安全截断） */
  readonly content: string;
  /** 实际快照字节数 */
  readonly bytes: number;
  /** 单条是否因超 16KB 被截断 */
  readonly truncated: boolean;
}

/** resources 引用解析结果（验证通过后供渲染引用列表） */
export interface ResourceResolution {
  readonly ref: SubagentContextRefV1;
  readonly label: string;
}

/** Thread 创建时冻结的有界上下文快照 */
export interface ContextResolutionSnapshot {
  readonly messageRefs: readonly MessageSnapshotEntry[];
  readonly resources: readonly ResourceResolution[];
  /** 总计超 128KB 或任一条目被截断 → true */
  readonly truncated: boolean;
  /** 快照正文合计字节（≤ 128KB） */
  readonly totalMessageBytes: number;
  /** 因总预算被整体丢弃的 messageRef 条数 */
  readonly droppedMessageCount: number;
  /** ContextPacket 稳定哈希（Thread 行 context_packet_hash） */
  readonly packetHash: string;
}

export type ContextResolutionResult =
  | { readonly ok: true; readonly snapshot: ContextResolutionSnapshot }
  | { readonly ok: false; readonly problems: readonly ContextRefProblem[] };

// ── Resolver ───────────────────────────────────────────────────

export class ContextResolver {
  constructor(private readonly deps: ContextResolverDeps) {}

  /**
   * 解析并冻结 ContextPacket。任何引用违规（跨 Session / 越界 / 缺失 /
   * 哈希不匹配 / 包结构非法）都 fail-closed：返回 problems，不产出快照。
   */
  resolve(packet: SubagentContextPacketV1): ContextResolutionResult {
    // 跨进程输入先过 TypeBox（不允许 as 绕过包边界）
    if (!Value.Check(SubagentContextPacketV1Schema, packet)) {
      const details: string[] = [];
      for (const error of Value.Errors(SubagentContextPacketV1Schema, packet)) {
        details.push(`${"path" in error && typeof error.path === "string" ? error.path : "$"}: ${error.message}`);
        if (details.length >= 3) {
          break;
        }
      }
      return {
        ok: false,
        problems: [{ kind: "invalid_packet", path: "$", detail: details.join("；") }],
      };
    }

    const problems: ContextRefProblem[] = [];

    // ── 1. messageRefs 验证 + 有界快照 ─────────────────────────
    const messageRefs: MessageSnapshotEntry[] = [];
    let total = 0;
    let dropped = 0;
    let budgetExhausted = false;
    let anyTruncated = false;

    for (let index = 0; index < packet.messageRefs.length; index++) {
      const ref = packet.messageRefs[index]!;
      if (budgetExhausted) {
        dropped++;
        continue;
      }
      const loaded = this.loadParentMessage(ref, `messageRefs[${index}]`, problems);
      if (loaded === null) {
        continue;
      }
      const single = truncateUtf8Bytes(loaded.content, SUBAGENT_CONTEXT_MESSAGE_MAX_BYTES);
      if (single.truncated) {
        anyTruncated = true;
      }
      const room = SUBAGENT_CONTEXT_TOTAL_MAX_BYTES - total;
      if (single.bytes <= room) {
        messageRefs.push({ ref, content: single.text, bytes: single.bytes, truncated: single.truncated });
        total += single.bytes;
        continue;
      }
      // 总预算超限：本条截断到剩余空间（空间为 0 则整条丢弃），后续条目全部丢弃
      if (room > 0) {
        const fit = truncateUtf8Bytes(loaded.content, room);
        messageRefs.push({ ref, content: fit.text, bytes: fit.bytes, truncated: true });
        total += fit.bytes;
      } else {
        dropped++;
      }
      anyTruncated = true;
      budgetExhausted = true;
    }

    // ── 2. resources 引用验证（只验证与标记，不做正文快照）──────
    const resources: ResourceResolution[] = [];
    for (let index = 0; index < packet.resources.length; index++) {
      const ref = packet.resources[index]!;
      const label = resourceLabel(ref);
      if (ref.kind === "parent_message") {
        const loaded = this.loadParentMessage(ref, `resources[${index}]`, problems);
        if (loaded !== null) {
          resources.push({ ref, label });
        }
        continue;
      }
      if (ref.kind === "workspace_file") {
        if (!isWorkspaceRelativePath(this.deps.workspaceCwd, ref.relativePath)) {
          problems.push({
            kind: "workspace_file_outside_workspace",
            path: `resources[${index}]`,
            detail: `相对路径 ${ref.relativePath} 解析后越出父工作区 canonical（${this.deps.workspaceCwd}）`,
          });
          continue;
        }
        const file = this.deps.resolveWorkspaceFile(ref.relativePath);
        if (file === null) {
          problems.push({
            kind: "workspace_file_not_found",
            path: `resources[${index}]`,
            detail: `工作区文件不存在：${ref.relativePath}`,
          });
          continue;
        }
        if (file.contentHash !== ref.contentHash) {
          problems.push({
            kind: "workspace_file_hash_mismatch",
            path: `resources[${index}]`,
            detail: `工作区文件 ${ref.relativePath} 内容哈希不匹配`,
          });
          continue;
        }
        resources.push({ ref, label });
        continue;
      }
      if (ref.kind === "artifact") {
        const artifact = this.deps.resolveArtifact(ref.artifactId);
        if (artifact === null) {
          problems.push({ kind: "artifact_not_found", path: `resources[${index}]`, detail: `Artifact 不存在：${ref.artifactId}` });
          continue;
        }
        if (artifact.contentHash !== ref.contentHash) {
          problems.push({
            kind: "artifact_hash_mismatch",
            path: `resources[${index}]`,
            detail: `Artifact ${ref.artifactId} 内容哈希不匹配`,
          });
          continue;
        }
        resources.push({ ref, label });
        continue;
      }
      // ref.kind === "skill"
      const skill = this.deps.resolveSkill(ref.skillRef);
      if (skill === null) {
        problems.push({
          kind: "skill_not_found",
          path: `resources[${index}]`,
          detail: `Skill 引用未找到：${skillRefKey(ref.skillRef)}`,
        });
        continue;
      }
      if (skill.contentHash !== ref.contentHash) {
        problems.push({
          kind: "skill_hash_mismatch",
          path: `resources[${index}]`,
          detail: `Skill ${skillRefKey(ref.skillRef)} 内容哈希不匹配`,
        });
        continue;
      }
      resources.push({ ref, label });
    }

    if (problems.length > 0) {
      return { ok: false, problems };
    }

    return {
      ok: true,
      snapshot: {
        messageRefs,
        resources,
        truncated: anyTruncated || dropped > 0,
        totalMessageBytes: total,
        droppedMessageCount: dropped,
        packetHash: sha256Hex(stableSerialize(packet)),
      },
    };
  }

  /** 父消息加载 + 归属与哈希校验；通过返回正文，否则返回 null 并记录 problem */
  private loadParentMessage(
    ref: ParentMessageRef,
    pathLabel: string,
    problems: ContextRefProblem[],
  ): { readonly content: string } | null {
    const loaded = this.deps.loadParentMessage(ref.messageId);
    if (loaded === null) {
      problems.push({ kind: "parent_message_not_found", path: pathLabel, detail: `父消息不存在：${ref.messageId}` });
      return null;
    }
    if (loaded.sessionId !== this.deps.parentSessionId) {
      problems.push({
        kind: "parent_message_cross_session",
        path: pathLabel,
        detail: `消息 ${ref.messageId} 属于 Session ${loaded.sessionId}，当前父 Session 为 ${this.deps.parentSessionId}`,
      });
      return null;
    }
    if (sha256Hex(loaded.content) !== ref.contentHash) {
      problems.push({
        kind: "parent_message_hash_mismatch",
        path: pathLabel,
        detail: `消息 ${ref.messageId} 内容哈希与引用不一致（父消息已变化）`,
      });
      return null;
    }
    return { content: loaded.content };
  }
}

// ── 工具函数 ───────────────────────────────────────────────────

/** 资源引用的人类可读标签（渲染引用列表用） */
export function resourceLabel(ref: SubagentContextRefV1): string {
  switch (ref.kind) {
    case "parent_message":
      return `message ${ref.messageId}`;
    case "workspace_file":
      return `workspace ${ref.relativePath}`;
    case "artifact":
      return `artifact ${ref.artifactId}`;
    case "skill":
      return `skill ${skillRefKey(ref.skillRef)}`;
  }
}

/**
 * workspace_file 归属检查（§9.2 / §12.7）：相对路径解析到父工作区
 * canonical 内；绝对路径、`..` 越界、空路径一律拒绝。
 */
export function isWorkspaceRelativePath(workspaceCwd: string, relativePath: string): boolean {
  if (path.isAbsolute(relativePath) || relativePath.length === 0) {
    return false;
  }
  const resolved = path.resolve(workspaceCwd, relativePath);
  return isPathInside(workspaceCwd, resolved);
}

function isPathInside(root: string, target: string): boolean {
  // Windows 大小写不敏感比较；非 win32 保持原样
  const normalize = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  const relative = path.relative(root, target);
  if (relative === "") {
    return true;
  }
  const normalizedRoot = normalize(root);
  const normalizedTarget = normalize(target);
  return (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`))
  );
}

/**
 * UTF-8 安全截断：按字节上限截断且不切坏多字节字符。
 * 返回截断后的文本、实际字节数与是否被截断。
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, bytes: buffer.length, truncated: false };
  }
  let end = maxBytes;
  // 回退到合法字符边界（被截断处不能落在多字节字符的中间）
  while (end > 0) {
    const byte = buffer[end] ?? 0;
    if ((byte & 0xc0) !== 0x80) {
      break;
    }
    end--;
  }
  return { text: buffer.subarray(0, end).toString("utf8"), bytes: end, truncated: true };
}
