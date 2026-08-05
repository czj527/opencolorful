import type { ContextUsage, TokenUsage } from "../contracts/events.js";

export interface PiSessionUsageStats {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly context?: ContextUsage;
}

export interface HistoryToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: "completed" | "error";
  readonly result?: string; // 截断后的摘要，遵循现有脱敏/限长约定
}
export interface PiMessageEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly HistoryToolCall[];
}

export interface PiSessionHandle {
  readonly id: string;
  readonly path: string;
  readonly persisted: boolean;
  readonly entryCount: number;
  readonly messages: readonly string[];
  readonly messageEntries: readonly PiMessageEntry[];
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
  appendUserMessage(content: string): void;
  appendAssistantMessage(content: string): void;
  selectModel(providerId: string, modelId: string): void;
  setTitle(title: string): void;
  persist(): void;
  dispose(): void;
}

/**
 * 会话级插件工具（Phase 12 P0-1：主会话 Contribution 接入）。
 * 由宿主（messages 路由）按 Agent 绑定过滤插件 Tool contribution 后构造，
 * 经 createPiAgentSession 的 customTools 注入 PI 工具注册表（模型可见可调用）。
 */
export interface PluginSessionTool {
  /** 稳定命名空间：pluginId.toolId */
  readonly qualifiedName: string;
  /** 所属插件（P0-2 turn 快照按插件冻结） */
  readonly pluginId: string;
  readonly name: string;
  readonly description?: string;
  /** 输入 JSON Schema（标准 JSON Schema 运行时兼容） */
  readonly inputSchema?: unknown;
  /**
   * 宿主可写的 turn 上下文槽（P0-2）：SessionRuntime 每 turn 开始冻结
   * 该插件的授权/绑定快照写入 current；invoke 闭包读取后传给 ToolService。
   */
  readonly turnContext?: { current: PluginToolTurnContext | undefined };
  /** 执行入口：params 已过 Schema 校验；结果对象由宿主 JSON 序列化回模型 */
  invoke(params: unknown, signal?: AbortSignal): Promise<PluginSessionToolInvokeResult>;
}

/** turn 级冻结的授权/绑定状态（in-flight turn 内工具调用以它为准） */
export interface PluginToolTurnContext {
  readonly snapshot: unknown;
  readonly state: unknown;
}

export type PluginSessionToolInvokeResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface PiCredentialInfo {
  readonly providerId: string;
  readonly type: "api_key" | "oauth";
}

export interface PiCredentialStore {
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  has(providerId: string): Promise<boolean>;
  list(): Promise<readonly PiCredentialInfo[]>;
  delete(providerId: string): Promise<void>;
}

export interface OfflineCompletionResult {
  readonly provider: string;
  readonly model: string;
  readonly text: string;
}

export type WorkspaceToolMode = "read-only" | "all";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModelCapabilities {
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface PiProviderDefinition {
  readonly providerId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly {
    readonly modelId: string;
    readonly name: string;
    readonly capabilities: PiModelCapabilities;
  }[];
}

export interface PiModelSummary {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly capabilities: PiModelCapabilities;
  readonly credentialConfigured: boolean;
}

export interface PiModelRuntimeHandle {
  setApiKey(providerId: string, apiKey: string): Promise<void>;
  credentialConfigured(providerId: string): boolean;
  listConfiguredModels(): PiModelSummary[];
  listEnvironmentModels(): PiModelSummary[];
  resolveModel(providerId: string, modelId: string): PiResolvedModel;
}

export type PiAgentEvent =
  | { readonly type: "agent_start" | "agent_end" | "turn_start" }
  | {
      readonly type: "turn_end";
      readonly usage?: TokenUsage;
      readonly context?: ContextUsage;
    }
  | { readonly type: "compaction_start"; readonly reason: string }
  | {
      readonly type: "compaction_end";
      readonly reason: string;
      readonly aborted: boolean;
      readonly tokensBefore?: number;
      readonly estimatedTokensAfter?: number;
      readonly summary?: string;
      readonly errorMessage?: string;
    }
  | { readonly type: "message_start"; readonly role: string }
  | { readonly type: "message_end"; readonly role: string; readonly content: string }
  | { readonly type: "text_delta" | "thinking_delta"; readonly delta: string }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "tool_delta";
      readonly toolCallId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly result: unknown;
      readonly isError: boolean;
    };

export interface PiAgentSessionHandle {
  readonly sessionId: string;
  subscribe(listener: (event: PiAgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  getUsageStats(): PiSessionUsageStats | undefined;
  dispose(): void;
}

export interface PiFauxAgentOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly authPath: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly response: string;
  readonly tokensPerSecond?: number;
  readonly sessionHandle?: PiSessionHandle;
  readonly thinkingLevel?: PiThinkingLevel;
  readonly systemPrompt?: string;
}

export interface PiResolvedModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly model: unknown;
  readonly runtime: unknown;
  readonly credentialConfigured: boolean;
}

export interface PiAgentSessionOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly authPath: string;
  readonly modelRuntime: PiModelRuntimeHandle;
  readonly providerId: string;
  readonly modelId: string;
  readonly sessionHandle: PiSessionHandle;
  readonly tools?: readonly string[];
  readonly noTools?: "all";
  readonly thinkingLevel?: PiThinkingLevel;
  readonly systemPrompt?: string;
}
