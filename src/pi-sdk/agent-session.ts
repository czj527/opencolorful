import path from "node:path";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  type AgentSessionEvent,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type {
  PiAgentEvent,
  PiAgentSessionHandle,
  PiAgentSessionOptions,
  PiFauxAgentOptions,
} from "./types.js";
import { getSessionManager } from "./session-manager-registry.js";

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

function mapAgentEvent(event: AgentSessionEvent): PiAgentEvent | undefined {
  if (
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "turn_start" ||
    event.type === "turn_end"
  ) {
    return { type: event.type };
  }
  if (event.type === "message_start") {
    return { type: "message_start", role: event.message.role };
  }
  if (event.type === "message_end") {
    return { type: "message_end", role: event.message.role, content: messageText(event.message) };
  }
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

function minimalResourceLoader(systemPrompt?: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
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
  options: PiFauxAgentOptions,
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
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: path.dirname(options.authPath),
    modelRuntime,
    model,
    settingsManager,
    sessionManager,
    resourceLoader: minimalResourceLoader(options.systemPrompt),
    noTools: "all",
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  });

  return {
    sessionId: session.sessionId,
    subscribe(listener) {
      return session.subscribe((event) => {
        const mapped = mapAgentEvent(event);
        if (mapped) listener(mapped);
      });
    },
    prompt(text) {
      return session.prompt(text);
    },
    abort() {
      return session.abort();
    },
    async compact() {
      await session.compact();
    },
    dispose() {
      session.dispose();
    },
  };
}

export async function createPiAgentSession(
  options: PiAgentSessionOptions,
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

  const createOptions: Parameters<typeof createAgentSession>[0] = {
    cwd: options.cwd,
    agentDir: path.dirname(options.authPath),
    modelRuntime,
    model,
    settingsManager,
    sessionManager,
    resourceLoader: minimalResourceLoader(options.systemPrompt),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  };

  if (options.noTools === "all") {
    createOptions.noTools = "all";
  } else if (options.tools && options.tools.length > 0) {
    createOptions.tools = [...options.tools];
  }

  const { session } = await createAgentSession(createOptions);

  return {
    sessionId: session.sessionId,
    subscribe(listener) {
      return session.subscribe((event) => {
        const mapped = mapAgentEvent(event);
        if (mapped) listener(mapped);
      });
    },
    prompt(text) {
      return session.prompt(text);
    },
    abort() {
      return session.abort();
    },
    async compact() {
      await session.compact();
    },
    dispose() {
      session.dispose();
    },
  };
}
