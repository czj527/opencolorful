/**
 * Skill Core 工具扩展（per-Session 隔离）。
 *
 * 五个工具：
 * - search_skills：五层搜索（bound → managed → workspace → plugin → remote），
 *   只返回结构化候选，绝不递归触发安装；
 * - inspect_skill：来源/已安装 Skill 的 provenance、Manifest、依赖、风险与
 *   兼容等级；readBody 时经 loadHandle + SkillContentService 受控读取正文；
 * - install_skill：inspect → stage → validate → 风险审查 → 学习策略 →
 *   一次性确认令牌 → 安装 → 绑定/激活授权 → loadHandle；返回四态结构化结果；
 * - manage_skills：只管理当前 Agent 的绑定与选择模式；
 *   停用/解绑/固定版本迁移需要用户确认（确认令牌或 confirmed 标志）；
 * - manage_skill_bundle：list / create-version / bind / migrate；
 *   只创建新版本，不原地覆盖已发布 Bundle。
 *
 * 上下文注入模仿 memory-tools 的 global-Symbol state 模式，
 * 确保 jiti 加载的扩展与 ESM 加载的 AgentSession 看到同一张表。
 */

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import Value from "typebox/value";

import type { SkillCoreService } from "../runtime/skills/core/skill-core-service.js";
import {
  SkillBundleManageArgsSchema,
  SkillInstallArgsSchema,
  SkillInspectArgsSchema,
  SkillManageArgsSchema,
  SkillSearchArgsSchema,
  type SkillBundleManageArgs,
  type SkillInstallArgs,
  type SkillInspectArgs,
  type SkillManageArgs,
  type SkillSearchArgs,
} from "../runtime/skills/core/skill-core-service.js";
import { extractReasonCode } from "../runtime/skills/core/skill-core-service.js";
import { currentTrace } from "../observability/trace-context.js";

// ═══════════════════════════════════════════════════════════════
// SkillContext
// ═══════════════════════════════════════════════════════════════

export interface SkillContext {
  readonly core: SkillCoreService;
  readonly sessionId: string;
  /** 会话绑定的 Agent（无 Agent 会话为 undefined） */
  readonly agentId?: string;
  /** 显式当前 turn（测试/宿主注入）；缺省取 trace operationId 或生成 */
  readonly turnId?: string;
}

interface SkillContextState {
  readonly storage: AsyncLocalStorage<SkillContext>;
  readonly sessionContexts: Map<string, SkillContext>;
}

const STATE_KEY = Symbol.for("opencolorful.skill-context-state");
const globalState = globalThis as typeof globalThis & Record<symbol, unknown>;
let state = globalState[STATE_KEY] as SkillContextState | undefined;
if (!state) {
  state = {
    storage: new AsyncLocalStorage<SkillContext>(),
    sessionContexts: new Map<string, SkillContext>(),
  };
  globalState[STATE_KEY] = state;
}

const storage = state.storage;
const sessionContexts = state.sessionContexts;

/** 在直接调用/测试的异步上下文中注入 Skill 上下文。 */
export function runWithSkillContext<T>(ctx: SkillContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * 将生产 Session 与其 Skill 上下文绑定。清理函数只删除同一份上下文，
 * 避免旧 Runtime dispose 时误删已重建的新 Runtime。
 */
export function registerSkillContext(
  sessionId: string,
  ctx: SkillContext,
): () => void {
  sessionContexts.set(sessionId, ctx);
  return () => {
    if (sessionContexts.get(sessionId) === ctx) {
      sessionContexts.delete(sessionId);
    }
  };
}

/** 获取当前 Skill 上下文。生产执行按 sessionId 精确匹配并 fail-closed。 */
function requireContext(executionContext?: ExtensionContext): SkillContext {
  if (executionContext) {
    const sessionId = executionContext.sessionManager.getSessionId();
    const registered = sessionContexts.get(sessionId);
    if (!registered) {
      throw new Error("Skill 工具上下文未就绪，工具调用被阻止");
    }
    return registered;
  }

  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error("Skill 工具上下文未就绪，工具调用被阻止");
  }
  return ctx;
}

/** 当前 turn：上下文显式值 > trace operationId（SessionRuntime turn）> 生成。 */
function resolveTurnId(ctx: SkillContext): string {
  if (ctx.turnId !== undefined) {
    return ctx.turnId;
  }
  const trace = currentTrace();
  if (trace !== undefined && trace.operationId !== undefined) {
    return trace.operationId;
  }
  return `turn-${crypto.randomUUID()}`;
}

/** Helper to return a tool result with text content. */
function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

/** 结构化失败结果（稳定 reasonCode，不走自由文本）。 */
function structuredFailure(params: { readonly reasonCode: string; readonly reason: string }): ReturnType<typeof textResult> {
  return textResult(
    JSON.stringify(
      {
        status: "failed",
        reasonCode: params.reasonCode,
        reason: params.reason,
      },
      null,
      2,
    ),
  );
}

/** 参数校验失败（fail-closed：非法输入不进入领域层）。 */
function invalidArgs(what: string): ReturnType<typeof textResult> {
  return structuredFailure({ reasonCode: "skill_operation_failed", reason: `参数校验失败（${what}）` });
}

// ═══════════════════════════════════════════════════════════════
// Extension entry
// ═══════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI): void {
  // ── search_skills ───────────────────────────────────────────
  pi.registerTool({
    name: "search_skills",
    label: "search_skills",
    description:
      "搜索可用 Skill。按顺序覆盖五层来源：当前 Agent 已绑定 → 本地 Managed Store → 当前工作区/可信兼容目录 → 已启用 Plugin Skill Bundle → 远程来源（T9 接入，当前不可用）。只返回结构化候选（来源/版本/哈希/风险/readiness），搜索结果缺 Skill 不会递归触发安装；安装是单独的 install_skill 动作。scope 可限定单层（bound/managed/workspace/plugin/remote）。",
    parameters: SkillSearchArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      if (!Value.Check(SkillSearchArgsSchema, params)) {
        return invalidArgs("query/scope");
      }
      const raw = params as SkillSearchArgs;
      const result = ctx.core.search({
        ...(raw.query !== undefined ? { query: raw.query } : {}),
        ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        sessionId: ctx.sessionId,
      });
      return textResult(JSON.stringify(result, null, 2));
    },
  });

  // ── inspect_skill ───────────────────────────────────────────
  pi.registerTool({
    name: "inspect_skill",
    label: "inspect_skill",
    description:
      "检查 Skill 来源或已安装 Skill：读取 provenance、Manifest、依赖、风险摘要与兼容等级（SkillInstaller.inspectSource + Catalog 精确解析）。sourceRef 需要 kind（local/archive/git/http/session-file）；已登记的 skillRef 直接解析。readBody=true 时经 loadHandle + SkillContentService 受控读取 SKILL.md 正文（只能读取已登记的 skillRef）。",
    parameters: SkillInspectArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      if (!Value.Check(SkillInspectArgsSchema, params)) {
        return invalidArgs("sourceRef/kind/skillRef/readBody");
      }
      const raw = params as SkillInspectArgs;
      const result = await ctx.core.inspect({
        ...(raw.sourceRef !== undefined ? { sourceRef: raw.sourceRef } : {}),
        ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
        ...(raw.skillRef !== undefined ? { skillRef: raw.skillRef } : {}),
        ...(raw.readBody === true ? { readBody: true } : {}),
        // T12（P0-2）：readBody 优先消费安装结果返回的 loadHandle（一次性句柄）
        ...(raw.loadHandle !== undefined ? { loadHandle: raw.loadHandle } : {}),
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        sessionId: ctx.sessionId,
        turnId: resolveTurnId(ctx),
      });
      return textResult(JSON.stringify(result, null, 2));
    },
  });

  // ── install_skill ───────────────────────────────────────────
  pi.registerTool({
    name: "install_skill",
    label: "install_skill",
    description:
      "安装 Skill。只接受完整 package 来源（kind: local/archive/git/http/session-file；session-file 必须已登记 fileKey）。流程：检查 → 暂存 → 校验 → 风险审查 → 按学习策略决定确认（ask-always 必确认；ask-on-risk 低风险可信直接装，否则确认）→ 一次性确认令牌 → 安装 → 绑定当前 Agent/Session → 激活授权 + loadHandle。返回结构化四态：installed / confirmation_required / rejected / failed + skillRef + operationId + agentBinding + activationGrant + loadHandle + reasonCode。只有 status=installed 且带精确 skillRef 才能声明安装成功；confirmation_required 时先由用户确认，再用返回的 token 重试。",
    parameters: SkillInstallArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      if (!Value.Check(SkillInstallArgsSchema, params)) {
        return invalidArgs("sourceRef/kind/confirmationToken");
      }
      const raw = params as SkillInstallArgs;
      const result = ctx.core.install({
        sourceRef: raw.sourceRef,
        kind: raw.kind,
        ...(raw.confirmationToken !== undefined ? { confirmationToken: raw.confirmationToken } : {}),
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        sessionId: ctx.sessionId,
        turnId: resolveTurnId(ctx),
      });
      return textResult(JSON.stringify(result, null, 2));
    },
  });

  // ── manage_skills ───────────────────────────────────────────
  pi.registerTool({
    name: "manage_skills",
    label: "manage_skills",
    description:
      "管理当前 Agent 的 Skill 绑定与选择模式（只允许操作当前 Agent）。action: list（查看绑定/选择/学习策略）、bind（绑定精确 skillRef，无需确认）、set-selection（implicit/explicit-only/disabled；disabled 停用需要用户确认）、unbind/request-unbind（解绑需要用户确认，未确认返回 confirmation_required + 一次性确认令牌，用户确认后用 token 重试）。",
    parameters: SkillManageArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      if (!Value.Check(SkillManageArgsSchema, params)) {
        return invalidArgs("action/skillRef/skillRefKey/selection/confirmationToken");
      }
      const raw = params as SkillManageArgs;
      if (ctx.agentId === undefined) {
        return structuredFailure({ reasonCode: "skill_agent_unauthorized", reason: "当前会话未绑定 Agent，无法管理 Agent Skill" });
      }
      const result = ctx.core.manageSkills({
        action: raw.action,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        ...(raw.skillRef !== undefined ? { skillRef: raw.skillRef } : {}),
        ...(raw.skillRefKey !== undefined ? { skillRefKey: raw.skillRefKey } : {}),
        ...(raw.selection !== undefined ? { selection: raw.selection } : {}),
        ...(raw.confirmationToken !== undefined ? { confirmationToken: raw.confirmationToken } : {}),
      });
      return textResult(JSON.stringify(result, null, 2));
    },
  });

  // ── manage_skill_bundle ─────────────────────────────────────
  pi.registerTool({
    name: "manage_skill_bundle",
    label: "manage_skill_bundle",
    description:
      "管理 Skill Bundle（版本化组合）。action: list（查看 Bundle 版本或当前 Agent 的 Bundle 绑定）、create-version（创建新版本，绝不原地覆盖已发布 Bundle）、bind（绑定 Bundle 版本到当前 Agent）、migrate（固定版本迁移，需要用户确认；未确认返回 confirmation_required + 一次性确认令牌）。",
    parameters: SkillBundleManageArgsSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      if (!Value.Check(SkillBundleManageArgsSchema, params)) {
        return invalidArgs("action/bundleId/name/items/version/fromVersion/toVersion/confirmationToken");
      }
      const raw = params as SkillBundleManageArgs;
      const result = ctx.core.manageBundle({
        action: raw.action,
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        sessionId: ctx.sessionId,
        ...(raw.bundleId !== undefined ? { bundleId: raw.bundleId } : {}),
        ...(raw.name !== undefined ? { name: raw.name } : {}),
        ...(raw.items !== undefined ? { items: raw.items } : {}),
        ...(raw.version !== undefined ? { version: raw.version } : {}),
        ...(raw.fromVersion !== undefined ? { fromVersion: raw.fromVersion } : {}),
        ...(raw.toVersion !== undefined ? { toVersion: raw.toVersion } : {}),
        ...(raw.confirmationToken !== undefined ? { confirmationToken: raw.confirmationToken } : {}),
      });
      return textResult(JSON.stringify(result, null, 2));
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// 便捷导出（agent-session.ts / messages.ts 接线用）
// ═══════════════════════════════════════════════════════════════

/** Skill Core 工具名称（extraTools 注册路径：平台提供，不是插件自定义工具）。 */
export const SKILL_TOOL_NAMES = [
  "search_skills",
  "inspect_skill",
  "install_skill",
  "manage_skills",
  "manage_skill_bundle",
] as const;

/** 统一失败 reasonCode（工具层与路由共用的兜底）。 */
export { extractReasonCode };
