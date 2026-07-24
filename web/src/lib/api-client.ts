import type {
  AbortResponse,
  AgentIdentity,
  AgentProfile,
  AgentServerDiscovery,
  AgentView,
  ApiError,
  HealthResponse,
  LogQuery,
  LogTail,
  ModelSummary,
  PreferencesDocument,
  PromptResponse,
  ProviderView,
  SessionSettings,
  SessionView,
  SupervisorStatusResponse,
} from "./types.js";

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    if (!response.ok) {
      let error: ApiError;
      try {
        error = (await response.json()) as ApiError;
      } catch {
        error = { code: "UNKNOWN", message: response.statusText, retryable: false };
      }
      throw new ApiClientError(error.code, error.message, error.retryable, response.status);
    }
    return (await response.json()) as T;
  }

  // Health
  async getHealth(): Promise<HealthResponse> {
    return this.request("GET", "/api/health");
  }

  // Supervisor
  async getSupervisorStatus(): Promise<SupervisorStatusResponse> {
    return this.request("GET", "/api/supervisor/status");
  }

  async startAgentServer(): Promise<{ status: string; pid: number; port: number }> {
    return this.request("POST", "/api/supervisor/start");
  }

  async stopAgentServer(): Promise<{ status: string }> {
    return this.request("POST", "/api/supervisor/stop");
  }

  async restartAgentServer(): Promise<{ status: string; pid: number; port: number }> {
    return this.request("POST", "/api/supervisor/restart");
  }

  async getSupervisorLogs(query?: LogQuery): Promise<LogTail> {
    if (query === undefined) {
      return this.request("GET", "/api/supervisor/logs");
    }
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.since !== undefined && query.since !== null) params.set("since", query.since);
    if (query.level !== undefined) params.set("level", query.level);
    if (query.query !== undefined) params.set("query", query.query);
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/api/supervisor/logs${qs}`);
  }

  // Preferences
  async getPreferences(): Promise<PreferencesDocument> {
    return this.request("GET", "/api/settings/preferences");
  }

  async updatePreferences(patch: {
    defaults?: Partial<PreferencesDocument["defaults"]>;
    layout?: Partial<PreferencesDocument["layout"]>;
    appearance?: Partial<PreferencesDocument["appearance"]>;
  }): Promise<PreferencesDocument> {
    return this.request("PUT", "/api/settings/preferences", patch);
  }

  async discoverAgentServer(): Promise<AgentServerDiscovery> {
    return this.request("GET", "/api/supervisor/agent-server");
  }

  // Providers
  async listProviders(): Promise<ProviderView[]> {
    return this.request("GET", "/api/settings/providers");
  }

  async updateProvider(provider: Record<string, unknown>, apiKey?: string): Promise<ProviderView> {
    return this.request("PUT", "/api/settings/providers", { provider, ...(apiKey !== undefined ? { apiKey } : {}) });
  }

  // Models
  async listModels(): Promise<ModelSummary[]> {
    return this.request("GET", "/api/models");
  }

  // Sessions
  async listSessions(options?: { includeArchived?: boolean }): Promise<SessionView[]> {
    const query = options?.includeArchived ? "?includeArchived=true" : "";
    return this.request("GET", `/api/sessions${query}`);
  }

  async createSession(title: string, cwd: string, settings?: SessionSettings): Promise<SessionView> {
    return this.request("POST", "/api/sessions", { title, cwd, ...settings });
  }

  async getSession(id: string): Promise<SessionView> {
    return this.request("GET", `/api/sessions/${id}`);
  }

  async updateSessionSettings(id: string, settings: SessionSettings): Promise<SessionView> {
    return this.request("PUT", `/api/sessions/${id}/settings`, settings);
  }

  async setSessionModel(id: string, providerId: string, modelId: string): Promise<SessionView> {
    return this.request("PUT", `/api/sessions/${id}/model`, { providerId, modelId });
  }

  async deleteSession(id: string): Promise<SessionView> {
    return this.request("DELETE", `/api/sessions/${id}`);
  }

  async unarchiveSession(id: string): Promise<SessionView> {
    return this.request("POST", `/api/sessions/${id}/unarchive`);
  }

  // Messages
  async sendPrompt(sessionId: string, content: string): Promise<PromptResponse> {
    return this.request("POST", `/api/sessions/${sessionId}/messages`, { content });
  }

  async abort(sessionId: string, streamId: string): Promise<AbortResponse> {
    return this.request("POST", `/api/sessions/${sessionId}/abort`, { streamId });
  }

  async compact(sessionId: string): Promise<{ status: string }> {
    return this.request("POST", `/api/sessions/${sessionId}/compact`);
  }

  // Agents
  async listAgents(): Promise<AgentView[]> {
    return this.request("GET", "/api/agents");
  }

  async createAgent(type: string, name: string): Promise<AgentView> {
    return this.request("POST", "/api/agents", { type, name });
  }

  async getAgent(id: string): Promise<AgentView> {
    return this.request("GET", `/api/agents/${id}`);
  }

  async updateAgent(id: string, identity: Partial<AgentIdentity>): Promise<AgentView> {
    return this.request("PUT", `/api/agents/${id}`, identity);
  }

  async updateAgentProfile(id: string, profile: Partial<AgentProfile>): Promise<AgentView> {
    return this.request("PUT", `/api/agents/${id}/profile`, profile);
  }

  async archiveAgent(id: string): Promise<void> {
    await this.request("POST", `/api/agents/${id}/archive`);
  }

  async getAgentSessions(id: string): Promise<SessionView[]> {
    return this.request("GET", `/api/agents/${id}/sessions`);
  }
}
