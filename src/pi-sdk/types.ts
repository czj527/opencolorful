export interface PiMessageEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
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
  dispose(): void;
}

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
  | { readonly type: "agent_start" | "agent_end" | "turn_start" | "turn_end" }
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
}
