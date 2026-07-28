/**
 * preflight — bash 命令危险模式拦截。
 *
 * 在执行任何 bash 命令之前，先扫描命令字符串是否命中已知危险模式。
 * 命中任一模式即拒绝执行，防止 Agent 执行破坏性系统操作。
 */

/** 危险命令模式列表（借鉴 openhanako 设计） */
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\bsudo\b/,
  /\bsu\b/,
  /\bchmod\s+[0-7]*7/,
  /\bchown\b/,
  /\brm\s+-rf\s+\//,
  /\bmkfs\./,
  /\bdd\s+if=/,
  /\bformat\b/,
  /\bdel\s+\/s\b/i,          // Windows
  /\brmdir\s+\/s\b/i,        // Windows
  /\breg\s+delete\b/i,       // Windows
  /\btakeown\b/i,            // Windows
  /\bicacls\b/i,             // Windows
  /\bnet\s+user\b/i,         // Windows
  /\bschtasks\b/i,           // Windows
  /\bsc\s+create\b/i,        // Windows
  /\bbcdedit\b/i,            // Windows
];

/**
 * 对 bash 命令字符串进行 preflight 安全检查。
 *
 * @returns 命中危险模式时返回 `{ allowed: false, pattern }`，否则 `{ allowed: true }`
 */
export function checkBashPreflight(
  command: string,
): { allowed: false; pattern: string } | { allowed: true } {
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(command)) {
      return { allowed: false, pattern: re.source };
    }
  }
  return { allowed: true };
}
