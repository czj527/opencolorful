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
} from "@earendil-works/pi-coding-agent";

import type { ContextUsage, TokenUsage } from "../contracts/events.js";
import type { FileOperation } from "../contracts/sandbox.js";
import type { ToolPolicy } from "../runtime/tool-policy.js";
import type {
  SandboxContext,
} from "./sandbox-extension.js";
import { runWithSandboxContext } from "./sandbox-extension.js";
import type {
  PiAgentEvent,
  PiAgentSessionHandle,
  PiAgentSessionOptions,
  PiFauxAgentOptions,
  PiSessionUsageStats,
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

/** 预加载的沙箱扩展（进程级加载一次，工具执行时通过 AsyncLocalStorage 读取 per-Session 上下文） */
let sandboxExtensionsLoaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>> | null = null;

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
  // 验证加载结果：任何错误或扩展数量不符 → fail-closed
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
  sandboxExtensionsLoaded = result;
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
      return { type: "message_end", role: event.message.role, content: messageText(event.message) };
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
): ResourceLoader {
  return {
    getExtensions: () => {
      if (useSandbox && sandboxExtensionsLoaded) {
        return {
          extensions: sandboxExtensionsLoaded.extensions,
          errors: sandboxExtensionsLoaded.errors,
          runtime: sandboxExtensionsLoaded.runtime ?? createExtensionRuntime(),
        };
      }
      return { extensions: [], errors: [], runtime: createExtensionRuntime() };
    },
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt ?? "You are a concise assistant.",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export async function createPiFauxAgentSession(
  options: PiFauxAgentOptions & { toolPolicy?: ToolPolicy; sandboxContext?: SandboxContext },
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

  // 预加载沙箱扩展 + 设定 per-Session AsyncLocalStorage 上下文
  if (toolPolicy) {
    await ensureSandboxExtensionLoaded();
  }

  const sessionCwd = options.sandboxContext?.sessionCwd ?? options.cwd;

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: path.dirname(options.authPath),
    modelRuntime,
    model,
    settingsManager,
    sessionManager,
    resourceLoader: minimalResourceLoader(
      options.systemPrompt,
      !!toolPolicy,
    ),
    noTools: "all",
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  });

  const mapEvent = createSessionEventMapper(() => {
    const usage = session.getContextUsage();
    return usage ? toContextUsage(usage) : undefined;
  });

  // 包装 prompt() 以注入 sandbox AsyncLocalStorage 上下文
  const sandboxCtx: SandboxContext | undefined = toolPolicy
    ? { toolPolicy, sessionCwd, allowBash: false }
    : undefined;

  return {
    sessionId: session.sessionId,
    subscribe(listener) {
      return session.subscribe((event) => {
        const mapped = mapEvent(event);
        if (mapped) listener(mapped);
      });
    },
    prompt(text) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.prompt(text));
      }
      return session.prompt(text);
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
  options: PiAgentSessionOptions & { toolPolicy?: ToolPolicy; sandboxContext?: SandboxContext },
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

  const sessionCwd = options.sandboxContext?.sessionCwd ?? options.cwd;

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
    ),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  };

  if (options.noTools === "all") {
    createOptions.noTools = "all";
  } else if (options.tools && options.tools.length > 0) {
    createOptions.tools = [...options.tools];
  }

  const { session } = await createAgentSession(createOptions);

  const mapEvent = createSessionEventMapper(() => {
    const usage = session.getContextUsage();
    return usage ? toContextUsage(usage) : undefined;
  });

  const sandboxCtx: SandboxContext | undefined = toolPolicy
    ? { toolPolicy, sessionCwd, allowBash: false }
    : undefined;

  return {
    sessionId: session.sessionId,
    subscribe(listener) {
      return session.subscribe((event) => {
        const mapped = mapEvent(event);
        if (mapped) listener(mapped);
      });
    },
    prompt(text) {
      if (sandboxCtx) {
        return runWithSandboxContext(sandboxCtx, () => session.prompt(text));
      }
      return session.prompt(text);
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
