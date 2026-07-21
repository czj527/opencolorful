export interface PiSessionHandle {
  readonly id: string;
  readonly path: string;
  readonly persisted: boolean;
  readonly entryCount: number;
  readonly messages: readonly string[];
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
}
