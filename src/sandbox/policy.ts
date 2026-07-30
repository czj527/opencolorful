import * as os from "node:os";
import * as path from "node:path";

import type { AgentSettingsV2 } from "../contracts/agent-settings.js";
import {
  defaultSandboxCapabilities,
  type AccessLevel,
  type PathGuardPolicy,
  type PathRule,
} from "../contracts/sandbox.js";

/**
 * 根据 Agent 设置和平台路径，推导出完整的 PathGuardPolicy。
 *
 * 策略规则按优先级从高到低排列：
 *
 *  1. 绝对 BLOCKED 清单            — 系统敏感路径
 *  2. Agent sandbox.protectedPaths  — 用户指定的受保护路径
 *  3. Agent sandbox.extraReadPaths  — 用户显式授权的可读路径
 *  4. Agent 工作目录（workspaceCwd）  — FULL
 *  5. Agent 自身数据目录            — READ_WRITE
 *  6. Platform config 目录           — READ_ONLY
 *  7. 兜底                          — BLOCKED（未匹配一律拒绝）
 *
 * 注意：
 * - extraReadPaths 只对显式列出的路径授权，不会开放所有外部读取
 * - 所有 BLOCKED 目录规则均以路径分隔符结尾，确保覆盖子文件
 * - 策略构建需传入 Session 的实际工作区（workspaceCwd），而非 agent.defaultCwd
 */
export function buildPathGuardPolicy(params: {
  agentSettings: AgentSettingsV2;
  agentHomeDir: string;
  platformHome: string;
  /** Session 的实际工作目录（不可变快照），默认回退到 agent.defaultCwd */
  workspaceCwd?: string | null;
}): PathGuardPolicy {
  const { agentSettings, agentHomeDir, platformHome, workspaceCwd } = params;
  const sandbox = agentSettings.sandbox ?? defaultSandboxCapabilities();
  const home = os.homedir();
  const sep = path.sep;

  const rules: PathRule[] = [];

  // ── 1. 绝对 BLOCKED 清单（目录后缀保证匹配子文件） ──────────────────

  // ~/.ssh/* （含 id_rsa、known_hosts 等）
  rules.push({
    path: path.join(home, ".ssh") + sep,
    level: "BLOCKED",
    reason: "SSH keys directory is blocked",
  });

  // ~/.aws/* （含 credentials、config 等）
  rules.push({
    path: path.join(home, ".aws") + sep,
    level: "BLOCKED",
    reason: "AWS credentials directory is blocked",
  });

  // platform auth/ 目录（子树匹配）
  rules.push({
    path: path.join(platformHome, "auth") + sep,
    level: "BLOCKED",
    reason: "Platform auth directory is blocked",
  });

  // /etc/shadow（仅 Linux，精确匹配）
  if (process.platform === "linux") {
    rules.push({
      path: "/etc/shadow",
      level: "BLOCKED",
      reason: "System password file is blocked",
    });
  }

  // .env 文件（任意目录下）——basename 匹配模式
  rules.push({
    path: "**.env",
    level: "BLOCKED",
    reason: "Environment files (.env) are blocked",
  });

  // ── 2. Agent protectedPaths → BLOCKED（始终合并默认保护） ──────────
  // 以 workspaceCwd 为基准解析相对路径，加目录后缀保证子树匹配
  const baseForProtected = workspaceCwd
    ? path.resolve(workspaceCwd)
    : process.cwd();
  // 强制保护规则不可被用户配置覆盖
  const allProtectedPaths = [
    ...new Set([
      ...defaultSandboxCapabilities().protectedPaths,
      ...sandbox.protectedPaths,
    ]),
  ];
  for (const p of allProtectedPaths) {
    const absPath = path.resolve(baseForProtected, p);
    // 目录或文件：都以目录后缀标记以覆盖子文件
    rules.push({
      path: absPath + (absPath.endsWith(sep) ? "" : sep),
      level: "BLOCKED",
      reason: `Protected path: ${p}`,
    });
  }

  // ── 3. Agent extraReadPaths → READ_ONLY ──────────────────────────
  // 只对显式列出的路径授权，不影响全局兜底
  for (const p of sandbox.extraReadPaths) {
    const absPath = path.resolve(baseForProtected, p);
    rules.push({
      path: absPath + (absPath.endsWith(sep) ? "" : sep),
      level: "READ_ONLY",
      reason: `Extra read path: ${p}`,
    });
  }

  // ── 4. Agent 数据目录 → READ_WRITE（优先于工作区 FULL）───────────
  rules.push({
    path: path.resolve(agentHomeDir) + sep,
    level: "READ_WRITE",
    reason: "Agent home directory",
  });

  // ── 5. Platform config 目录 → READ_ONLY（优先于工作区 FULL）──────
  rules.push({
    path: path.join(platformHome, "config") + sep,
    level: "READ_ONLY",
    reason: "Platform configuration directory",
  });

  // ── 6. Session 工作目录 → FULL ─────────────────────────────────────
  const cwd = workspaceCwd ?? agentSettings.defaultCwd;
  if (cwd !== null && cwd !== undefined) {
    rules.push({
      path: path.resolve(cwd) + sep,
      level: "FULL",
      reason: "Session working directory",
    });
  }

  // ── 7. 兜底 → BLOCKED（未匹配一律拒绝，fail-closed）─────────────────
  // 不再有 allowExternalReads 全局标志——外部读取必须经由显式的 extraReadPaths 授权

  return {
    rules,
    defaultLevel: "BLOCKED",
    allowExternalReads: false,
  };
}
