/**
 * 沙箱工具包装扩展（per-Session 隔离，通过 AsyncLocalStorage）。
 *
 * 每个工具在执行前：
 * 1. 从 AsyncLocalStorage 读取当前 Session 的 cwd + ToolPolicy
 * 2. 将工具 path 参数基于 sessionCwd 解析为绝对路径
 * 3. 用同一个绝对路径做 PathGuard 检查和原始工具执行
 *
 * 沙箱模式下所有 guard 均 fail-closed：缺上下文、缺策略时直接抛错。
 */

import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const storage = new AsyncLocalStorage<SandboxContext>();

/** 在异步上下文中运行回调，注入沙箱上下文 */
export function runWithSandboxContext<T>(ctx: SandboxContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 获取当前上下文。沙箱模式下必须存在（fail-closed）。 */
function requireContext(): SandboxContext {
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
 * PI SDK 扩展入口。进程级加载一次，工具执行时从 AsyncLocalStorage 读取
 * per-Session 上下文。所有原始工具统一基于 sessionCwd 创建（而非 process.cwd）。
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
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = requireContext();
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
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = requireContext();
      if (!ctx.allowBash) {
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
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = requireContext();
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
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = requireContext();
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
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = requireContext();
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
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = requireContext();
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
    async execute(toolCallId, params, signal, onUpdate) {
      const ctx = requireContext();
      const p = params as Record<string, unknown>;
      const absPath = resolvePath(p.path, ctx);
      ctx.toolPolicy.assertFilePath("read", absPath);
      return origLs.execute(toolCallId, { ...p, path: absPath }, signal, onUpdate);
    },
  });
}
