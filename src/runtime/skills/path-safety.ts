import fs from "node:fs";
import path from "node:path";

import type { SkillErrorCode } from "../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Skill 路径守卫（plans/phase-13.md §7.3）
//
// - canonical 判定与 src/runtime/plugins/paths.ts 同模式（解析 symlink/Junction）；
// - 拒绝 `..` 逃逸、symlink/Junction 逃逸、重复路径（ZIP 场景由 T3 复用本模块）；
// - walkSafeFiles 是包结构与哈希共用的安全遍历（fail-closed，不静默跳过）；
// - 所有错误带稳定 reasonCode（skill_path_escape / skill_symlink_escape /
//   skill_duplicate_path / skill_file_type_denied）。
// ═══════════════════════════════════════════════════════════════

export class SkillPathError extends Error {
  readonly reasonCode: SkillErrorCode;
  constructor(reasonCode: SkillErrorCode, message: string) {
    super(message);
    this.name = "SkillPathError";
    this.reasonCode = reasonCode;
  }
}

/**
 * 归档/相对路径条目安全校验：拒绝空名、NUL、绝对路径、UNC、盘符与父目录穿越
 * （ZIP Slip 第一道防线；T3 解 ZIP 时复用，传入 skill_zip_slip 作为 reasonCode）。
 */
export function assertSafeRelativeEntry(entry: string, reasonCode: SkillErrorCode = "skill_path_escape"): void {
  if (entry.length === 0) {
    throw new SkillPathError(reasonCode, "归档条目名称为空");
  }
  if (entry.includes("\0")) {
    throw new SkillPathError(reasonCode, "归档条目名称包含非法字符");
  }
  if (path.isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry) || /^\\\\/.test(entry)) {
    throw new SkillPathError(reasonCode, "归档条目使用了绝对路径，已拒绝");
  }
  const normalized = entry.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new SkillPathError(reasonCode, "归档条目包含父目录穿越（ZIP Slip），已拒绝");
    }
  }
}

/** canonical 路径：解析符号链接/Junction；不存在时向上回溯最近存在的祖先再拼接。 */
export function canonicalPathSync(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let current = resolved;
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      try {
        const realParent = fs.realpathSync.native(parent);
        return path.join(realParent, path.relative(parent, resolved));
      } catch {
        current = parent;
      }
    }
  }
}

/** candidate 是否位于 root（含 root 自身）内；两端 canonical 后比较。 */
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const canonical = canonicalPathSync(path.resolve(candidate));
  const canonicalRoot = canonicalPathSync(path.resolve(root));
  const within = (base: string, target: string): boolean => {
    const relative = path.relative(base, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  if (process.platform === "win32") {
    return within(canonicalRoot.toLowerCase(), canonical.toLowerCase());
  }
  return within(canonicalRoot, canonical);
}

export function assertPathWithinRoot(candidate: string, root: string, what = "路径"): void {
  if (!isPathWithinRoot(candidate, root)) {
    throw new SkillPathError("skill_path_escape", `${what} 不在受控目录内，已拒绝`);
  }
}

/** 安全拼接：解析后必须仍位于 root 内。 */
export function safeJoin(root: string, ...segments: string[]): string {
  const joined = path.join(root, ...segments);
  assertPathWithinRoot(joined, root, "拼接路径");
  return joined;
}

/** 拒绝符号链接/Junction（Windows Junction 在 lstat 中报告为 symbolic link）。 */
export function assertNotSymlinkOrJunction(target: string, what = "路径"): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new SkillPathError("skill_symlink_escape", `${what} 不允许是符号链接或 Junction，已拒绝`);
  }
}

export interface SafeFileEntry {
  /** 相对路径（前向斜杠），如 SKILL.md、references/guide.md */
  readonly rel: string;
  readonly abs: string;
  readonly sizeBytes: number;
}

/**
 * 安全遍历包目录：逐项 lstat，拒绝符号链接/Junction 与非常规文件类型。
 * 返回按相对路径排序的文件清单（内容读取失败时调用方捕获并 fail-closed）。
 */
export function walkSafeFiles(root: string, options: { readonly exclude?: readonly string[] } = {}): readonly SafeFileEntry[] {
  const rootResolved = path.resolve(root);
  const exclude = new Set((options.exclude ?? []).map((name) => name.replace(/\\/g, "/")));
  const entries: SafeFileEntry[] = [];
  const pending = [rootResolved];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new SkillPathError("skill_symlink_escape", "包内容包含符号链接或 Junction，已拒绝");
    }
    const relative = path.relative(rootResolved, current).replace(/\\/g, "/");
    if (relative !== "" && exclude.has(relative)) {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      entries.push({ rel: relative === "" ? path.basename(current) : relative, abs: current, sizeBytes: stat.size });
    } else {
      throw new SkillPathError("skill_file_type_denied", "包内容包含非常规文件类型，已拒绝");
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}
