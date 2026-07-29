/**
 * 沙箱工具包装扩展（per-Session 闭包模式，通过 AsyncLocalStorage 隔离）。
 *
 * 本模块导出一个默认 PI SDK 扩展，在工具执行时从异步上下文读取当前
 * Session 的 ToolPolicy，彻底消除进程级全局变量导致的跨 Session 权限串线。
 */

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
import { AsyncLocalStorage } from "node:async_hooks";

import type { ToolPolicy } from "../runtime/tool-policy.js";

/**
 * 每 Session 的沙箱上下文。
 * 在 Prompt 前由 agent-session.ts 写入，工具 execute 时读取。
 */
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

/** 获取当前异步上下文中的沙箱上下文 */
function getContext(): SandboxContext | undefined {
  return storage.getStore();
}

/** 检查文件路径的沙箱权限。空路径默认用 sessionCwd。 */
function guardFile(operation: "read" | "write", targetPath: unknown): void {
  const ctx = getContext();
  if (!ctx) return;
  const resolvedPath = typeof targetPath === "string" && targetPath.length > 0
    ? targetPath
    : ctx.sessionCwd;
  ctx.toolPolicy.assertFilePath(operation, resolvedPath);
}

/** 检查 bash 命令。sandbox 模式下允许 preflight 检查但不阻止路径逃逸。 */
function guardBash(command: unknown): void {
  const ctx = getContext();
  if (!ctx) return;
  if (!ctx.allowBash) {
    throw new Error("Sandbox: bash is disabled (OS sandbox not yet available)");
  }
  if (typeof command === "string" && command.length > 0) {
    const result = ctx.toolPolicy.checkBashCommand(command);
    if (!result.allowed) {
      throw new Error(`Sandbox blocked bash command: ${result.reason}`);
    }
  }
}

/**
 * PI SDK 扩展入口。进程级加载一次，工具执行时从 AsyncLocalStorage 读取
 * per-Session 上下文。
 */
export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();

  // ── read ──
  const origRead = createReadTool(cwd);
  pi.registerTool({
    name: "read",
    label: "read",
    description: origRead.description,
    parameters: origRead.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      guardFile("read", (params as Record<string, unknown>).file_path ?? (params as Record<string, unknown>).path);
      return origRead.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // ── bash（sandbox 模式默认禁用，待 OS 沙箱就绪） ──
  const origBash = createBashTool(cwd);
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: origBash.description,
    parameters: origBash.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      guardBash((params as Record<string, unknown>).command);
      return origBash.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // ── write ──
  const origWrite = createWriteTool(cwd);
  pi.registerTool({
    name: "write",
    label: "write",
    description: origWrite.description,
    parameters: origWrite.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      guardFile("write", (params as Record<string, unknown>).file_path ?? (params as Record<string, unknown>).path);
      return origWrite.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // ── edit ──
  const origEdit = createEditTool(cwd);
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: origEdit.description,
    parameters: origEdit.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      guardFile("write", (params as Record<string, unknown>).file_path ?? (params as Record<string, unknown>).path);
      return origEdit.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // ── grep（空 path 默认 sessionCwd） ──
  const origGrep = createGrepTool(cwd);
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: origGrep.description,
    parameters: origGrep.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      guardFile("read", (params as Record<string, unknown>).path);
      return origGrep.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // ── find（空 path 默认 sessionCwd） ──
  const origFind = createFindTool(cwd);
  pi.registerTool({
    name: "find",
    label: "find",
    description: origFind.description,
    parameters: origFind.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      guardFile("read", (params as Record<string, unknown>).path);
      return origFind.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // ── ls（空 path 默认 sessionCwd） ──
  const origLs = createLsTool(cwd);
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: origLs.description,
    parameters: origLs.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      guardFile("read", (params as Record<string, unknown>).path);
      return origLs.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
