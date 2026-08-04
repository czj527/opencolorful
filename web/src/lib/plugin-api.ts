import { ApiClientError } from "./api-client.js";
import type {
  AgentPluginBinding,
  AgentPluginBindingInput,
  PluginDetail,
  PluginDevInvokeResult,
  PluginDevScenarioInput,
  PluginDevState,
  PluginDiagnostics,
  PluginInspectInput,
  PluginInspectResult,
  PluginInstallInput,
  PluginInstallResult,
  PluginListItem,
  PluginSource,
  PluginSourceSearchQuery,
  PluginSourceSearchResult,
} from "./plugin-types.js";

/**
 * Phase 12 插件 API client（plans/phase-12.md §十八）。
 *
 * - 全部端点基于 §十八 冻结契约；
 * - `listAgentBindings` / `listPluginGrants` 是契约内端点（GET /api/agents/:agentId/plugins、
 *   GET /api/plugins/:id）在 Web 端的展示用途组合——Server 未接线时抛 ApiClientError
 *   （404/502/503），由调用方 try/catch 降级为「插件服务未就绪」空态；
 * - 开发态使用独立 `/api/plugins/dev/*` namespace。
 */
export class PluginApiClient {
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
      let error: { code?: string; message?: string; retryable?: boolean };
      try {
        error = (await response.json()) as { code?: string; message?: string; retryable?: boolean };
      } catch {
        error = {};
      }
      throw new ApiClientError(
        error.code ?? "UNKNOWN",
        error.message ?? response.statusText,
        error.retryable ?? false,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  // ── 已安装插件 ──────────────────────────────────────────────
  async listPlugins(): Promise<readonly PluginListItem[]> {
    return this.request<readonly PluginListItem[]>("GET", "/api/plugins");
  }

  async getPlugin(id: string): Promise<PluginDetail> {
    return this.request<PluginDetail>("GET", `/api/plugins/${encodeURIComponent(id)}`);
  }

  async inspectPlugin(input: PluginInspectInput): Promise<PluginInspectResult> {
    return this.request<PluginInspectResult>("POST", "/api/plugins/inspect", input);
  }

  async installPlugin(input: PluginInstallInput): Promise<PluginInstallResult> {
    return this.request<PluginInstallResult>("POST", "/api/plugins/install", input);
  }

  async enablePlugin(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>("POST", `/api/plugins/${encodeURIComponent(id)}/enable`);
  }

  async disablePlugin(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>("POST", `/api/plugins/${encodeURIComponent(id)}/disable`);
  }

  async updatePlugin(id: string): Promise<PluginInstallResult> {
    return this.request<PluginInstallResult>("POST", `/api/plugins/${encodeURIComponent(id)}/update`);
  }

  async rollbackPlugin(id: string): Promise<PluginInstallResult> {
    return this.request<PluginInstallResult>("POST", `/api/plugins/${encodeURIComponent(id)}/rollback`);
  }

  async uninstallPlugin(id: string): Promise<{ pluginId: string; status: string }> {
    return this.request<{ pluginId: string; status: string }>("DELETE", `/api/plugins/${encodeURIComponent(id)}`);
  }

  async pluginDiagnostics(id: string): Promise<PluginDiagnostics> {
    return this.request<PluginDiagnostics>("GET", `/api/plugins/${encodeURIComponent(id)}/diagnostics`);
  }

  // ── 来源 ────────────────────────────────────────────────────
  async listPluginSources(): Promise<readonly PluginSource[]> {
    return this.request<readonly PluginSource[]>("GET", "/api/plugin-sources");
  }

  async searchPluginSources(query: PluginSourceSearchQuery): Promise<readonly PluginSourceSearchResult[]> {
    return this.request<readonly PluginSourceSearchResult[]>("POST", "/api/plugin-sources/search", query);
  }

  // ── Agent 绑定（契约内 PUT/DELETE）───────────────────────────
  async bindPluginToAgent(
    agentId: string,
    pluginId: string,
    input: AgentPluginBindingInput,
  ): Promise<AgentPluginBinding> {
    return this.request<AgentPluginBinding>(
      "PUT",
      `/api/agents/${encodeURIComponent(agentId)}/plugins/${encodeURIComponent(pluginId)}`,
      input,
    );
  }

  async unbindPluginFromAgent(agentId: string, pluginId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      "DELETE",
      `/api/agents/${encodeURIComponent(agentId)}/plugins/${encodeURIComponent(pluginId)}`,
    );
  }

  /** 展示用途组合：GET /api/agents/:agentId/plugins（§十八 隐含列表端点）。Server 未接线时 404 降级。 */
  async listAgentBindings(agentId: string): Promise<readonly AgentPluginBinding[]> {
    return this.request<readonly AgentPluginBinding[]>("GET", `/api/agents/${encodeURIComponent(agentId)}/plugins`);
  }

  // ── 开发态（/api/plugins/dev/*）──────────────────────────────
  async devInstall(input: { sourceDir: string; fullAccess?: boolean; sourceType?: string }): Promise<PluginDevState> {
    return this.request<PluginDevState>("POST", "/api/plugins/dev/install", input);
  }

  async devReload(id: string): Promise<PluginDevState> {
    return this.request<PluginDevState>("POST", `/api/plugins/dev/${encodeURIComponent(id)}/reload`);
  }

  async devEnable(id: string): Promise<PluginDevState> {
    return this.request<PluginDevState>("POST", `/api/plugins/dev/${encodeURIComponent(id)}/enable`);
  }

  async devDisable(id: string): Promise<PluginDevState> {
    return this.request<PluginDevState>("POST", `/api/plugins/dev/${encodeURIComponent(id)}/disable`);
  }

  async devReset(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>("POST", `/api/plugins/dev/${encodeURIComponent(id)}/reset`);
  }

  async devDiagnostics(id: string): Promise<PluginDiagnostics> {
    return this.request<PluginDiagnostics>("GET", `/api/plugins/dev/${encodeURIComponent(id)}/diagnostics`);
  }

  async devInvokeTool(id: string, input: {
    agentId?: string;
    sessionId?: string;
    toolName: string;
    args?: Readonly<Record<string, unknown>>;
  }): Promise<PluginDevInvokeResult> {
    return this.request<PluginDevInvokeResult>(
      "POST",
      `/api/plugins/dev/${encodeURIComponent(id)}/invoke-tool`,
      input,
    );
  }

  async devListSurfaces(): Promise<readonly string[]> {
    return this.request<readonly string[]>("GET", "/api/plugins/dev/surfaces");
  }

  async devRunScenario(id: string, input: PluginDevScenarioInput): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return this.request<{ ok: boolean; result?: unknown; error?: string }>(
      "POST",
      `/api/plugins/dev/${encodeURIComponent(id)}/run-scenario`,
      input,
    );
  }
}

/**
 * 判断错误是否表示插件服务未就绪（Server /api/plugins* 路由尚未接线）。
 * - 404/405：路由不存在；
 * - 502/503：上游 Agent Server 未启动或服务不可用。
 */
export function isPluginServiceUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 502 || error.status === 503;
}
