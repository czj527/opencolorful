export interface ServerStatus {
  readonly status: string;
  readonly version: string;
  readonly pid: number;
  readonly uptimeSeconds: number;
}

export interface SessionView {
  readonly id: string;
  readonly title: string;
  readonly sessionPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly messages: readonly string[];
  readonly toolMode?: string;
  readonly workspaceCwd?: string | null;
  readonly workspaceConfirmed?: boolean;
  readonly thinkingLevel?: string;
  readonly model?: { readonly providerId: string; readonly modelId: string } | null;
}

export interface ModelSummary {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
}

export interface PromptAccepted {
  readonly status: string;
  readonly sessionId: string;
  readonly streamId: string;
}

export interface AbortResult {
  readonly status: string;
}

export class TuiApiClient {
  /**
   * @param token 可选本机服务访问令牌（P0-1 信任边界）。CLI 侧经
   * readPresentServerToken（env > 令牌文件）只读解析后传入；写请求依赖它通过
   * 服务端校验。令牌不落日志、不进错误消息。
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string | null,
  ) {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { "x-oc-token": this.token } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        (error as { message?: string }).message ?? `HTTP ${response.status}`,
      );
    }
    return response.json() as Promise<T>;
  }

  async getHealth(): Promise<ServerStatus> {
    return this.request<ServerStatus>("/api/health");
  }

  async listSessions(): Promise<SessionView[]> {
    return this.request<SessionView[]>("/api/sessions");
  }

  async createSession(title: string, cwd: string): Promise<SessionView> {
    return this.request<SessionView>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title, cwd }),
    });
  }

  async getSession(id: string): Promise<SessionView> {
    return this.request<SessionView>(`/api/sessions/${id}`);
  }

  async deleteSession(id: string): Promise<SessionView> {
    return this.request<SessionView>(`/api/sessions/${id}`, {
      method: "DELETE",
    });
  }

  async listModels(): Promise<ModelSummary[]> {
    return this.request<ModelSummary[]>("/api/models");
  }

  async sendPrompt(
    sessionId: string,
    content: string,
  ): Promise<PromptAccepted> {
    return this.request<PromptAccepted>(
      `/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    );
  }

  async abort(
    sessionId: string,
    streamId: string,
  ): Promise<AbortResult> {
    return this.request<AbortResult>(
      `/api/sessions/${sessionId}/abort`,
      {
        method: "POST",
        body: JSON.stringify({ streamId }),
      },
    );
  }

  async compact(sessionId: string): Promise<{ readonly status: string }> {
    return this.request<{ readonly status: string }>(
      `/api/sessions/${sessionId}/compact`,
      { method: "POST" },
    );
  }

  getEventsUrl(sessionId: string, sinceSeq?: number): string {
    const params = sinceSeq !== undefined ? `?sinceSeq=${sinceSeq}` : "";
    return `${this.baseUrl}/api/sessions/${sessionId}/events${params}`;
  }

  async listProviders(): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>("/api/settings/providers");
  }

  async updateSessionSettings(
    sessionId: string,
    settings: Record<string, unknown>,
  ): Promise<SessionView> {
    return this.request<SessionView>(`/api/sessions/${sessionId}/settings`, {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  }

  async setSessionModel(
    sessionId: string,
    providerId: string,
    modelId: string,
  ): Promise<SessionView> {
    return this.request<SessionView>(`/api/sessions/${sessionId}/model`, {
      method: "PUT",
      body: JSON.stringify({ providerId, modelId }),
    });
  }

  async configureProvider(
    provider: Record<string, unknown>,
    apiKey?: string,
  ): Promise<Record<string, unknown>> {
    return this.request("/api/settings/providers", {
      method: "PUT",
      body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}) }),
    });
  }
}
