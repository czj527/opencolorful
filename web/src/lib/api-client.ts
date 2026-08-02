import type {
  AbortResponse,
  ActivityPage,
  ActivityQuery,
  AgentServerDiscovery,
  AgentSettings,
  AgentView,
  ApiError,
  AuditPage,
  AuditQuery,
  BaseColor,
  BaseColorTemplate,
  DailyMetric,
  DiagnosticTail,
  ErrorGroup,
  HealthResponse,
  LogQuery,
  LogTail,
  ModelSummary,
  ObservabilityHealthResponse,
  PickDirectoryResult,
  PreferencesDocument,
  PromptResponse,
  ProviderView,
  SessionSettings,
  SessionUsageResponse,
  SessionView,
  TraceResponse,
  UsageSummaryResponse,
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

  // Usage
  async sessionUsage(sessionId: string): Promise<SessionUsageResponse> {
    return this.request("GET", `/api/sessions/${sessionId}/usage`);
  }

  async usageSummary(days: number): Promise<UsageSummaryResponse> {
    return this.request("GET", `/api/usage/summary?days=${days}`);
  }

  // Agents
  async listAgents(): Promise<AgentView[]> {
    return this.request("GET", "/api/agents");
  }

  async createAgent(
    name: string,
    baseColor: {
      persona: string;
      personality: string[];
      replyStyle: string;
      innerSetting: string;
    },
    defaultCwd?: string | null,
    sandbox?: { extraReadPaths?: string[]; protectedPaths?: string[] },
  ): Promise<AgentView> {
    return this.request("POST", "/api/agents", {
      name,
      baseColor,
      ...(defaultCwd !== undefined ? { defaultCwd } : {}),
      ...(sandbox ? { sandbox } : {}),
    });
  }

  async getAgent(id: string): Promise<AgentView> {
    return this.request("GET", `/api/agents/${id}`);
  }

  // identity 只能改 name（id/createdAt/version 不可变）
  async updateAgent(id: string, name: string): Promise<AgentView> {
    return this.request("PUT", `/api/agents/${id}`, { name });
  }

  async getAgentBaseColor(id: string): Promise<BaseColor> {
    return this.request("GET", `/api/agents/${id}/base-color`);
  }

  async updateAgentBaseColor(id: string, baseColor: Partial<BaseColor>): Promise<AgentView> {
    return this.request("PUT", `/api/agents/${id}/base-color`, baseColor);
  }

  async getAgentSettings(id: string): Promise<AgentSettings> {
    return this.request("GET", `/api/agents/${id}/settings`);
  }

  async updateAgentSettings(id: string, settings: {
    defaultCwd?: string | null;
    extraReadPaths?: string[];
    protectedPaths?: string[];
  }): Promise<AgentView> {
    return this.request("PUT", `/api/agents/${id}/settings`, settings);
  }

  async getBaseColorTemplates(): Promise<BaseColorTemplate[]> {
    return this.request("GET", "/api/agents/templates");
  }

  async archiveAgent(id: string): Promise<void> {
    await this.request("POST", `/api/agents/${id}/archive`);
  }

  async getAgentSessions(id: string): Promise<SessionView[]> {
    return this.request("GET", `/api/agents/${id}/sessions`);
  }

  // Directories
  // Windows 调原生 FolderBrowserDialog；macOS/Linux 返回 501，前端回退手工输入
  async pickDirectory(): Promise<PickDirectoryResult> {
    return this.request("POST", "/api/directories/pick");
  }

  // --- Observability（Phase 11 统一可观测性，经 supervisor 代理到 Agent Server）---
  // 健康摘要。Agent Server 未运行或可观测性未初始化时抛 ApiClientError（502/503）。
  async getObservabilityHealth(): Promise<ObservabilityHealthResponse> {
    return this.request("GET", "/api/observability/health");
  }

  // 活动时间线查询。cursor 为 `${recordedAt}|${id}`，limit 最大 200。
  async queryActivity(filter?: ActivityQuery, cursor?: string | null, limit?: number): Promise<ActivityPage> {
    const params = new URLSearchParams();
    if (filter !== undefined) {
      if (filter.from !== undefined) params.set("from", filter.from);
      if (filter.to !== undefined) params.set("to", filter.to);
      if (filter.ownerAgentId !== undefined) params.set("ownerAgentId", filter.ownerAgentId);
      if (filter.sessionId !== undefined) params.set("sessionId", filter.sessionId);
      if (filter.eventName !== undefined) params.set("eventName", filter.eventName);
      if (filter.category !== undefined) params.set("category", filter.category);
      if (filter.level !== undefined) params.set("level", filter.level);
      if (filter.status !== undefined) params.set("status", filter.status);
      if (filter.significance !== undefined) params.set("significance", filter.significance);
      if (filter.component !== undefined) params.set("component", filter.component);
      if (filter.errorCode !== undefined) params.set("errorCode", filter.errorCode);
      if (filter.traceId !== undefined) params.set("traceId", filter.traceId);
      if (filter.operationId !== undefined) params.set("operationId", filter.operationId);
      if (filter.search !== undefined) params.set("search", filter.search);
    }
    if (cursor !== undefined && cursor !== null) params.set("cursor", cursor);
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/api/observability/activity${qs}`);
  }

  async queryErrorGroups(
    options?: { since?: string; eventName?: string; limit?: number },
  ): Promise<{ items: readonly ErrorGroup[] }> {
    const params = new URLSearchParams();
    if (options !== undefined) {
      if (options.since !== undefined) params.set("since", options.since);
      if (options.eventName !== undefined) params.set("eventName", options.eventName);
      if (options.limit !== undefined) params.set("limit", String(options.limit));
    }
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/api/observability/errors${qs}`);
  }

  async queryAudit(filter?: AuditQuery, cursor?: string | null, limit?: number): Promise<AuditPage> {
    const params = new URLSearchParams();
    if (filter !== undefined) {
      if (filter.epoch !== undefined) params.set("epoch", String(filter.epoch));
      if (filter.action !== undefined) params.set("action", filter.action);
      if (filter.decision !== undefined) params.set("decision", filter.decision);
      if (filter.ownerAgentId !== undefined) params.set("ownerAgentId", filter.ownerAgentId);
      if (filter.sessionId !== undefined) params.set("sessionId", filter.sessionId);
      if (filter.traceId !== undefined) params.set("traceId", filter.traceId);
    }
    if (cursor !== undefined && cursor !== null) params.set("cursor", cursor);
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    return this.request("GET", `/api/observability/audit${qs}`);
  }

  async queryDailyMetrics(days: number): Promise<{ items: readonly DailyMetric[] }> {
    return this.request("GET", `/api/observability/metrics?days=${days}`);
  }

  async getTrace(traceId: string, linked = true): Promise<TraceResponse> {
    const qs = linked ? "?linked=1" : "";
    return this.request("GET", `/api/observability/traces/${encodeURIComponent(traceId)}${qs}`);
  }

  async diagnosticTail(
    processName: "server" | "supervisor",
    file: "main" | "debug",
    lines: number,
  ): Promise<DiagnosticTail> {
    return this.request(
      "GET",
      `/api/observability/diagnostic/tail?process=${processName}&file=${file}&lines=${lines}`,
    );
  }

  async createObservabilityExport(): Promise<{ path: string; manifest: { generatedAt: string; rawPayloadIncluded: boolean; factSourcesIncluded: boolean; rawLogsIncluded: boolean; includedSections: string[] } }> {
    return this.request("POST", "/api/observability/export");
  }

  /** audit ledger reset：必须显式 confirm: true */
  async resetObservabilityAuditLedger(reason: string): Promise<{ newEpoch: number; deleted: number }> {
    return this.request("POST", "/api/observability/audit/reset", { confirm: true, reason });
  }
}
