import * as fs from "node:fs";
import * as path from "node:path";

import {
  ACCESS_HIERARCHY,
  OPERATION_REQUIREMENTS,
  type AccessLevel,
  type FileOperation,
  type PathCheckResult,
  type PathGuardPolicy,
  type PathRule,
} from "../contracts/sandbox.js";

/**
 * PathGuard — 路径守卫核心。
 *
 * 根据 PathGuardPolicy 中的规则列表，对文件操作请求进行逐路径的访问控制检查。
 *
 * 匹配逻辑：
 * - rule.path 以 "/"（或 Windows 上的 "\\"）结尾 → 目录前缀匹配
 * - 否则 → 精确路径匹配
 * - 规则列表按优先级排序，命中第一条即生效
 * - 未命中 → 使用 policy.defaultLevel 作为兜底
 * - policy.allowExternalReads 为 true 时，对 read 操作的兜底级别升级为 READ_ONLY
 */
export class PathGuard {
  constructor(private readonly policy: PathGuardPolicy) {}

  /**
   * 检查单个路径是否允许指定操作。
   *
   * 流程：
   * 1. path.resolve() 规范化输入路径
   * 2. 通过 fs.realpathSync.native() 解析符号链接得到 canonicalPath
   *    （路径不存在时向上遍历到最近存在的祖先，拼接剩余相对路径）
   * 3. 从规则列表中按优先级逐一匹配，第一条命中即生效
   * 4. 未匹配到规则时使用兜底级别（read + allowExternalReads 时升级到 READ_ONLY）
   * 5. 比较匹配/兜底级别与 OPERATION_REQUIREMENTS[operation] 判断是否允许
   */
  check(operation: FileOperation, targetPath: string): PathCheckResult {
    const resolvedPath = path.resolve(targetPath);
    const canonicalPath = this.resolveCanonical(resolvedPath);

    // 按优先级匹配规则
    let matchedLevel: AccessLevel | null = null;
    let matchedReason = "";

    for (const rule of this.policy.rules) {
      if (this.matchesRule(canonicalPath, rule)) {
        matchedLevel = rule.level;
        matchedReason = rule.reason;
        break;
      }
    }

    // 兜底级别
    const level = matchedLevel ?? this.policy.defaultLevel;
    const reason = matchedLevel !== null
      ? matchedReason
      : "Access denied by default policy (no matching rule)";

    // 比对所需级别
    const required = OPERATION_REQUIREMENTS[operation];
    const allowed = ACCESS_HIERARCHY[level] >= ACCESS_HIERARCHY[required];

    return {
      allowed,
      canonicalPath,
      level,
      required,
      reason: allowed
        ? matchedLevel !== null
          ? `Access granted by rule: ${matchedReason}`
          : "Access granted by default"
        : `Access denied: ${reason} (requires ${required}, got ${level})`,
    };
  }

  /**
   * 批量检查。只要有一条拒绝就返回拒绝结果；全部通过则返回最后一条的结果。
   */
  checkAll(operation: FileOperation, paths: string[]): PathCheckResult {
    if (paths.length === 0) {
      // 无路径视为通过（退化情况）
      return {
        allowed: true,
        canonicalPath: "",
        level: "FULL",
        required: OPERATION_REQUIREMENTS[operation],
        reason: "No paths to check",
      };
    }

    for (const p of paths) {
      const result = this.check(operation, p);
      if (!result.allowed) {
        return result;
      }
    }

    // 全部通过，返回最后一条的结果
    return this.check(operation, paths[paths.length - 1]!);
  }

  // ── private helpers ───────────────────────────────────────────────

  /**
   * 解析路径的规范化形式（消除符号链接）。
   *
   * - 路径存在 → 返回 fs.realpathSync.native() 的结果
   * - 路径不存在 → 向上遍历到最近存在的祖先，用祖先的规范化路径拼接剩余相对路径
   * - 连根目录都不存在（极端情况）→ 返回原始的 resolvedPath
   */
  private resolveCanonical(targetPath: string): string {
    try {
      return fs.realpathSync.native(targetPath);
    } catch {
      // 路径不存在，向上遍历
      let current = targetPath;
      while (true) {
        const parent = path.dirname(current);
        if (parent === current) {
          // 已到达文件系统根节点，无法继续向上
          return targetPath;
        }
        try {
          const realParent = fs.realpathSync.native(parent);
          // 拼接剩余相对路径
          const remaining = path.relative(parent, targetPath);
          return path.join(realParent, remaining);
        } catch {
          // 祖先也不存在，继续向上
          current = parent;
        }
      }
    }
  }

  /**
   * 判断 canonicalPath 是否匹配某条规则。
   *
   * - rule.path 以 "/"（或 Windows 的 "\\"）结尾 → 目录前缀匹配：
   *   canonicalPath 以 rule.path（去尾分隔符）为前缀即命中
   * - 否则 → 精确匹配：
   *   canonicalPath === path.resolve(rule.path) 即命中
   */
  private matchesRule(canonicalPath: string, rule: PathRule): boolean {
    // 规则路径也 canonicalize（防止 symlink/Junction 绕过）
    const rulePath = this.resolveCanonical(path.resolve(rule.path));
    const sep = path.sep;

    if (rule.path.endsWith("/") || rule.path.endsWith("\\")) {
      // 目录前缀匹配
      const normalizedRulePath = rulePath.endsWith(sep)
        ? rulePath.slice(0, -1)
        : rulePath;
      return (
        canonicalPath === normalizedRulePath ||
        canonicalPath.startsWith(normalizedRulePath + sep)
      );
    }

    // basename 匹配：rule.path 形如 "**.env" 表示匹配任意目录下指定名称的文件
    // Windows 大小写不敏感：规范化比较
    if (rule.path.startsWith("**.")) {
      const basename = rule.path.slice(2);
      const targetBasename = path.basename(canonicalPath);
      if (process.platform === "win32") {
        return targetBasename.toLowerCase() === basename.toLowerCase();
      }
      return targetBasename === basename;
    }

    // 精确匹配
    return canonicalPath === rulePath;
  }

}

