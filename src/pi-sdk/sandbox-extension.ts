/**
 * 沙箱工具包装扩展。
 *
 * PI SDK 加载本扩展时，会调用 default export 并传入 ExtensionAPI。
 * 我们对 read / bash / write / edit / grep / find / ls 七个内置工具
 * 逐一用同名 registerTool 覆盖，在执行前插入 PathGuard 检查。
 *
 * 由于扩展是进程级加载一次，当前会话的 ToolPolicy 通过全局变量传递。
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

import type { ToolPolicy } from "../runtime/tool-policy.js";

/** 当前活跃的 ToolPolicy 实例。在每次 Prompt 前由调用方设置。 */
let currentToolPolicy: ToolPolicy | null = null;

export function setSandboxToolPolicy(policy: ToolPolicy | null): void {
  currentToolPolicy = policy;
}

/** 检查文件路径的沙箱权限，拒绝时抛出友好错误。 */
function guardFile(operation: "read" | "write", targetPath: unknown): void {
  if (!currentToolPolicy) return;
  if (typeof targetPath !== "string" || targetPath.length === 0) return;
  currentToolPolicy.assertFilePath(operation, targetPath);
}

/** 检查 bash 命令的 preflight 权限。 */
function guardBash(command: unknown): void {
  if (!currentToolPolicy) return;
  if (typeof command !== "string" || command.length === 0) return;
  const result = currentToolPolicy.checkBashCommand(command);
  if (!result.allowed) {
    throw new Error(`Sandbox blocked bash command: ${result.reason}`);
  }
}

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

  // ── bash ──
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

  // ── grep ──
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

  // ── find ──
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

  // ── ls ──
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
