import * as path from "node:path";

import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { AccessLevel, PathRule } from "../../contracts/sandbox.js";
import { defaultSandboxCapabilities } from "../../contracts/sandbox.js";
import type { AgentStore } from "../../config/agent-store.js";
import type { RuntimePaths } from "../../config/paths.js";
import { buildPathGuardPolicy } from "../../sandbox/policy.js";

/** 脱敏后的规则条目：不含内部绝对路径，只暴露 level 和 reason */
interface SanitizedRule {
  readonly level: AccessLevel;
  readonly reason: string;
}

interface SanitizedPolicy {
  readonly rules: readonly SanitizedRule[];
  readonly defaultLevel: AccessLevel;
  readonly allowExternalReads: boolean;
}

/**
 * 脱敏单条规则：只保留 level 和 reason，移除内部绝对路径。
 */
function sanitizeRule(rule: PathRule): SanitizedRule {
  return {
    level: rule.level,
    reason: rule.reason,
  };
}

export function registerSandboxRoutes(
  app: Hono,
  agentStore: AgentStore,
  paths: RuntimePaths,
): void {
  // GET /api/sandbox/status — 返回沙箱状态
  app.get("/api/sandbox/status", (context) => {
    try {
      return context.json({
        enabled: true,
        backend: "path-guard",
        capabilities: defaultSandboxCapabilities(),
      });
    } catch {
      return context.json(
        createApiError("INTERNAL_ERROR", "无法获取沙箱状态"),
        500,
      );
    }
  });

  // GET /api/sandbox/rules/:agentId — 返回指定 Agent 的 PathGuard 规则（脱敏）
  app.get("/api/sandbox/rules/:agentId", (context) => {
    try {
      const agentId = context.req.param("agentId");
      const settings = agentStore.getSettings(agentId);
      const agentHomeDir = path.join(paths.agents, agentId);

      const policy = buildPathGuardPolicy({
        agentSettings: settings,
        agentHomeDir,
        platformHome: paths.home,
      });

      const sanitized: SanitizedPolicy = {
        rules: policy.rules.map((rule) => sanitizeRule(rule)),
        defaultLevel: policy.defaultLevel,
        allowExternalReads: policy.allowExternalReads,
      };

      return context.json(sanitized);
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });
}
