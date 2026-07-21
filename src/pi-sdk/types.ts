export interface PiSessionHandle {
  readonly id: string;
  readonly persisted: boolean;
  readonly entryCount: number;
  appendUserMessage(content: string): void;
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
