import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  discoverAndLoadExtensions,
  type AgentSessionEvent,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ContextUsage, TokenUsage } from "../contracts/events.js";
import type { FileOperation } from "../contracts/sandbox.js";
import type { ToolPolicy } from "../runtime/tool-policy.js";
import type { SandboxContext, SandboxContextOverrides } from "./sandbox-extension.js";
import {
  registerSandboxContext,
  runWithSandboxContext,
} from "./sandbox-extension.js";
import type {
  PiAgentEvent,
  PiAgentSessionHandle,
  PiAgentSessionOptions,
  PiFauxAgentOptions,
  PiResourceSkills,
  PiSessionUsageStats,
  PluginSessionTool,
  SkillFileReadOutcome,
} from "./types.js";
import { getSessionManager } from "./session-manager-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 沙箱扩展文件路径：开发环境 .ts，生产构建 .js
const SANDBOX_EXTENSION_JS = path.resolve(__dirname, "sandbox-extension.js");
const SANDBOX_EXTENSION_TS = path.resolve(__dirname, "sandbox-extension.ts");
const SANDBOX_EXTENSION_PATH = fs.existsSync(SANDBOX_EXTENSION_JS)
  ? SANDBOX_EXTENSION_JS
  : SANDBOX_EXTENSION_TS;

// 记忆工具扩展文件路径
const MEMORY_TOOLS_EXTENSION_JS = path.resolve(__dirname, "memory-tools.js");
const MEMORY_TOOLS_EXTENSION_TS = path.resolve(__dirname, "memory-tools.ts");
const MEMORY_TOOLS_EXTENSION_PATH = fs.existsSync(MEMORY_TOOLS_EXTENSION_JS)
  ? MEMORY_TOOLS_EXTENSION_JS
  : MEMORY_TOOLS_EXTENSION_TS;

// Skill Core 工具扩展文件路径
const SKILL_TOOLS_EXTENSION_JS = path.resolve(__dirname, "skill-tools.js");
const SKILL_TOOLS_EXTENSION_TS = path.resolve(__dirname, "skill-tools.ts");
const SKILL_TOOLS_EXTENSION_PATH = fs.existsSync(SKILL_TOOLS_EXTENSION_JS)
  ? SKILL_TOOLS_EXTENSION_JS
  : SKILL_TOOLS_EXTENSION_TS;

// Subagent Core 工具扩展文件路径（Phase 14 T6：主 Agent 七个 Core 工具）
const SUBAGENT_TOOLS_EXTENSION_JS = path.resolve(__dirname, "subagent-tools.js");
const SUBAGENT_TOOLS_EXTENSION_TS = path.resolve(__dirname, "subagent-tools.ts");
const SUBAGENT_TOOLS_EXTENSION_PATH = fs.existsSync(SUBAGENT_TOOLS_EXTENSION_JS)
  ? SUBAGENT_TOOLS_EXTENSION_JS
  : SUBAGENT_TOOLS_EXTENSION_TS;

/** 记忆工具名称列表（始终可用，不受 tool_mode 影响） */
export const MEMORY_TOOL_NAMES = [
  "search_memory",
  "remember",
  "forget",
  "pin_memory",
  "unpin_memory",
] as const;

/**
 * Skill Core 工具名称列表（T6：extraTools 注册路径，平台提供，不是插件自定义工具）。
 * 只有 SkillCoreService 注入且注册了 SkillContext 的 Session 才启用。
 */
export const SKILL_TOOL_NAMES = [
  "search_skills",
  "inspect_skill",
  "install_skill",
  "manage_skills",
  "manage_skill_bundle",
] as const;

/**
 * Subagent Core 工具名称列表（Phase 14 T6：extraTools 注册路径）。
 * 只在普通主 Agent Session 注册（§20.2：无 Agent Session、Subagent
 * Session、Memory Agent、Plugin worker 不注册）；组合根缺少 Subagent
 * 服务时不注入该列表（工具不注册，不静默 no-op）。
 */
export const SUBAGENT_TOOL_NAMES = [
  "spawn_subagent",
  "get_subagent_status",
  "inspect_subagent",
  "steer_subagent",
  "wait_subagent",
  "cancel_subagent",
  "close_subagent",
] as const;

/** 预加载的沙箱扩展（进程级加载一次，工具执行时通过 AsyncLocalStorage 读取 per-Session 上下文） */
let sandboxExtensionsLoaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>> | null = null;

/** 预加载的记忆工具扩展（进程级加载一次） */
let memoryToolsExtensionsLoaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>> | null = null;

/** 预加载的 Skill Core 工具扩展（进程级加载一次） */
let skillToolsExtensionsLoaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>> | null = null;

/** 预加载的 Subagent Core 工具扩展（进程级加载一次） */
let subagentToolsExtensionsLoaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>> | null = null;

export interface SandboxExtensionLoadResult {
  readonly errors: readonly {
    readonly path: string;
    readonly error: unknown;
  }[];
  readonly extensions: readonly unknown[];
}

/** 验证沙箱扩展加载结果。任何错误或数量不符都必须 fail-closed。 */
export function validateSandboxExtensionLoadResult(
  result: SandboxExtensionLoadResult,
): void {
  if (result.errors.length > 0) {
    const msg = result.errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`Sandbox extension failed to load: ${msg}`);
  }
  if (result.extensions.length !== 1) {
    throw new Error(
      `Sandbox extension count mismatch: expected 1, got ${result.extensions.length}. ` +
      "Sandbox tools will not be wrapped.",
    );
  }
}

async function ensureSandboxExtensionLoaded(): Promise<void> {
  if (sandboxExtensionsLoaded) return;
  if (!fs.existsSync(SANDBOX_EXTENSION_PATH)) {
    throw new Error(
      `Sandbox extension not found at ${SANDBOX_EXTENSION_PATH}. ` +
      "Run 'npm run build' to compile sandbox-extension.",
    );
  }
  const result = await discoverAndLoadExtensions(
    [SANDBOX_EXTENSION_PATH],
    path.resolve(__dirname, "..", ".."),
  );
  validateSandboxExtensionLoadResult(result);
  sandboxExtensionsLoaded = result;
}

async function ensureMemoryToolsExtensionLoaded(): Promise<void> {
  if (memoryToolsExtensionsLoaded) return;
  if (!fs.existsSync(MEMORY_TOOLS_EXTENSION_PATH)) {
    throw new Error(
      `Memory tools extension not found at ${MEMORY_TOOLS_EXTENSION_PATH}. ` +
      "Run 'npm run build' to compile memory-tools.",
    );
  }
  const result = await discoverAndLoadExtensions(
    [MEMORY_TOOLS_EXTENSION_PATH],
    path.resolve(__dirname, "..", ".."),
  );
  if (result.errors.length > 0) {
    const msg = result.errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`Memory tools extension failed to load: ${msg}`);
  }
  memoryToolsExtensionsLoaded = result;
}

async function ensureSkillToolsExtensionLoaded(): Promise<void> {
  if (skillToolsExtensionsLoaded) return;
  if (!fs.existsSync(SKILL_TOOLS_EXTENSION_PATH)) {
    throw new Error(
      `Skill tools extension not found at ${SKILL_TOOLS_EXTENSION_PATH}. ` +
      "Run 'npm run build' to compile skill-tools.",
    );
  }
  const result = await discoverAndLoadExtensions(
    [SKILL_TOOLS_EXTENSION_PATH],
    path.resolve(__dirname, "..", ".."),
  );
  if (result.errors.length > 0) {
    const msg = result.errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`Skill tools extension failed to load: ${msg}`);
  }
  skillToolsExtensionsLoaded = result;
}

async function ensureSubagentToolsExtensionLoaded(): Promise<void> {
  if (subagentToolsExtensionsLoaded) return;
  if (!fs.existsSync(SUBAGENT_TOOLS_EXTENSION_PATH)) {
    throw new Error(
      `Subagent tools extension not found at ${SUBAGENT_TOOLS_EXTENSION_PATH}. ` +
      "Run 'npm run build' to compile subagent-tools.",
    );
  }
  const result = await discoverAndLoadExtensions(
    [SUBAGENT_TOOLS_EXTENSION_PATH],
    path.resolve(__dirname, "..", ".."),
  );
  if (result.errors.length > 0) {
    const msg = result.errors.map((e) => `${e.path}: ${e.error}`).join("; ");
    throw new Error(`Subagent tools extension failed to load: ${msg}`);
  }
  subagentToolsExtensionsLoaded = result;
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function toNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function extractUsage(message: unknown): TokenUsage | undefined {
  const usage = (message as { usage?: unknown } | undefined)?.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const raw = usage as Record<string, unknown>;
  return {
    input: toNonNegativeInteger(raw.input),
    output: toNonNegativeInteger(raw.output),
    cacheRead: toNonNegativeInteger(raw.cacheRead),
    cacheWrite: toNonNegativeInteger(raw.cacheWrite),
    totalTokens: toNonNegativeInteger(raw.totalTokens),
  };
}

function addUsage(total: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!total) return next;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    totalTokens: total.totalTokens + next.totalTokens,
  };
}

function toContextUsage(raw: {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}): ContextUsage {
  return {
    tokens: raw.tokens,
    contextWindow: raw.contextWindow,
    percent: raw.percent,
  };
}

function createSessionEventMapper(
  getContextUsage: () => ContextUsage | undefined,
): (event: AgentSessionEvent) => PiAgentEvent | undefined {
  let turnUsage: TokenUsage | undefined;

  return (event: AgentSessionEvent): PiAgentEvent | undefined => {
    if (event.type === "turn_start") {
      turnUsage = undefined;
      return { type: "turn_start" };
    }
    if (event.type === "turn_end") {
      const usage = turnUsage ?? extractUsage(event.message);
      turnUsage = undefined;
      const context = getContextUsage();
      return {
        type: "turn_end",
        ...(usage ? { usage } : {}),
        ...(context ? { context } : {}),
      };
    }
    if (event.type === "compaction_start") {
      return { type: "compaction_start", reason: event.reason };
    }
    if (event.type === "compaction_end") {
      const result = event.result;
      return {
        type: "compaction_end",
        reason: event.reason,
        aborted: event.aborted,
        ...(result ? { tokensBefore: result.tokensBefore, summary: result.summary } : {}),
        ...(result?.estimatedTokensAfter !== undefined
          ? { estimatedTokensAfter: result.estimatedTokensAfter }
          : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      };
    }
    if (event.type === "agent_start" || event.type === "agent_end") {
      return { type: event.type };
    }
    if (event.type === "message_start") {
      return { type: "message_start", role: event.message.role };
    }
    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const usage = extractUsage(event.message);
        if (usage) turnUsage = addUsage(turnUsage, usage);
      }
      // stopReason="error" 表示模型调用失败（PI 不抛出，错误附在消息上）；透传给运行时判定失败终态
      const message = event.message as { stopReason?: string; errorMessage?: string };
      return {
        type: "message_end",
        role: event.message.role,
        content: messageText(event.message),
        ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
        ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
      };
    }
    return mapRemainingEvent(event);
  };
}

function mapRemainingEvent(event: AgentSessionEvent): PiAgentEvent | undefined {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") return { type: "text_delta", delta: update.delta };
    if (update.type === "thinking_delta") return { type: "thinking_delta", delta: update.delta };
    if (update.type === "toolcall_delta") {
      const content = event.message.role === "assistant" ? event.message.content[update.contentIndex] : undefined;
      return {
        type: "tool_delta",
        toolCallId: content?.type === "toolCall" ? content.id : `tool-${update.contentIndex}`,
        delta: update.delta,
      };
    }
    return undefined;
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    };
  }
  if (event.type === "tool_execution_update") {
    return {
      type: "tool_delta",
      toolCallId: event.toolCallId,
      delta: JSON.stringify(event.partialResult),
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      toolCallId: event.toolCallId,
      result: event.result,
      isError: event.isError,
    };
  }
  return undefined;
}

function minimalResourceLoader(
  systemPrompt?: string,
  useSandbox?: boolean,
  skills?: PiResourceSkills | (() => PiResourceSkills),
): ResourceLoader {
  return {
    getExtensions: () => {
      const runtime = createExtensionRuntime();
      const extensions: unknown[] = [];
      const errors: { path: string; error: unknown }[] = [];

      // 始终加载记忆工具扩展
      if (memoryToolsExtensionsLoaded) {
        extensions.push(...memoryToolsExtensionsLoaded.extensions);
        errors.push(...memoryToolsExtensionsLoaded.errors);
      }

      // 始终加载 Skill Core 工具扩展（工具执行时按 per-Session 上下文隔离）
      if (skillToolsExtensionsLoaded) {
        extensions.push(...skillToolsExtensionsLoaded.extensions);
        errors.push(...skillToolsExtensionsLoaded.errors);
      }

      // Phase 14 T6（复审 P1-3 根因修复）：Subagent Core 工具扩展必须进会话
      // ExtensionRunner——此前只 ensure 加载、漏了加入 ResourceLoader，工具名
      // 虽在 extraTools 里却被 setActiveToolsByName 静默丢弃（E2E 中 spawn 工具
      // 一直"未注册"的根因）。Subagent Session 不传 extraTools，此处不加载。
      if (subagentToolsExtensionsLoaded) {
        extensions.push(...subagentToolsExtensionsLoaded.extensions);
        errors.push(...subagentToolsExtensionsLoaded.errors);
      }

      // 按需加载沙箱扩展
      if (useSandbox && sandboxExtensionsLoaded) {
        extensions.push(...sandboxExtensionsLoaded.extensions);
        errors.push(...sandboxExtensionsLoaded.errors);
      }

      return {
        extensions: extensions as import("@earendil-works/pi-coding-agent").Extension[],
        errors: errors as Array<{ path: string; error: string }>,
        runtime,
      };
    },
    // T5：注入解析结果（默认仍为空数组，保证既有行为不变）；正文不在此返回。
    // T10：支持函数形式——每次 getSkills 调用（PI 每 turn 重建系统提示时）求值，
    // 由 SessionRuntime 每 turn 更新的槽提供（Skill 快照每 turn 冻结）
    getSkills: () => {
      const resolved = typeof skills === "function" ? skills() : skills;
      return resolved !== undefined
        ? { skills: [...resolved.skills], diagnostics: [...resolved.diagnostics] }
        : { skills: [], diagnostics: [] };
    },
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt ?? "You are a concise assistant.",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * 会话级插件工具 → PI ToolDefinition（P0-1）。
 * - 工具名使用稳定命名空间 pluginId.toolId，防跨插件冲突；
 * - parameters 为标准 JSON Schema（PI 运行时兼容非 TypeBox Schema）；
 * - execute 委托宿主 ToolService.invoke（权限/绑定/沙箱前置已在宿主侧完成）。
 */
function toPiToolDefinition(tool: PluginSessionTool): ToolDefinition {
  return {
    name: tool.qualifiedName,
    label: tool.qualifiedName,
    description: tool.description ?? "",
    // parameters 为必选：无声明 Schema 时给宽松对象 Schema（PI 运行时兼容非 TypeBox Schema）
    parameters: (tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: true }) as ToolDefinition["parameters"],
    execute: async (toolCallId, params, signal) => {
      const result = await tool.invoke(params, signal);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.result) }],
        details: undefined,
      };
    },
  };
}

export async function createPiFauxAgentSession(
  options: PiFauxAgentOptions & {
    toolPolicy?: ToolPolicy;
        sandboxContext?: SandboxContextOverrides;
    /** 额外启用的工具名称（如记忆工具），不受 noTools 影响 */
    extraTools?: readonly string[];
  },
): Promise<PiAgentSessionHandle> {
  const faux = fauxProvider({
    provider: options.providerId,
    models: [{ id: options.modelId }],
    ...(options.tokensPerSecond
      ? { tokensPerSecond: options.tokensPerSecond }
      : { tokenSize: { min: 10_000, max: 10_000 } }),
  });
  faux.setResponses([
    fauxAssistantMessage(options.response),
    fauxAssistantMessage(options.response),
  ]);

  const modelRuntime = await ModelRuntime.create({
    authPath: options.authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const fauxModel = faux.getModel();
  modelRuntime.registerProvider(options.providerId, {
    name: "Faux",
    baseUrl: fauxModel.baseUrl,
    api: faux.api,
    streamSimple: (model, context, streamOptions) =>
      faux.provider.streamSimple(model, context, streamOptions),
    models: [
      {
        id: fauxModel.id,
        name: fauxModel.name,
        api: fauxModel.api,
        baseUrl: fauxModel.baseUrl,
        reasoning: fauxModel.reasoning,
        input: [...fauxModel.input],
        cost: fauxModel.cost,
        contextWindow: fauxModel.contextWindow,
        maxTokens: fauxModel.maxTokens,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(options.providerId, "faux-key");
  const model = modelRuntime.getModel(options.providerId, options.modelId);
  if (!model) throw new Error("Faux model registration failed");

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const sessionManager = options.sessionHandle
    ? getSessionManager(options.sessionHandle)
    : SessionManager.create(options.cwd, options.sessionDir, {
        id: options.sessionId,
      });

  const toolPolicy: ToolPolicy | undefined = options.toolPolicy;

  // 预加载扩展
  if (toolPolicy) {
    await ensureSandboxExtensionLoaded();
  }
  const hasExtraTools = options.extraTools && options.extraTools.length > 0;
  if (hasExtraTools) {
    await ensureMemoryToolsExtensionLoaded();
    await ensureSkillToolsExtensionLoaded();
    if (options.extraTools!.some((name) => (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name))) {
      await ensureSubagentToolsExtensionLoaded();
    }
  }

  // T11（P0-2）：外部注入只允许 skillRead 端口；sessionCwd 一律取 options.cwd
  const sessionCwd = options.cwd;
  const sandboxCtx: SandboxContext | undefined = toolPolicy
    ? {
      toolPolicy,
      sessionCwd,
      allowBash: false,
      // T11（P0-2）：read 工具 Skill 受控读取端口（SessionRuntime 注入）
      ...(options.sandboxContext?.skillRead !== undefined ? { skillRead: options.sandboxContext.skillRead } : {}),
      // T9b（Phase 14 §18.3）：父 Agent 写 Tool 的工作区写 Lease 守卫
      ...(options.sandboxContext?.workspaceLeaseGuard !== undefined ? { workspaceLeaseGuard: options.sandboxContext.workspaceLeaseGuard } : {}),
    }
    : undefined;

  const createSession = () => createAgentSession({
    cwd: options.cwd,
    agentDir: path.dirname(options.authPath),
    modelRuntime,
    model,
    settingsManager,
    sessionManager,
    resourceLoader: minimalResourceLoader(
      options.systemPrompt,
      !!toolPolicy,
      options.skills,
    ),
    ...(hasExtraTools
      ? { tools: [...options.extraTools!] }
      : { noTools: "all" as const }),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  });
  const { session } = sandboxCtx
    ? await runWithSandboxContext(sandboxCtx, createSession)
    : await createSession();
  const unregisterSandbox = sandboxCtx
    ? registerSandboxContext(session.sessionId, sandboxCtx)
    : undefined;

  const mapEvent = createSessionEventMapper(() => {
    const usage = session.getContextUsage();
    return usage ? toContextUsage(usage) : undefined;
  });

  return {
    sessionId: session.sessionId,
    subscribe(listener) {
      return session.subscribe((event) => {
        const mapped = mapEvent(event);
        if (mapped) listener(mapped);
      });
    },
    prompt(text, options) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.prompt(text, options));
      }
      return session.prompt(text, options);
    },
    steer(text) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.steer(text));
      }
      return session.steer(text);
    },
    followUp(text) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.followUp(text));
      }
      return session.followUp(text);
    },
    get isStreaming(): boolean {
      return session.isStreaming;
    },
    abort() {
      return session.abort();
    },
    async compact() {
      await session.compact();
    },
    getUsageStats() {
      return readUsageStats(session);
    },
    dispose() {
      unregisterSandbox?.();
      session.dispose();
    },
    checkFilePath(operation: FileOperation, targetPath: string): { allowed: boolean; reason: string } {
      if (!toolPolicy) {
        return { allowed: true, reason: "No sandbox configured" };
      }
      const result = toolPolicy.checkFilePath(operation, targetPath);
      return { allowed: result.allowed, reason: result.reason };
    },
    get toolPolicy(): ToolPolicy | undefined {
      return toolPolicy;
    },
  } as PiAgentSessionHandle;
}

export async function createPiAgentSession(
  options: PiAgentSessionOptions & {
    toolPolicy?: ToolPolicy;
        sandboxContext?: SandboxContextOverrides;
    /** 额外启用的工具名称（如记忆工具），不受 noTools 影响 */
    extraTools?: readonly string[];
    /** 会话级插件工具（P0-1：按 Agent 绑定过滤后注入 PI 工具注册表） */
    customTools?: readonly PluginSessionTool[];
  },
): Promise<PiAgentSessionHandle> {
  const resolved = options.modelRuntime.resolveModel(options.providerId, options.modelId);
  const modelRuntime = resolved.runtime as ModelRuntime;
  const model = resolved.model as ReturnType<ModelRuntime["getModel"]>;
  if (!model) throw new Error(`Model "${options.providerId}/${options.modelId}" not found`);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const sessionManager = getSessionManager(options.sessionHandle);

  const toolPolicy: ToolPolicy | undefined = options.toolPolicy;

  if (toolPolicy) {
    await ensureSandboxExtensionLoaded();
  }
  const hasExtraTools = options.extraTools && options.extraTools.length > 0;
  if (hasExtraTools) {
    await ensureMemoryToolsExtensionLoaded();
    await ensureSkillToolsExtensionLoaded();
    if (options.extraTools!.some((name) => (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name))) {
      await ensureSubagentToolsExtensionLoaded();
    }
  }

  // T11（P0-2）：外部注入只允许 skillRead 端口；sessionCwd 一律取 options.cwd
  const sessionCwd = options.cwd;
  const sandboxCtx: SandboxContext | undefined = toolPolicy
    ? {
      toolPolicy,
      sessionCwd,
      allowBash: false,
      // T11（P0-2）：read 工具 Skill 受控读取端口（SessionRuntime 注入）
      ...(options.sandboxContext?.skillRead !== undefined ? { skillRead: options.sandboxContext.skillRead } : {}),
      // T9b（Phase 14 §18.3）：父 Agent 写 Tool 的工作区写 Lease 守卫
      ...(options.sandboxContext?.workspaceLeaseGuard !== undefined ? { workspaceLeaseGuard: options.sandboxContext.workspaceLeaseGuard } : {}),
    }
    : undefined;

  const createOptions: Parameters<typeof createAgentSession>[0] = {
    cwd: options.cwd,
    agentDir: path.dirname(options.authPath),
    modelRuntime,
    model,
    settingsManager,
    sessionManager,
    resourceLoader: minimalResourceLoader(
      options.systemPrompt,
      !!toolPolicy,
      options.skills,
    ),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  };

  if (options.noTools === "all" && !hasExtraTools) {
    createOptions.noTools = "all";
  } else if (hasExtraTools) {
    // 合并文件工具与记忆工具；无文件工具时仅记忆工具
    const fileTools = options.tools ?? [];
    createOptions.tools = [...fileTools, ...options.extraTools!];
  } else if (options.tools && options.tools.length > 0) {
    createOptions.tools = [...options.tools];
  }

  // 插件工具：注入 PI 工具注册表（可执行），并把工具名并入模型可见列表
  const hasPluginTools = options.customTools !== undefined && options.customTools.length > 0;
  if (hasPluginTools) {
    createOptions.customTools = options.customTools!.map((tool) => toPiToolDefinition(tool));
    const pluginToolNames = options.customTools!.map((tool) => tool.qualifiedName);
    if (createOptions.noTools === "all") {
      delete createOptions.noTools;
      createOptions.tools = [...pluginToolNames];
    } else if (hasExtraTools) {
      createOptions.tools = [...(options.tools ?? []), ...options.extraTools!, ...pluginToolNames];
    } else if (options.tools && options.tools.length > 0) {
      createOptions.tools = [...options.tools, ...pluginToolNames];
    } else {
      createOptions.tools = [...pluginToolNames];
    }
  }

  const createSession = () => createAgentSession(createOptions);
  const { session } = sandboxCtx
    ? await runWithSandboxContext(sandboxCtx, createSession)
    : await createSession();
  const unregisterSandbox = sandboxCtx
    ? registerSandboxContext(session.sessionId, sandboxCtx)
    : undefined;

  const mapEvent = createSessionEventMapper(() => {
    const usage = session.getContextUsage();
    return usage ? toContextUsage(usage) : undefined;
  });

  return {
    sessionId: session.sessionId,
    subscribe(listener) {
      return session.subscribe((event) => {
        const mapped = mapEvent(event);
        if (mapped) listener(mapped);
      });
    },
    prompt(text, options) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.prompt(text, options));
      }
      return session.prompt(text, options);
    },
    steer(text) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.steer(text));
      }
      return session.steer(text);
    },
    followUp(text) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.followUp(text));
      }
      return session.followUp(text);
    },
    get isStreaming(): boolean {
      return session.isStreaming;
    },
    abort() {
      return session.abort();
    },
    async compact() {
      await session.compact();
    },
    getUsageStats() {
      return readUsageStats(session);
    },
    dispose() {
      unregisterSandbox?.();
      session.dispose();
    },
    checkFilePath(operation: FileOperation, targetPath: string): { allowed: boolean; reason: string } {
      if (!toolPolicy) {
        return { allowed: true, reason: "No sandbox configured" };
      }
      const result = toolPolicy.checkFilePath(operation, targetPath);
      return { allowed: result.allowed, reason: result.reason };
    },
    get toolPolicy(): ToolPolicy | undefined {
      return toolPolicy;
    },
  } as PiAgentSessionHandle;
}

type SessionWithUsageStats = {
  getSessionStats(): {
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
};

function readUsageStats(session: SessionWithUsageStats): PiSessionUsageStats {
  const stats = session.getSessionStats();
  const context = session.getContextUsage();
  return {
    tokens: {
      input: toNonNegativeInteger(stats.tokens.input),
      output: toNonNegativeInteger(stats.tokens.output),
      cacheRead: toNonNegativeInteger(stats.tokens.cacheRead),
      cacheWrite: toNonNegativeInteger(stats.tokens.cacheWrite),
      total: toNonNegativeInteger(stats.tokens.total),
    },
    ...(context ? { context: toContextUsage(context) } : {}),
  };
}
