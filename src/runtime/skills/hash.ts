import crypto from "node:crypto";
import fs from "node:fs";

import { walkSafeFiles } from "./path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 规范化内容哈希（plans/phase-13.md §7.3）
//
// - 确定性：相对路径（前向斜杠）+ 文件内容 + 可选版本参与哈希，按路径排序；
// - SKILL.md / frontmatter / 支持文件清单自然全部参与（SKILL.md 是普通文件）；
// - 返回稳定字符串 `sha256-<hex>`，**总长 ≤ 64**（冻结契约 SkillRef.contentHash
//   maxLength=64，`sha256-` 前缀占 7 字符，因此截取 57 位十六进制）；
// - 同一包两次哈希一致，内容变化哈希变化；
// - 遍历沿用 walkSafeFiles（拒绝 symlink/非常规文件），读取失败 fail-closed 抛错；
// - hashFileEntries 供 T3（ZIP/暂存目录）复用。
// ═══════════════════════════════════════════════════════════════

export const SKILL_HASH_PREFIX = "sha256-";

/** 冻结契约 SkillRef.contentHash maxLength=64（前缀 7 + 十六进制 57）。 */
const CONTENT_HASH_HEX_LENGTH = 57;

export interface SkillHashOptions {
  /** 版本参与哈希（Managed Store 用版本目录名；缺省不参与） */
  readonly version?: string;
  readonly exclude?: readonly string[];
}

/** 目录 → 确定性内容哈希（`sha256-<hex>`）。 */
export function computeSkillContentHash(packageRoot: string, options: SkillHashOptions = {}): string {
  const entries = walkSafeFiles(packageRoot, { ...(options.exclude !== undefined ? { exclude: options.exclude } : {}) });
  return hashFileEntries(
    entries.map((entry) => ({ rel: entry.rel, content: fs.readFileSync(entry.abs) })),
    options.version,
  );
}

export interface HashableFileEntry {
  readonly rel: string;
  readonly content: Uint8Array | string;
}

/** 条目集合 → 确定性内容哈希（按 rel 排序；T3 解包后复用）。 */
export function hashFileEntries(entries: readonly HashableFileEntry[], version?: string): string {
  const hash = crypto.createHash("sha256");
  if (version !== undefined) {
    hash.update("version");
    hash.update("\0");
    hash.update(version);
    hash.update("\0");
  }
  const sorted = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const entry of sorted) {
    hash.update(entry.rel);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  const hex = hash.digest("hex");
  return `${SKILL_HASH_PREFIX}${hex.slice(0, CONTENT_HASH_HEX_LENGTH)}`;
}
