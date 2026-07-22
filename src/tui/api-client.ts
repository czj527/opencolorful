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
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
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
}
