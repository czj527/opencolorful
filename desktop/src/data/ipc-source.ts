import type {
  Agent,
  ActivityLogRow,
  LogLevel,
  AuditDecision,
  MemoryMaintenance,
  Thread,
} from "../mock-data.js";
import {
  applyEvent,
  applyLocalUserMessage,
  createProjector,
  markPromptFailed,
  markPromptSent,
  projectHistory,
  seedItems,
  snapshotOf,
  type ChatSnapshot,
  type HistoryEntry,
  type LiveEnvelope,
  type ProjectorState,
} from "./projector.js";
import type {
  ActivityFilter,
  ActivityPageResult,
  AgentProfileView,
  AgentTemplateView,
  ConnectionInfo,
  CreateAgentInput,
  DesktopDataSource,
  LogsPageData,
  MemoryAgentSettingsView,
  MemoryPageData,
  ModelOption,
  ModelRef,
  PreferencesView,
  ProviderInput,
  ProviderView,
  SessionSettingsView,
  SessionUsageView,
  SubagentThreadCard,
  SubagentTranscriptView,
} from "./source.js";

/* ---- 服务端响应的最小契约形状（对齐 web/src/lib/types.ts 与 contracts） ---- */

interface AgentViewWire {
  readonly identity: { readonly id: string; readonly name: string; readonly createdAt?: string };
  readonly baseColor?: { readonly persona?: string; readonly personality?: readonly string[]; readonly replyStyle?: string };
  readonly settings?: { readonly defaultCwd?: string | null };
  readonly sessionCount?: number;
  readonly decorColor?: string;
}

interface SessionViewWire {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly archivedAt?: string;
  readonly agentId: string | null;
  readonly workspaceCwd: string | null;
  readonly messageEntries: readonly HistoryEntry[];
}

interface PromptResponseWire {
  readonly status: string;
  readonly streamId: string;
}

const DECOR_COLORS: Record<string, string> = {
  blue: "#5b8def",
  teal: "#3aa96c",
  coral: "#e87561",
  amber: "#e8b128",
  purple: "#8c72bf",
  pink: "#d07fa8",
  green: "#4caf7d",
};

/** AgentView（服务端）→ 桌面 Agent 卡片模型（listAgents / createAgent 共用） */
function mapAgentView(view: AgentViewWire, index: number): Agent {
  return {
    id: view.identity.id,
    name: view.identity.name,
    initial: view.identity.name.slice(0, 1) || "A",
    color: DECOR_COLORS[view.decorColor ?? ""] ?? Object.values(DECOR_COLORS)[index % 7] ?? "#5b8def",
    description: (view.baseColor?.persona ?? "").split(/[。！？\n]/)[0]?.slice(0, 26) ?? "",
    ...(view.settings?.defaultCwd ? { workspace: view.settings.defaultCwd } : {}),
  };
}

function unwrap<T>(value: unknown, key: string): T {
  if (value !== null && typeof value === "object" && key in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)[key] as T;
  }
  return value as T;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function formatThreadTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${date.getMonth() + 1}-${date.getDate()}`;
}

/** ActivityRow（服务端行）→ 桌面展示行 */
function mapActivityRow(row: Record<string, unknown>) {
  return {
    id: Number(row["id"]),
    recordedAt: String(row["recordedAt"] ?? ""),
    eventName: String(row["eventName"] ?? ""),
    level: String(row["level"] ?? "info") as LogLevel,
    status: String(row["status"] ?? "—"),
    category: String(row["category"] ?? ""),
    producerComponent: String(row["producerComponent"] ?? ""),
    durationMs: typeof row["durationMs"] === "number" ? row["durationMs"] : null,
    sessionId: typeof row["sessionId"] === "string" ? row["sessionId"] : null,
    ownerAgentId: typeof row["ownerAgentId"] === "string" ? row["ownerAgentId"] : null,
    traceId: String(row["traceId"] ?? ""),
    payloadPreview: String(row["payloadJson"] ?? "").slice(0, 160),
  };
}

interface ChatChannel {
  readonly projector: ProjectorState;
  readonly handlers: Set<(snapshot: ChatSnapshot) => void>;
  sseSubId: string | null;
  historyLoaded: boolean;
  /** 合批窗内排队的事件（leading 事件已立即应用，不在此列） */
  pending: LiveEnvelope[];
  /** 当前 pendingFlush 的调度句柄；null 表示无进行中的合批窗口 */
  flushToken: { cancel: () => void } | null;
}

/** 后端可达性巡检间隔（连接状态动态化的慢路径；请求成功/失败是快路径） */
const HEALTH_POLL_MS = 8_000;

/** 真实数据源：经 Electron 主进程代理访问 Supervisor/Agent Server */
export class IpcDataSource implements DesktopDataSource {
  private connectionInfo: ConnectionInfo;
  private readonly hostLabel: string;
  private readonly connectionHandlers = new Set<(info: ConnectionInfo) => void>();
  private healthInFlight = false;

  private readonly api: NonNullable<Window["desktopApi"]>;
  private agentViews: readonly AgentViewWire[] = [];
  private readonly chats = new Map<string, ChatChannel>();
  private readonly memorySubs = new Map<string, { handler: (payload: unknown) => void }>();
  private readonly activityStreamHandlers = new Map<string, (row: ReturnType<typeof mapActivityRow>) => void>();
  private eventRouterRegistered = false;

  private constructor(api: NonNullable<Window["desktopApi"]>, base: string) {
    this.api = api;
    this.hostLabel = base.replace("http://", "");
    this.connectionInfo = { mode: "ipc", connected: true, label: `已连接 · ${this.hostLabel}` };
    this.startHealthWatch();
  }

  get info(): ConnectionInfo {
    return this.connectionInfo;
  }

  /** 连接状态订阅（Titlebar 离线指示）；注册即回调当前值 */
  subscribeConnection(handler: (info: ConnectionInfo) => void): () => void {
    this.connectionHandlers.add(handler);
    handler(this.connectionInfo);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  private setConnection(connected: boolean): void {
    if (this.connectionInfo.connected === connected) return;
    this.connectionInfo = {
      mode: "ipc",
      connected,
      label: connected ? `已连接 · ${this.hostLabel}` : `离线 · ${this.hostLabel}（自动重连中）`,
    };
    for (const handler of this.connectionHandlers) handler(this.connectionInfo);
  }

  /** 定期探活：失败转离线（Titlebar 变灰），恢复自动转回；重叠请求用 inFlight 去重 */
  private startHealthWatch(): void {
    setInterval(() => {
      if (this.healthInFlight) return;
      this.healthInFlight = true;
      this.api.invoke("GET", "/api/health")
        .then((result) => this.setConnection(result.ok))
        .catch(() => this.setConnection(false))
        .finally(() => {
          this.healthInFlight = false;
        });
    }, HEALTH_POLL_MS);
  }

  /** 探测后端可达性；不可达返回 null（调用方回退 mock） */
  static async probe(): Promise<IpcDataSource | null> {
    const api = window.desktopApi;
    if (api === undefined) return null;
    const result = await api.invoke("GET", "/api/health");
    if (!result.ok) return null;
    return new IpcDataSource(api, result.base);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.api.invoke(method, path, body);
    if (!result.ok) {
      // 网络层失败（不可达/502）立即转离线，不等下一次巡检
      if (result.status === 0 || result.status === 502) this.setConnection(false);
      const data = result.data as { message?: string } | null;
      throw new Error(data?.message ?? `请求失败（${result.status}）`);
    }
    this.setConnection(true);
    // api-proxy 对"HTTP 200 + 非 JSON 响应"的包装：显式抛错，不当空数据静默（台账 #8）
    const payload = result.data as { code?: unknown; message?: unknown } | null;
    if (payload !== null && typeof payload === "object" && payload.code === "INVALID_JSON") {
      throw new Error(`服务返回了无法解析的响应：${typeof payload.message === "string" ? payload.message.slice(0, 120) : "未知内容"}`);
    }
    return result.data as T;
  }

  private agentNameOf(agentId: string | null): string {
    if (agentId === null) return "Agent";
    return this.agentViews.find((view) => view.identity.id === agentId)?.identity.name ?? "Agent";
  }

  private threadFromSession(session: SessionViewWire): Thread {
    const last = session.messageEntries[session.messageEntries.length - 1];
    const preview = (last?.content ?? "").replace(/\s+/g, " ").slice(0, 28) || "（空会话）";
    const updated = new Date(session.updatedAt);
    const isToday = !Number.isNaN(updated.getTime()) && updated.toDateString() === new Date().toDateString();
    return {
      id: session.id,
      title: session.title || "未命名会话",
      preview,
      time: formatThreadTime(session.updatedAt),
      status: isToday ? "active" : "quiet",
      agentId: session.agentId,
      archivedAt: session.archivedAt,
    };
  }

  private archivedThreadFromSession(session: SessionViewWire): Thread {
    return {
      ...this.threadFromSession(session),
      archivedAt: session.archivedAt ?? session.updatedAt,
    };
  }

  async listAgents(): Promise<readonly Agent[]> {
    const data = await this.request<unknown>("GET", "/api/agents");
    this.agentViews = asArray<AgentViewWire>(unwrap(data, "agents"));
    return this.agentViews.map((view, index) => mapAgentView(view, index));
  }

  /* ---- T1：onboarding 创建助理 ---- */

  async listAgentTemplates(): Promise<readonly AgentTemplateView[]> {
    const data = await this.request<unknown>("GET", "/api/agents/templates");
    return asArray<AgentTemplateView>(data);
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const body: Record<string, unknown> = { name: input.name, baseColor: input.baseColor };
    if (input.defaultCwd !== undefined) body["defaultCwd"] = input.defaultCwd;
    const view = await this.request<AgentViewWire>("POST", "/api/agents", body);
    return mapAgentView(view, 0);
  }

  async listThreads(): Promise<readonly Thread[]> {
    const data = await this.request<unknown>("GET", "/api/sessions");
    const sessions = asArray<SessionViewWire>(unwrap(data, "sessions"));
    return sessions.filter((session) => !session.archived).map((session) => this.threadFromSession(session));
  }

  async createThread(agentId: string, title: string, options?: import("./source.js").CreateThreadOptions): Promise<Thread> {
    const view = this.agentViews.find((item) => item.identity.id === agentId);
    const cwd = options?.cwd ?? view?.settings?.defaultCwd ?? null;
    if (cwd === null || cwd.trim() === "") throw new Error("该 Agent 未配置默认工作目录，请先在设置中配置");
    const body: Record<string, unknown> = { title, cwd, agentId };
    if (options?.toolMode !== undefined) body["toolMode"] = options.toolMode;
    if (options?.thinkingLevel !== undefined) body["thinkingLevel"] = options.thinkingLevel;
    // workspaceConfirmed 如实转发调用方（表单勾选）的状态；不允许按 toolMode 自动置真——
    // 未确认的 all 模式由服务端 fail-safe 降级只读，并走横幅确认流程
    if (options?.workspaceConfirmed !== undefined) body["workspaceConfirmed"] = options.workspaceConfirmed;
    const session = await this.request<SessionViewWire>("POST", "/api/sessions", body);
    return this.threadFromSession(session);
  }

  async listArchivedThreads(): Promise<readonly Thread[]> {
    const data = await this.request<unknown>("GET", "/api/sessions?includeArchived=true");
    const sessions = asArray<SessionViewWire>(unwrap(data, "sessions"));
    return sessions
      .filter((session) => session.archived)
      .map((session) => this.archivedThreadFromSession(session));
  }

  async updateThreadTitle(sessionId: string, title: string): Promise<void> {
    await this.request("PUT", `/api/sessions/${encodeURIComponent(sessionId)}/title`, { title });
  }

  async unarchiveThread(sessionId: string): Promise<void> {
    await this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/unarchive`);
  }

  async compactSession(sessionId: string): Promise<void> {
    await this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/compact`);
  }

  async sendPrompt(sessionId: string, content: string): Promise<void> {
    const channel = this.chatFor(sessionId);
    applyLocalUserMessage(channel.projector, content);
    this.notify(channel);
    try {
      const response = await this.request<PromptResponseWire>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { content });
      markPromptSent(channel.projector, response.streamId);
    } catch (cause) {
      markPromptFailed(channel.projector, cause instanceof Error ? cause.message : "发送失败");
      this.notify(channel);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const channel = this.chatFor(sessionId);
    const streamId = channel.projector.activeStreamId;
    if (streamId === null) return;
    try {
      await this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/abort`, { streamId });
    } catch {
      // abort 失败不改变本地状态；服务端事件会收敛
    }
  }

  subscribeChat(sessionId: string, handler: (snapshot: ChatSnapshot) => void): () => void {
    const channel = this.chatFor(sessionId);
    channel.handlers.add(handler);
    this.ensureEventRouter();
    if (!channel.historyLoaded) {
      channel.historyLoaded = true;
      void this.request<SessionViewWire>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`)
        .then((session) => {
          channel.projector.agentName = this.agentNameOf(session.agentId);
          seedItems(channel.projector, projectHistory(session.messageEntries, channel.projector.agentName));
          this.notify(channel);
        })
        .catch((cause: unknown) => {
          pushChannelError(channel, cause);
          this.notify(channel);
        });
      channel.sseSubId = this.api.subscribeEvents(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
    }
    handler(snapshotOf(channel.projector));
    return () => {
      channel.handlers.delete(handler);
      if (channel.handlers.size === 0) {
        // 取消订阅即取消合批窗口：不再消费该 channel 的排队事件
        if (channel.flushToken !== null) {
          channel.flushToken.cancel();
          channel.flushToken = null;
        }
        channel.pending.length = 0;
        if (channel.sseSubId !== null) this.api.unsubscribeEvents(channel.sseSubId);
        this.chats.delete(sessionId);
      }
    };
  }

  async getMemoryData(agentId: string, query?: string): Promise<MemoryPageData> {
    const base = `/api/agents/${encodeURIComponent(agentId)}/memory`;
    const search = query !== undefined && query.trim() !== "" ? `?query=${encodeURIComponent(query.trim())}` : "";
    const [compiled, facts, events, pinned, health, timeline] = await Promise.all([
      this.request<unknown>("GET", `${base}/compiled`),
      this.request<unknown>("GET", `${base}/facts${search}`),
      this.request<unknown>("GET", `${base}/events${search}`),
      this.request<unknown>("GET", `${base}/pinned`),
      this.request<unknown>("GET", `${base}/health`),
      this.request<unknown>("GET", `${base}/timeline`),
    ]);
    const healthBody = unwrap<Record<string, unknown>>(health, "health") ?? {};
    const timelineBody = unwrap<Record<string, unknown>>(timeline, "timeline") ?? timeline as Record<string, unknown>;
    return {
      compiled: unwrap(compiled, "sections") as MemoryPageData["compiled"],
      facts: asArray(unwrap(facts, "facts")) as MemoryPageData["facts"],
      events: asArray(unwrap(events, "events")) as MemoryPageData["events"],
      pinned: asArray(unwrap(pinned, "pinned")) as MemoryPageData["pinned"],
      health: {
        latestRecallStatus: typeof healthBody["latestRecallStatus"] === "string" ? healthBody["latestRecallStatus"] : "idle",
        latestRecallEpisodes: asArray(healthBody["latestRecallEpisodes"]) as MemoryPageData["health"]["latestRecallEpisodes"],
        pendingBatches: asArray(healthBody["pendingBatches"]) as MemoryPageData["health"]["pendingBatches"],
      },
      timelineFacts: asArray(timelineBody?.["facts"]) as MemoryPageData["timelineFacts"],
      timelineEvents: asArray(timelineBody?.["events"]) as MemoryPageData["timelineEvents"],
      maintenance: null,
    };
  }

  subscribeMemoryMaintenance(agentId: string, handler: (maintenance: MemoryMaintenance) => void): () => void {
    this.ensureEventRouter();
    const subId = this.api.subscribeEvents(`/api/agents/${encodeURIComponent(agentId)}/events`);
    this.memorySubs.set(subId, { handler: (payload) => handler(payload as MemoryMaintenance) });
    return () => {
      this.api.unsubscribeEvents(subId);
      this.memorySubs.delete(subId);
    };
  }

  async getLogsData(): Promise<LogsPageData> {
    const [healthResult, activityRes, auditRes, errorsRes] = await Promise.all([
      this.request<unknown>("GET", "/api/observability/health").catch(() => null),
      this.request<unknown>("GET", "/api/observability/activity?limit=200"),
      this.request<unknown>("GET", "/api/observability/audit?limit=200"),
      this.request<unknown>("GET", "/api/observability/errors?limit=100"),
    ]);

    let health: LogsPageData["health"] = null;
    if (healthResult !== null) {
      const body = healthResult as Record<string, unknown>;
      const logger = (body["logger"] ?? {}) as Record<string, unknown>;
      const disk = (logger["disk"] ?? {}) as Record<string, unknown>;
      const spool = (body["spool"] ?? {}) as Record<string, unknown>;
      health = {
        logger: {
          degraded: logger["degraded"] === true,
          dropped: Number(logger["dropped"] ?? 0),
          failed: Number(logger["failed"] ?? 0),
          diskTotalMb: Math.round(Number(disk["totalBytes"] ?? 0) / 1_000_000),
        },
        spool: { pendingSegments: Number(spool["pendingSegments"] ?? 0) },
        auditEpoch: Number(body["auditEpoch"] ?? 0),
      };
    }

    const activityRows = asArray<Record<string, unknown>>(unwrap(activityRes, "items")).map(mapActivityRow);

    const auditRows = asArray<Record<string, unknown>>(unwrap(auditRes, "items")).map((row) => ({
      id: Number(row["id"]),
      recordedAt: String(row["recordedAt"] ?? ""),
      eventName: String(row["eventName"] ?? row["action"] ?? ""),
      action: String(row["action"] ?? ""),
      decision: String(row["decision"] ?? "required") as AuditDecision,
      reasonCode: typeof row["reasonCode"] === "string" ? row["reasonCode"] : null,
      actorKind: String(row["actorKind"] ?? ""),
      actorId: String(row["actorId"] ?? ""),
      sessionId: typeof row["sessionId"] === "string" ? row["sessionId"] : null,
      traceId: String(row["traceId"] ?? ""),
      ledgerEpoch: Number(row["ledgerEpoch"] ?? 0),
    }));

    return {
      health,
      activity: activityRows,
      audit: auditRows,
      errors: asArray(unwrap(errorsRes, "items")) as LogsPageData["errors"],
    };
  }

  /* ---- Provider 管理 ---- */

  async listProviders(): Promise<readonly ProviderView[]> {
    const data = await this.request<unknown>("GET", "/api/settings/providers");
    return asArray<Record<string, unknown>>(unwrap(data, "providers")).map((provider) => ({
      providerId: String(provider["providerId"] ?? ""),
      name: String(provider["name"] ?? ""),
      protocol: String(provider["protocol"] ?? ""),
      baseUrl: String(provider["baseUrl"] ?? ""),
      models: asArray<Record<string, unknown>>(provider["models"]).map((model) => {
        const capabilities = (model["capabilities"] ?? {}) as Record<string, unknown>;
        return {
          modelId: String(model["modelId"] ?? ""),
          name: String(model["name"] ?? model["modelId"] ?? ""),
          reasoning: capabilities["reasoning"] === true,
          contextWindow: Number(capabilities["contextWindow"] ?? 0),
          maxTokens: Number(capabilities["maxTokens"] ?? 0),
        };
      }),
      credentialConfigured: provider["credentialConfigured"] === true,
    }));
  }

  async upsertProvider(provider: ProviderInput, apiKey?: string): Promise<void> {
    await this.request("PUT", "/api/settings/providers", {
      provider,
      ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
    });
  }

  /* ---- 会话设置 / 模型 / 用量 ---- */

  async listModels(): Promise<readonly ModelOption[]> {
    const data = await this.request<unknown>("GET", "/api/models");
    return asArray<Record<string, unknown>>(unwrap(data, "models")).map((model) => {
      const capabilities = (model["capabilities"] ?? {}) as Record<string, unknown>;
      return {
        providerId: String(model["providerId"] ?? ""),
        modelId: String(model["modelId"] ?? ""),
        name: String(model["name"] ?? model["modelId"] ?? ""),
        reasoning: capabilities["reasoning"] === true,
        contextWindow: Number(capabilities["contextWindow"] ?? 0),
        credentialConfigured: model["credentialConfigured"] === true,
      };
    });
  }

  async getSessionSettings(sessionId: string): Promise<SessionSettingsView> {
    const session = await this.request<Record<string, unknown>>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
    const model = session["model"] as Record<string, unknown> | null;
    return {
      toolMode: String(session["toolMode"] ?? "read-only"),
      thinkingLevel: String(session["thinkingLevel"] ?? "medium"),
      workspaceCwd: typeof session["workspaceCwd"] === "string" ? session["workspaceCwd"] : null,
      workspaceConfirmed: session["workspaceConfirmed"] === true,
      model: model !== null && typeof model === "object"
        ? { providerId: String(model["providerId"] ?? ""), modelId: String(model["modelId"] ?? "") }
        : null,
    };
  }

  async updateSessionModel(sessionId: string, model: ModelRef): Promise<void> {
    await this.request("PUT", `/api/sessions/${encodeURIComponent(sessionId)}/model`, model);
  }

  async updateSessionSettings(sessionId: string, patch: { toolMode?: string; thinkingLevel?: string; workspaceConfirmed?: boolean }): Promise<void> {
    await this.request("PUT", `/api/sessions/${encodeURIComponent(sessionId)}/settings`, patch);
  }

  async getPreferences(): Promise<PreferencesView> {
    const data = await this.request<Record<string, unknown>>("GET", "/api/settings/preferences");
    const defaults = (data["defaults"] ?? {}) as Record<string, unknown>;
    const model = defaults["model"] as Record<string, unknown> | null;
    return {
      defaults: {
        model: model !== null && typeof model === "object"
          ? { providerId: String(model["providerId"] ?? ""), modelId: String(model["modelId"] ?? "") }
          : null,
        toolMode: String(defaults["toolMode"] ?? "read-only"),
        thinkingLevel: String(defaults["thinkingLevel"] ?? "medium"),
      },
    };
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageView> {
    const data = await this.request<Record<string, unknown>>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/usage`);
    const totals = (data["totals"] ?? {}) as Record<string, unknown>;
    const context = (data["context"] ?? null) as Record<string, unknown> | null;
    return {
      totalTokens: Number(totals["totalTokens"] ?? 0),
      turns: Number(data["turns"] ?? 0),
      contextTokens: context !== null && typeof context["tokens"] === "number" ? context["tokens"] : null,
      contextWindow: context !== null ? Number(context["contextWindow"] ?? 0) : 0,
      contextPercent: context !== null && typeof context["percent"] === "number" ? context["percent"] : null,
    };
  }

  /* ---- 记忆增强 ---- */

  async deepDiveMemory(agentId: string): Promise<void> {
    await this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/memory/deep-dive`);
  }

  async getMemoryRunReport(agentId: string, runId: string): Promise<string> {
    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/memory/runs/${encodeURIComponent(runId)}`,
    );
    return typeof data["report"] === "string" ? data["report"] : "（无报告内容）";
  }

  /* ---- T5：助理档案与记忆日用写操作 ---- */

  async getAgentProfile(agentId: string): Promise<AgentProfileView> {
    const view = await this.request<AgentViewWire>("GET", `/api/agents/${encodeURIComponent(agentId)}`);
    const identity = view.identity ?? { id: agentId, name: "Agent" };
    const baseColor = view.baseColor ?? {};
    const settings = view.settings ?? {};
    return {
      id: identity.id,
      name: identity.name,
      createdAt: identity.createdAt ?? null,
      persona: baseColor.persona ?? "",
      personality: baseColor.personality ?? [],
      replyStyle: baseColor.replyStyle ?? "",
      workspace: settings.defaultCwd ?? null,
      sessionCount: view.sessionCount ?? 0,
      decorColor: view.decorColor ?? "blue",
    };
  }

  async updateAgentProfile(agentId: string, patch: { readonly name?: string; readonly description?: string }): Promise<void> {
    if (patch.name !== undefined) {
      await this.request("PUT", `/api/agents/${encodeURIComponent(agentId)}`, { name: patch.name });
    }
    if (patch.description !== undefined) {
      await this.request("PUT", `/api/agents/${encodeURIComponent(agentId)}/base-color`, { persona: patch.description });
    }
  }

  async updateAgentBaseColor(agentId: string, patch: import("./source.js").AgentBaseColorPatch): Promise<void> {
    // 服务端按键过滤，未提供的字段不改动；空 patch 直接跳过（避免无意义写）
    const body: Record<string, unknown> = {};
    if (patch.persona !== undefined) body["persona"] = patch.persona;
    if (patch.personality !== undefined) body["personality"] = [...patch.personality];
    if (patch.replyStyle !== undefined) body["replyStyle"] = patch.replyStyle;
    if (patch.innerSetting !== undefined) body["innerSetting"] = patch.innerSetting;
    if (Object.keys(body).length === 0) return;
    await this.request("PUT", `/api/agents/${encodeURIComponent(agentId)}/base-color`, body);
  }

  async getMemorySettings(agentId: string): Promise<MemoryAgentSettingsView> {
    const data = await this.request<Record<string, unknown>>("GET", `/api/agents/${encodeURIComponent(agentId)}/memory/settings`);
    const settings = (data["settings"] ?? {}) as Record<string, unknown>;
    return {
      enabled: settings["enabled"] === true,
      dailyRunTime: typeof settings["dailyRunTime"] === "string" ? settings["dailyRunTime"] : "03:00",
      minIdleMinutes: typeof settings["minIdleMinutes"] === "number" ? settings["minIdleMinutes"] : 30,
      injectBudgetChars: typeof settings["injectBudgetChars"] === "number" ? settings["injectBudgetChars"] : 2500,
    };
  }

  async updateMemorySettings(agentId: string, patch: Partial<MemoryAgentSettingsView>): Promise<void> {
    const current = await this.request<Record<string, unknown>>("GET", `/api/agents/${encodeURIComponent(agentId)}/memory/settings`);
    const settings = (current["settings"] ?? {}) as Record<string, unknown>;
    const next = { ...settings, ...patch };
    await this.request("PUT", `/api/agents/${encodeURIComponent(agentId)}/memory/settings`, next);
  }

  async addPinnedMemory(agentId: string, content: string): Promise<import("../mock-data.js").PinnedMemory> {
    const data = await this.request<Record<string, unknown>>("POST", `/api/agents/${encodeURIComponent(agentId)}/memory/pinned`, { content });
    return data["pinned"] as import("../mock-data.js").PinnedMemory;
  }

  async removePinnedMemory(agentId: string, pinnedId: string): Promise<void> {
    await this.request("DELETE", `/api/agents/${encodeURIComponent(agentId)}/memory/pinned/${encodeURIComponent(pinnedId)}`);
  }

  /* ---- 日志服务端查询 / 实时跟随 ---- */

  async queryActivity(filter: ActivityFilter, cursor: string | null = null, limit = 200): Promise<ActivityPageResult> {
    const params = new URLSearchParams();
    if (filter.category !== undefined && filter.category !== "") params.set("category", filter.category);
    if (filter.level !== undefined && filter.level !== "") params.set("level", filter.level);
    if (filter.status !== undefined && filter.status !== "") params.set("status", filter.status);
    if (filter.search !== undefined && filter.search !== "") params.set("search", filter.search);
    if (filter.ownerAgentId !== undefined && filter.ownerAgentId !== "") params.set("ownerAgentId", filter.ownerAgentId);
    if (filter.sessionId !== undefined && filter.sessionId !== "") params.set("sessionId", filter.sessionId);
    if (cursor !== null) params.set("cursor", cursor);
    params.set("limit", String(limit));
    const data = await this.request<unknown>("GET", `/api/observability/activity?${params.toString()}`);
    const body = (data ?? {}) as Record<string, unknown>;
    return {
      rows: asArray<Record<string, unknown>>(body["items"]).map(mapActivityRow),
      nextCursor: typeof body["nextCursor"] === "string" ? body["nextCursor"] : null,
    };
  }

  subscribeActivityStream(handler: (row: ActivityLogRow) => void): () => void {
    this.ensureEventRouter();
    const subId = this.api.subscribeEvents("/api/observability/activity/stream");
    this.activityStreamHandlers.set(subId, handler);
    return () => {
      this.api.unsubscribeEvents(subId);
      this.activityStreamHandlers.delete(subId);
    };
  }

  /* ---- Subagent 只读 ---- */

  async listSubagentThreads(agentId: string, sessionId: string): Promise<readonly SubagentThreadCard[]> {
    // 服务端无 session 级列表端点：经 activity subagent.thread.created 发现（scope.sessionId=父会话）
    const params = new URLSearchParams({ eventName: "subagent.thread.created", sessionId, limit: "50" });
    const data = await this.request<unknown>("GET", `/api/observability/activity?${params.toString()}`);
    const rows = asArray<Record<string, unknown>>((data as Record<string, unknown>)?.["items"]);
    const discovered = new Map<string, string>();
    for (const row of rows) {
      const threadId = typeof row["subagentThreadId"] === "string" ? row["subagentThreadId"] : null;
      if (threadId === null || discovered.has(threadId)) continue;
      discovered.set(threadId, String(row["recordedAt"] ?? ""));
    }
    const cards = await Promise.all([...discovered.entries()].map(async ([threadId, createdAt]) => {
      try {
        const view = await this.getSubagentTranscript(agentId, sessionId, threadId);
        const latestRun = view.runs[view.runs.length - 1];
        return {
          threadId,
          createdAt,
          title: view.title,
          status: view.status,
          model: view.model,
          latestRunStatus: latestRun?.status ?? null,
          resultSummary: latestRun?.resultSummary ?? null,
          artifactCount: view.artifacts.length,
        };
      } catch {
        return { threadId, createdAt, title: threadId, status: "unknown", model: "", latestRunStatus: null, resultSummary: null, artifactCount: 0 };
      }
    }));
    return cards.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async getSubagentTranscript(agentId: string, sessionId: string, threadId: string): Promise<SubagentTranscriptView> {
    const params = new URLSearchParams({ ownerAgentId: agentId, parentSessionId: sessionId, limit: "200" });
    const data = await this.request<Record<string, unknown>>(
      "GET",
      `/api/subagents/threads/${encodeURIComponent(threadId)}/transcript?${params.toString()}`,
    );
    const thread = (data["thread"] ?? {}) as Record<string, unknown>;
    const taskBrief = (data["taskBrief"] ?? null) as Record<string, unknown> | null;
    const runs = asArray<Record<string, unknown>>(data["runs"]).map((run) => {
      const result = (run["result"] ?? null) as Record<string, unknown> | null;
      return {
        runId: String(run["runId"] ?? ""),
        status: String(run["status"] ?? ""),
        toolCallCount: Number(run["toolCallCount"] ?? 0),
        totalTokens: Number(run["totalTokens"] ?? 0),
        resultSummary: result !== null && typeof result["summary"] === "string" ? result["summary"] : null,
      };
    });
    const messages = asArray<Record<string, unknown>>(data["messages"]).map((message) => {
      const sender = (message["sender"] ?? {}) as Record<string, unknown>;
      const parts = asArray<Record<string, unknown>>(message["parts"]);
      const text = parts.map((part) => {
        if (part["kind"] === "text") return String(part["text"] ?? "");
        if (part["kind"] === "artifact_ref") return "[artifact]";
        if (part["kind"] === "data") return "[data]";
        return "[ref]";
      }).join("");
      return {
        id: String(message["messageId"] ?? ""),
        runId: String(message["runId"] ?? ""),
        type: String(message["messageType"] ?? ""),
        sender: `${String(sender["kind"] ?? "")}:${String(sender["id"] ?? "")}`,
        text,
        deliveryStatus: String(message["deliveryStatus"] ?? ""),
        createdAt: String(message["createdAt"] ?? ""),
      };
    });
    const artifacts = asArray<Record<string, unknown>>(data["artifacts"]).map((artifact) => ({
      artifactId: String(artifact["artifactId"] ?? ""),
      name: String(artifact["name"] ?? ""),
      kind: String(artifact["kind"] ?? ""),
      sizeBytes: typeof artifact["sizeBytes"] === "number" ? artifact["sizeBytes"] : null,
    }));
    return {
      threadId: String(thread["threadId"] ?? threadId),
      title: String(thread["title"] ?? threadId),
      status: String(thread["status"] ?? ""),
      model: String(thread["modelId"] ?? ""),
      taskObjective: taskBrief !== null && typeof taskBrief["objective"] === "string" ? taskBrief["objective"] : null,
      runs,
      messages,
      artifacts,
    };
  }

  /* ---- 内部 ---- */

  private chatFor(sessionId: string): ChatChannel {
    let channel = this.chats.get(sessionId);
    if (channel === undefined) {
      channel = {
        projector: createProjector(this.agentNameOf(null)),
        handlers: new Set(), sseSubId: null, historyLoaded: false,
        pending: [], flushToken: null,
      };
      this.chats.set(sessionId, channel);
    }
    return channel;
  }

  private notify(channel: ChatChannel) {
    const snapshot = snapshotOf(channel.projector);
    for (const handler of channel.handlers) handler(snapshot);
  }

  /**
   * SSE 事件按 channel 合批：leading 事件立即应用并通知（保住首个 token 的呈现延迟），
   * 同帧（rAF 不可用退 50ms）内到达的后续事件入队，trailing flush 时依次应用、只通知一次。
   */
  private enqueueChatEvent(channel: ChatChannel, envelope: LiveEnvelope): void {
    if (channel.flushToken === null) {
      applyEvent(channel.projector, envelope);
      this.notify(channel);
      channel.flushToken = this.scheduleFlush(channel);
    } else {
      channel.pending.push(envelope);
    }
  }

  private scheduleFlush(channel: ChatChannel): { cancel: () => void } {
    const flush = () => {
      channel.flushToken = null;
      if (channel.pending.length === 0) return;
      const queued = channel.pending;
      channel.pending = [];
      for (const envelope of queued) applyEvent(channel.projector, envelope);
      this.notify(channel);
    };
    if (typeof requestAnimationFrame === "function") {
      const rafId = requestAnimationFrame(flush);
      return { cancel: () => cancelAnimationFrame(rafId) };
    }
    const timerId = setTimeout(flush, 50);
    return { cancel: () => clearTimeout(timerId) };
  }

  private ensureEventRouter() {
    if (this.eventRouterRegistered) return;
    this.eventRouterRegistered = true;
    this.api.onEvent(({ subId, frame }) => {
      for (const channel of this.chats.values()) {
        if (channel.sseSubId !== subId) continue;
        let envelope: LiveEnvelope;
        try {
          envelope = JSON.parse(frame.data) as LiveEnvelope;
        } catch {
          return;
        }
        this.enqueueChatEvent(channel, envelope);
        return;
      }
      const activityHandler = this.activityStreamHandlers.get(subId);
      if (activityHandler !== undefined) {
        if (frame.event !== "activity") return;
        try {
          activityHandler(mapActivityRow(JSON.parse(frame.data) as Record<string, unknown>));
        } catch {
          // 无法解析的帧忽略
        }
        return;
      }
      const memorySub = this.memorySubs.get(subId);
      if (memorySub !== undefined) {
        try {
          const envelope = JSON.parse(frame.data) as LiveEnvelope;
          if (!envelope.type.startsWith("memory.agent.")) return;
          const status = envelope.type.replace("memory.agent.", "");
          if (status === "layer_changed") return; // 中间层事件不推进维护状态
          const payload = (envelope.payload ?? {}) as Record<string, unknown>;
          memorySub.handler({
            status,
            ...(typeof payload["phase"] === "string" ? { phase: payload["phase"] } : {}),
            ...(typeof payload["runId"] === "string" ? { runId: payload["runId"] } : {}),
            at: envelope.timestamp,
          } as MemoryMaintenance);
        } catch {
          // 无法解析的帧忽略
        }
      }
    });
  }
}

function pushChannelError(channel: ChatChannel, cause: unknown) {
  markPromptFailed(channel.projector, cause instanceof Error ? cause.message : "加载失败");
}
