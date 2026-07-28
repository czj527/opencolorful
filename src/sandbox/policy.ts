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
 *  4. Agent defaultCwd              — Agent 工作目录（FULL）
 *  5. Agent 自身数据目录            — READ_WRITE
 *  6. Platform config 目录           — READ_ONLY
 *  7. 兜底 defaultLevel             — allowExternalReads 决定
 */
export function buildPathGuardPolicy(params: {
  agentSettings: AgentSettingsV2;
  agentHomeDir: string;
  platformHome: string;
}): PathGuardPolicy {
  const { agentSettings, agentHomeDir, platformHome } = params;
  const sandbox = agentSettings.sandbox ?? defaultSandboxCapabilities();
  const home = os.homedir();

  const rules: PathRule[] = [];

  // ── 1. 绝对 BLOCKED 清单 ──────────────────────────────────────────
  // ~/.ssh
  rules.push({
    path: path.join(home, ".ssh"),
    level: "BLOCKED",
    reason: "SSH keys directory is blocked",
  });

  // ~/.aws
  rules.push({
    path: path.join(home, ".aws"),
    level: "BLOCKED",
    reason: "AWS credentials directory is blocked",
  });

  // platform auth/ 目录（子树匹配）
  rules.push({
    path: path.join(platformHome, "auth") + path.sep,
    level: "BLOCKED",
    reason: "Platform auth directory is blocked",
  });

  // /etc/shadow（仅 Linux）
  if (process.platform === "linux") {
    rules.push({
      path: "/etc/shadow",
      level: "BLOCKED",
      reason: "System password file is blocked",
    });
  }

  // .env 文件（精确匹配 — 解析后的绝对路径）
  // 注：默认 protectedPaths 中已包含 ".env"，此处额外显式加入 BLOCKED 清单
  //     resolve 基于 cwd，构建时由调用方保证 cwd 稳定
  rules.push({
    path: path.resolve(".env"),
    level: "BLOCKED",
    reason: "Environment files are blocked",
  });

  // ── 2. Agent protectedPaths → BLOCKED ────────────────────────────
  for (const p of sandbox.protectedPaths) {
    rules.push({
      path: path.resolve(p),
      level: "BLOCKED",
      reason: `Protected path: ${p}`,
    });
  }

  // ── 3. Agent extraReadPaths → READ_ONLY ──────────────────────────
  for (const p of sandbox.extraReadPaths) {
    rules.push({
      path: path.resolve(p),
      level: "READ_ONLY",
      reason: `Extra read path: ${p}`,
    });
  }

  // ── 4. Agent 工作目录 → FULL ─────────────────────────────────────
  if (agentSettings.defaultCwd !== null) {
    rules.push({
      path: path.resolve(agentSettings.defaultCwd) + path.sep,
      level: "FULL",
      reason: "Agent working directory",
    });
  }

  // ── 5. Agent 数据目录 → READ_WRITE ───────────────────────────────
  rules.push({
    path: path.resolve(agentHomeDir) + path.sep,
    level: "READ_WRITE",
    reason: "Agent home directory",
  });

  // ── 6. Platform config 目录 → READ_ONLY ──────────────────────────
  rules.push({
    path: path.join(platformHome, "config") + path.sep,
    level: "READ_ONLY",
    reason: "Platform configuration directory",
  });

  // ── 7. 兜底级别 ──────────────────────────────────────────────────
  const allowExternalReads = sandbox.extraReadPaths.length > 0;
  const defaultLevel: AccessLevel = allowExternalReads ? "READ_ONLY" : "BLOCKED";

  return {
    rules,
    defaultLevel,
    allowExternalReads,
  };
}
