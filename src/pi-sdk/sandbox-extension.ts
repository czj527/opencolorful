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

export interface SandboxContext {
  readonly toolPolicy: ToolPolicy;
  readonly sessionCwd: string;
  readonly allowBash: boolean;
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
      ctx.toolPolicy.assertFilePath("write", absPath);
      return origWrite.execute(toolCallId, { ...p, path: absPath } as any, signal, onUpdate);
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
      ctx.toolPolicy.assertFilePath("write", absPath);
      return origEdit.execute(toolCallId, { ...p, path: absPath } as any, signal, onUpdate);
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
