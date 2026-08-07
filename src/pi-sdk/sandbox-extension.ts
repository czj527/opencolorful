/**
 * 沙箱工具包装扩展（per-Session 隔离）。
 *
 * 每个工具在执行前：
 * 1. 从 PI ExtensionContext 的 sessionId 查找 cwd + ToolPolicy
 *    （直接调用扩展时回退到 AsyncLocalStorage）
 * 2. 将工具 path 参数基于 sessionCwd 解析为绝对路径
 * 3. 用同一个绝对路径做 PathGuard 检查和原始工具执行
 *
 * 沙箱模式下所有 guard 均 fail-closed：缺上下文、缺策略时直接抛错。
 */

import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import type { ToolPolicy } from "../runtime/tool-policy.js";
import type { SkillFileReadOutcome } from "./types.js";

export interface SandboxContext {
  readonly toolPolicy: ToolPolicy;
  readonly sessionCwd: string;
  readonly allowBash: boolean;
  /**
   * T11（P0-2）：read 工具的 Skill 文件受控读取端口。
   * - ok → 直接返回正文（SkillContentService 哈希/预算校验已执行）；
   * - not-a-skill-file → 回退普通沙箱读取（不改变普通文件行为）；
   * - denied → 命中 Skill 根但读取被拒，抛错（fail-closed，绝不回退裸读）。
   */
  readonly skillRead?: (input: { readonly absPath: string }) => Promise<SkillFileReadOutcome>;
  /**
   * T9b（Phase 14 §18.3）：工作区写 Lease 守卫（父 Agent 写 Tool 接入
   * WorkspaceMutationLeaseService）。write/edit/bash 执行入口调用：
   * - allowed=false → 拒绝执行（Subagent write Run 独占 Lease 占用中，fail-closed）；
   * - allowed=true → 执行原工具，finally 调 release() 释放 operation-scoped permit。
   * 缺省（未注入）→ 不检查（无 Subagent 运行时的会话不受影响）。
   */
  readonly workspaceLeaseGuard?: (input: {
    readonly toolName: "write" | "edit" | "bash";
    readonly absPath?: string;
  }) => { readonly allowed: boolean; readonly reason?: string; readonly release?: () => void };
}

/**
 * T11（P0-2）：外部（SessionRuntime）注入的沙箱上下文扩展——目前允许
 * skillRead（受控读取端口）与 workspaceLeaseGuard（§18.3 写互斥端口）；
 * toolPolicy/sessionCwd/allowBash 一律由 agent-session 内部构造，
 * 防止外部伪造沙箱策略。
 */
export interface SandboxContextOverrides {
  readonly skillRead?: (input: { readonly absPath: string }) => Promise<SkillFileReadOutcome>;
  readonly workspaceLeaseGuard?: SandboxContext["workspaceLeaseGuard"];
}

interface SandboxContextState {
  readonly storage: AsyncLocalStorage<SandboxContext>;
  readonly sessionContexts: Map<string, SandboxContext>;
}

// 扩展由 jiti 加载，而 AgentSession 由 ESM 加载；两者可能是同一文件的不同
// 模块实例。通过全局 Symbol 共享状态，确保注册与工具执行看到同一张表。
const STATE_KEY = Symbol.for("opencolorful.sandbox-context-state");
const globalState = globalThis as typeof globalThis & Record<symbol, unknown>;
let state = globalState[STATE_KEY] as SandboxContextState | undefined;
if (!state) {
  state = {
    storage: new AsyncLocalStorage<SandboxContext>(),
    sessionContexts: new Map<string, SandboxContext>(),
  };
  globalState[STATE_KEY] = state;
}

const storage = state.storage;
const sessionContexts = state.sessionContexts;

/** 在直接调用/测试的异步上下文中注入沙箱上下文。 */
export function runWithSandboxContext<T>(ctx: SandboxContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * 将生产 Session 与其沙箱策略绑定。清理函数只删除同一份上下文，
 * 避免旧 Runtime dispose 时误删已重建的新 Runtime。
 */
export function registerSandboxContext(
  sessionId: string,
  ctx: SandboxContext,
): () => void {
  sessionContexts.set(sessionId, ctx);
  return () => {
    if (sessionContexts.get(sessionId) === ctx) {
      sessionContexts.delete(sessionId);
    }
  };
}

/** 获取当前上下文。生产执行按 sessionId 精确匹配并 fail-closed。 */
function requireContext(executionContext?: ExtensionContext): SandboxContext {
  if (executionContext) {
    const sessionId = executionContext.sessionManager.getSessionId();
    const registered = sessionContexts.get(sessionId);
    if (!registered) {
      throw new Error("Sandbox: session context missing — tool execution blocked");
    }
    return registered;
  }

  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error("Sandbox: session context missing — tool execution blocked");
  }
  return ctx;
}

/**
 * 解析工具 path 参数为绝对路径（基于 sessionCwd）。
 * 空/null/undefined → sessionCwd。
 */
function resolvePath(raw: unknown, ctx: SandboxContext): string {
  if (typeof raw === "string" && raw.length > 0) {
    return path.resolve(ctx.sessionCwd, raw);
  }
  return ctx.sessionCwd;
}

/**
 * T9b（§18.3）：写工具执行入口的工作区写 Lease 检查。
 * 返回 release 函数（工具执行完成后 finally 释放）；denied → 抛错（fail-closed）。
 */
function guardWorkspaceWrite(
  ctx: SandboxContext,
  toolName: "write" | "edit" | "bash",
  absPath: string | undefined,
): (() => void) | undefined {
  const guard = ctx.workspaceLeaseGuard;
  if (guard === undefined) {
    return undefined;
  }
  const outcome = guard({ toolName, ...(absPath !== undefined ? { absPath } : {}) });
  if (!outcome.allowed) {
    throw new Error(`Sandbox: 工作区写 Lease 被占用，写操作被拒绝（${outcome.reason ?? "unknown"}）`);
  }
  return outcome.release;
}

/**
 * PI SDK 扩展入口。进程级加载一次，工具执行时按 ExtensionContext 中的
 * sessionId 读取 per-Session 上下文。所有路径均以 sessionCwd 解析。
 */
export default function (pi: ExtensionAPI): void {
  // 所有原始工具基于 sessionCwd 创建——但这里拿不到 sessionCwd。
  // 因此改为在 execute 内部动态解析路径并传递给原始工具。
  // 原始工具的 cwd 参数影响默认路径，我们用 sessionCwd 解析后显式传参即可。

  const fallbackCwd = process.cwd();

  // ── read ──
  const origRead = createReadTool(fallbackCwd);
  pi.registerTool({
    name: "read",
    label: "read",
    description: origRead.description,
    parameters: origRead.parameters,
    async execute(toolCallId, params, signal, onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      const p = params as Record<string, unknown>;
      const absPath = resolvePath(p.path, ctx);
      // T11（P0-2）：Skill 文件优先走受控读取（成员/哈希/预算校验）。
      // 三态：ok 直接返回；not-a-skill-file 回退普通沙箱读取；denied 抛错
      // （命中 Skill 根但读取被拒——fail-closed，绝不回退裸读绕过校验）。
      if (ctx.skillRead !== undefined) {
        const outcome = await ctx.skillRead({ absPath });
        if (outcome.status === "ok") {
          return {
            content: [
              {
                type: "text" as const,
                text: outcome.body,
                ...(outcome.truncated ? { truncated: true } : {}),
              },
            ],
            details: undefined,
          };
        }
        if (outcome.status === "denied") {
          throw new Error(`Skill read denied (${outcome.reasonCode}): ${outcome.reason}`);
        }
      }
      ctx.toolPolicy.assertFilePath("read", absPath);
      return origRead.execute(toolCallId, { ...p, path: absPath }, signal, onUpdate);
    },
  });

  // ── bash（sandbox 模式禁用，待 OS 沙箱就绪） ──
  const origBash = createBashTool(fallbackCwd);
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: origBash.description,
    parameters: origBash.parameters,
    async execute(toolCallId, params, signal, onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      // T9b（§18.3）：bash 是 workspace-write 工具，先过写 Lease 守卫
      const releaseBash = guardWorkspaceWrite(ctx, "bash", undefined);
      try {
        if (!ctx.allowBash) {
          const p = params as Record<string, unknown>;
          const command = typeof p.command === "string" ? p.command : "";
          ctx.toolPolicy.recordBashDenied(command, "bash-disabled");
          throw new Error("Sandbox: bash is disabled (OS sandbox not yet available)");
        }
        const p = params as Record<string, unknown>;
        if (typeof p.command === "string") {
          const result = ctx.toolPolicy.checkBashCommand(p.command);
          if (!result.allowed) {
            throw new Error(`Sandbox blocked bash command: ${result.reason}`);
          }
        }
        return origBash.execute(toolCallId, params, signal, onUpdate);
      } finally {
        releaseBash?.();
      }
    },
  });

  // ── write ──
  const origWrite = createWriteTool(fallbackCwd);
  pi.registerTool({
    name: "write",
    label: "write",
    description: origWrite.description,
    parameters: origWrite.parameters,
    async execute(toolCallId, params, signal, onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      const p = params as Record<string, unknown>;
      const absPath = resolvePath(p.path, ctx);
      // T9b（§18.3）：写工具执行入口先过工作区写 Lease 守卫（占用中 fail-closed）
      const releaseWrite = guardWorkspaceWrite(ctx, "write", absPath);
      try {
        ctx.toolPolicy.assertFilePath("write", absPath);
        return origWrite.execute(toolCallId, { ...p, path: absPath } as any, signal, onUpdate);
      } finally {
        releaseWrite?.();
      }
    },
  });

  // ── edit ──
  const origEdit = createEditTool(fallbackCwd);
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: origEdit.description,
    parameters: origEdit.parameters,
    async execute(toolCallId, params, signal, onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      const p = params as Record<string, unknown>;
      const absPath = resolvePath(p.path, ctx);
      // T9b（§18.3）：写工具执行入口先过工作区写 Lease 守卫（占用中 fail-closed）
      const releaseEdit = guardWorkspaceWrite(ctx, "edit", absPath);
      try {
        ctx.toolPolicy.assertFilePath("write", absPath);
        return origEdit.execute(toolCallId, { ...p, path: absPath } as any, signal, onUpdate);
      } finally {
        releaseEdit?.();
      }
    },
  });

  // ── grep ──
  const origGrep = createGrepTool(fallbackCwd);
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: origGrep.description,
    parameters: origGrep.parameters,
    async execute(toolCallId, params, signal, onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      const p = params as Record<string, unknown>;
      const absPath = resolvePath(p.path, ctx);
      ctx.toolPolicy.assertFilePath("read", absPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origGrep.execute(toolCallId, { ...p, path: absPath } as any, signal, onUpdate);
    },
  });

  // ── find ──
  const origFind = createFindTool(fallbackCwd);
  pi.registerTool({
    name: "find",
    label: "find",
    description: origFind.description,
    parameters: origFind.parameters,
    async execute(toolCallId, params, signal, onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      const p = params as Record<string, unknown>;
      const absPath = resolvePath(p.path, ctx);
      ctx.toolPolicy.assertFilePath("read", absPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origFind.execute(toolCallId, { ...p, path: absPath } as any, signal, onUpdate);
    },
  });

  // ── ls ──
  const origLs = createLsTool(fallbackCwd);
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: origLs.description,
    parameters: origLs.parameters,
    async execute(toolCallId, params, signal, onUpdate, executionContext) {
      const ctx = requireContext(executionContext);
      const p = params as Record<string, unknown>;
      const absPath = resolvePath(p.path, ctx);
      ctx.toolPolicy.assertFilePath("read", absPath);
      return origLs.execute(toolCallId, { ...p, path: absPath }, signal, onUpdate);
    },
  });
}
