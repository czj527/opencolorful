// Web client types mirroring server contracts

// --- Platform Event Envelope ---
export interface PlatformEventEnvelope {
  readonly protocolVersion: 1;
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly streamId: string | null;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly payload: unknown;
}

// --- API Error ---
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

// --- Provider ---
export interface ProviderModelCapabilities {
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ProviderModelSetting {
  readonly modelId: string;
  readonly name: string;
  readonly capabilities: ProviderModelCapabilities;
}

export interface ProviderView {
  readonly providerId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly models: ProviderModelSetting[];
  readonly credentialConfigured: boolean;
}

export interface ModelSummary {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly capabilities: ProviderModelCapabilities;
  readonly credentialConfigured: boolean;
}

// --- Session ---
export interface SessionView {
  readonly id: string;
  readonly title: string;
  readonly sessionPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly provider: string | null;
  readonly model: string | null;
  readonly toolMode: string;
  readonly workspaceCwd: string | null;
  readonly workspaceConfirmed: boolean;
  readonly thinkingLevel: string;
  readonly messages: readonly string[];
}

export interface SessionSettings {
  readonly toolMode?: "off" | "read-only" | "all";
  readonly workspaceCwd?: string;
  readonly workspaceConfirmed?: boolean;
  readonly thinkingLevel?: string;
}

// --- Supervisor ---
export interface SupervisorStatusResponse {
  readonly status: string;
  readonly supervisor: {
    readonly pid: number;
    readonly port: number;
    readonly version: string;
    readonly uptimeSeconds: number;
  };
  readonly agentServer: {
    readonly status: string;
    readonly pid: number | null;
    readonly port: number | null;
    readonly version: string | null;
  };
}

// --- Prompt ---
export interface PromptResponse {
  readonly status: string;
  readonly sessionId: string;
  readonly streamId: string;
}

export interface AbortResponse {
  readonly status: string;
}

// --- Health ---
export interface HealthResponse {
  readonly status: string;
  readonly version: string;
  readonly pid: number;
  readonly uptimeSeconds: number;
}

// --- WS Protocol ---
export type WsClientCommand =
  | { readonly type: "subscribe"; readonly sessionId: string }
  | { readonly type: "unsubscribe"; readonly sessionId: string }
  | { readonly type: "abort"; readonly sessionId: string; readonly streamId: string }
  | { readonly type: "compact"; readonly sessionId: string }
  | { readonly type: "resume"; readonly sessionId: string; readonly streamId: string; readonly lastSequence: number };

export type WsServerMessage =
  | { readonly type: "event"; readonly payload: PlatformEventEnvelope }
  | { readonly type: "subscribed"; readonly sessionId: string }
  | { readonly type: "unsubscribed"; readonly sessionId: string }
  | { readonly type: "abort_result"; readonly sessionId: string; readonly status: string }
  | { readonly type: "compact_result"; readonly sessionId: string; readonly status: string }
  | { readonly type: "resume_result"; readonly sessionId: string; readonly events: PlatformEventEnvelope[] };
