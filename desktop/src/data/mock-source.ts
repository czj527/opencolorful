import {
  activityLogs,
  agents,
  auditLogs,
  errorGroups,
  initialThreads,
  initialTimeline,
  logsHealth,
  memoryCompiled,
  memoryEvents,
  memoryFacts,
  memoryHealth,
  memoryMaintenance,
  memoryPinned,
  memoryTimelineEvents,
  memoryTimelineFacts,
  mockReplies,
  type Agent,
  type Thread,
} from "../mock-data.js";
import {
  applyEvent,
  applyLocalUserMessage,
  createProjector,
  markPromptSent,
  snapshotOf,
  type ChatSnapshot,
  type LiveEnvelope,
  type ProjectorState,
} from "./projector.js";
import type { ConnectionInfo, DesktopDataSource, LogsPageData, MemoryAgentSettingsView, MemoryPageData, ModelOption, ModelRef, PreferencesView, ProviderInput, ProviderView, SessionSettingsView, SessionUsageView, ActivityFilter, ActivityPageResult, SubagentThreadCard, SubagentTranscriptView } from "./source.js";
import type { AgentProfileView, AgentTemplateView, CreateAgentInput } from "./source.js";

interface MockSession {
  readonly projector: ProjectorState;
  readonly handlers: Set<(snapshot: ChatSnapshot) => void>;
  timers: number[];
  streamSeq: number;
  replyIndex: number;
}

/** T1：onboarding 模板 fixture（镜像服务端 BASE_COLOR_TEMPLATES 的形状与色系） */
const mockAgentTemplates: readonly AgentTemplateView[] = [
  { key: "blank", label: "空白", description: "从零开始自定义底色", color: "#888888", baseColor: { persona: "", personality: [], replyStyle: "", innerSetting: "" } },
  { key: "blue", label: "蓝色", description: "冷静理性", color: "#378ADD", baseColor: { persona: "我是一个冷静理性的助手，重视事实与逻辑，回答直接而不带情绪。", personality: ["理性", "客观", "严谨"], replyStyle: "简洁直接", innerSetting: "重视事实与逻辑，避免情绪化表达；不确定时明确说明。" } },
  { key: "orange", label: "橙色", description: "温柔知性", color: "#EF9F27", baseColor: { persona: "我是一个温柔知性的伙伴，善于倾听，愿意花时间陪伴。", personality: ["温和", "耐心", "善解人意"], replyStyle: "亲切详细", innerSetting: "注重陪伴感，关心对方情绪；不催促，不敷衍。" } },
  { key: "green", label: "绿色", description: "稳定包容", color: "#639922", baseColor: { persona: "我是一个稳定包容的对话者，遇事不躁，给你一个可以停靠的空间。", personality: ["稳重", "包容", "可靠"], replyStyle: "稳健平和", innerSetting: "尊重差异，不急于给结论；允许犹豫与反复。" } },
];

const MOCK_AGENT_COLORS = ["#5b8def", "#3aa96c", "#e87561", "#e8b128", "#8c72bf", "#d07fa8"] as const;

/** Mock 数据源：fixture + 模拟事件流（与真实数据源走同一份 projector） */
export class MockDataSource implements DesktopDataSource {
  readonly info: ConnectionInfo = { mode: "mock", connected: false, label: "离线 · mock 数据" };

  /** mock 连接状态静态：注册即回调一次当前值 */
  subscribeConnection(handler: (info: ConnectionInfo) => void): () => void {
    handler(this.info);
    return () => undefined;
  }

  private readonly sessions = new Map<string, MockSession>();
  private readonly threads: Thread[] = [...initialThreads];
  private idCounter = 100;
  private currentAgentName = agents[0]?.name ?? "Agent";
  private mockConfirmed = false;
  private mockToolMode = "all";
  // 偏好默认模型指向 moonshot（列表首个可用是 deepseek-local），
  // 验证桌面端按偏好选中而非“首个已配置”、且草稿运行设置随偏好（read-only / medium）
  private mockPreferences: PreferencesView = {
    defaults: {
      model: { providerId: "moonshot", modelId: "kimi-k3" },
      thinkingLevel: "medium",
      toolMode: "read-only",
    },
  };
  private mockMemorySettings: MemoryAgentSettingsView = {
    enabled: true,
    dailyRunTime: "03:00",
    minIdleMinutes: 30,
    injectBudgetChars: 2500,
    reviewEnabled: true,
  };
  private mockPinned: import("../mock-data.js").PinnedMemory[] = [...memoryPinned];
  // T1：可变 agents 列表（onboarding createAgent 会追加；静态 fixture 保持不变）
  private mockAgents: Agent[] = [...agents];
  private mockProfile: AgentProfileView = {
    id: "yuan",
    name: "原",
    createdAt: "2026-07-20T10:00:00+08:00",
    persona: "在代码、记忆与长期计划之间保持连续性。",
    personality: ["沉稳", "连续", "克制"],
    replyStyle: "简洁、直接，先理解再动手。",
    workspace: "D:\\PI-study\\opencolorful",
    sessionCount: 12,
    decorColor: "green",
  };
  private pinnedIdCounter = 0;

  setActiveAgentName(name: string) {
    this.currentAgentName = name;
  }

  private sessionFor(sessionId: string): MockSession {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      const projector = createProjector(this.currentAgentName);
      if (sessionId === "desktop") projector.items = [...initialTimeline];
      session = { projector, handlers: new Set(), timers: [], streamSeq: 0, replyIndex: 0 };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private emit(session: MockSession, type: string, payload: unknown, streamId: string | null) {
    session.streamSeq += 1;
    const envelope: LiveEnvelope = {
      eventId: `mock-e${session.streamSeq}-${type}`,
      streamId,
      sequence: session.streamSeq,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    applyEvent(session.projector, envelope);
    this.notify(session);
  }

  private notify(session: MockSession) {
    const snapshot = snapshotOf(session.projector);
    for (const handler of session.handlers) handler(snapshot);
  }

  private later(session: MockSession, ms: number, run: () => void) {
    session.timers.push(window.setTimeout(run, ms));
  }

  listAgents(): Promise<readonly Agent[]> {
    return Promise.resolve(this.mockAgents);
  }

  /* ---- T1：onboarding 创建助理（mock） ---- */

  listAgentTemplates(): Promise<readonly AgentTemplateView[]> {
    return Promise.resolve(mockAgentTemplates);
  }

  createAgent(input: CreateAgentInput): Promise<Agent> {
    this.pinnedIdCounter += 1;
    const agent: Agent = {
      id: `agent-mock-${this.pinnedIdCounter}`,
      name: input.name.trim(),
      initial: input.name.trim().slice(0, 1) || "A",
      color: MOCK_AGENT_COLORS[this.mockAgents.length % MOCK_AGENT_COLORS.length] ?? "#5b8def",
      description: (input.baseColor.persona || "").split(/[。！？\n]/)[0]?.slice(0, 26) ?? "",
      ...(input.defaultCwd ? { workspace: input.defaultCwd } : {}),
    };
    this.mockAgents.push(agent);
    return Promise.resolve(agent);
  }

  listThreads(): Promise<readonly Thread[]> {
    return Promise.resolve(this.threads.filter((thread) => !thread.archivedAt));
  }

  listArchivedThreads(): Promise<readonly Thread[]> {
    return Promise.resolve(this.threads.filter((thread) => Boolean(thread.archivedAt)));
  }

  createThread(agentId: string, title: string, _options?: import("./source.js").CreateThreadOptions): Promise<Thread> {
    this.idCounter += 1;
    const thread: Thread = { id: `t${this.idCounter}`, title, preview: "刚刚创建", time: "刚刚", status: "active", agentId };
    this.threads.unshift(thread);
    return Promise.resolve(thread);
  }

  async updateThreadTitle(sessionId: string, title: string): Promise<void> {
    const index = this.threads.findIndex((thread) => thread.id === sessionId);
    if (index === -1) return;
    const current = this.threads[index];
    if (current === undefined) return;
    this.threads[index] = { ...current, title };
  }

  async unarchiveThread(sessionId: string): Promise<void> {
    const index = this.threads.findIndex((thread) => thread.id === sessionId);
    if (index === -1) return;
    const current = this.threads[index];
    if (current === undefined) return;
    this.threads[index] = { ...current, archivedAt: undefined, time: "刚刚", status: "active" };
  }

  async compactSession(sessionId: string): Promise<void> {
    const session = this.sessionFor(sessionId);
    this.emit(session, "session.compacting", {}, null);
    this.later(session, 600, () => {
      this.emit(session, "session.compacted", { tokensBefore: 39200, tokensAfter: 18600 }, null);
    });
  }

  sendPrompt(sessionId: string, content: string): Promise<void> {
    void content;
    const session = this.sessionFor(sessionId);
    const projector = session.projector;
    applyLocalUserMessage(projector, content);
    this.notify(session);

    const streamId = `mock-stream-${session.streamSeq + 1}`;
    this.later(session, 200, () => {
      markPromptSent(projector, streamId);
      this.emit(session, "turn.started", { turnId: "mock-turn" }, streamId);
    });
    this.later(session, 450, () => {
      this.emit(session, "thinking.delta", { delta: "先确认用户意图与当前工作区状态，再决定是否需要调用工具；" }, streamId);
    });
    this.later(session, 650, () => {
      this.emit(session, "thinking.delta", { delta: "执行证据留在事件层，回复只保留结论。" }, streamId);
    });
    const reply = mockReplies[session.replyIndex % mockReplies.length] ?? "收到。";
    session.replyIndex += 1;
    const chunks = reply.match(/.{1,4}/gs) ?? [reply];
    this.later(session, 850, () => {
      this.emit(session, "message.started", { role: "assistant" }, streamId);
    });
    chunks.forEach((chunk, index) => {
      this.later(session, 900 + index * 36, () => {
        this.emit(session, "message.delta", { role: "assistant", delta: chunk }, streamId);
      });
    });
    const doneAt = 900 + chunks.length * 36;
    this.later(session, doneAt, () => {
      this.emit(session, "message.completed", { role: "assistant", content: reply }, streamId);
    });
    this.later(session, doneAt + 120, () => {
      this.emit(session, "turn.completed", { turnId: "mock-turn", usage: { input: 320, output: 180, cacheRead: 0, cacheWrite: 0, totalTokens: 500 } }, streamId);
    });
    return Promise.resolve();
  }

  abort(sessionId: string): Promise<void> {
    const session = this.sessionFor(sessionId);
    for (const timer of session.timers) window.clearTimeout(timer);
    session.timers = [];
    const projector = session.projector;
    projector.pendingPrompt = false;
    projector.streaming = false;
    const last = projector.items[projector.items.length - 1];
    if (last?.type === "message" && last.streaming === true) {
      projector.items = [...projector.items.slice(0, -1), { ...last, streaming: false, meta: "已停止" }];
    }
    this.notify(session);
    return Promise.resolve();
  }

  subscribeChat(sessionId: string, handler: (snapshot: ChatSnapshot) => void): () => void {
    const session = this.sessionFor(sessionId);
    session.handlers.add(handler);
    handler(snapshotOf(session.projector));
    return () => {
      session.handlers.delete(handler);
    };
  }

  getMemoryData(_agentId: string, query?: string): Promise<MemoryPageData> {
    // MEM-02 parity 修复（A4d）：对齐服务端 GET memory/facts|events 的 q 过滤——
    // 服务端 FTS 命中面 = fact 文本 / summary+topics（fact-store.ts / event-indexer.ts），
    // unicode61 对 ASCII 大小写折叠；空查询返回全量。
    const keyword = query?.trim() ?? "";
    const folded = keyword.toLowerCase();
    const facts = folded === ""
      ? memoryFacts
      : memoryFacts.filter((fact) => fact.fact.toLowerCase().includes(folded));
    const events = folded === ""
      ? memoryEvents
      : memoryEvents.filter((event) =>
        event.summary.toLowerCase().includes(folded)
        || event.topics.some((topic) => topic.toLowerCase().includes(folded)));
    return Promise.resolve({
      compiled: memoryCompiled,
      facts,
      events,
      pinned: this.mockPinned,
      health: memoryHealth,
      timelineFacts: memoryTimelineFacts,
      timelineEvents: memoryTimelineEvents,
      maintenance: memoryMaintenance,
    });
  }

  subscribeMemoryMaintenance(): () => void {
    return () => { /* mock 不推进后台整理状态 */ };
  }

  getLogsData(): Promise<LogsPageData> {
    return Promise.resolve({ health: logsHealth, activity: activityLogs, audit: auditLogs, errors: errorGroups });
  }

  /* ---- Provider 管理（mock，有状态） ---- */

  private mockProviders: {
    providerId: string;
    name: string;
    protocol: string;
    baseUrl: string;
    models: { modelId: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number }[];
    credentialConfigured: boolean;
  }[] = [
    {
      providerId: "deepseek-local", name: "DeepSeek 本地", protocol: "openai-responses", baseUrl: "http://127.0.0.1:8315/v1",
      models: [{ modelId: "deepseek-v3.2", name: "DeepSeek V3.2", reasoning: true, contextWindow: 128000, maxTokens: 8192 }],
      credentialConfigured: true,
    },
    {
      providerId: "moonshot", name: "Moonshot", protocol: "openai-completions", baseUrl: "https://api.moonshot.cn/v1",
      models: [{ modelId: "kimi-k3", name: "Kimi K3", reasoning: true, contextWindow: 256000, maxTokens: 8192 }],
      credentialConfigured: true,
    },
    {
      providerId: "openai", name: "OpenAI", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1",
      models: [{ modelId: "gpt-5.2", name: "GPT-5.2", reasoning: true, contextWindow: 200000, maxTokens: 16384 }],
      credentialConfigured: false,
    },
  ];

  listProviders(): Promise<readonly ProviderView[]> {
    return Promise.resolve(this.mockProviders);
  }

  upsertProvider(provider: ProviderInput, apiKey?: string): Promise<void> {
    const models = provider.models.map((model) => ({
      modelId: model.modelId,
      name: model.name,
      reasoning: model.capabilities.reasoning,
      contextWindow: model.capabilities.contextWindow,
      maxTokens: model.capabilities.maxTokens,
    }));
    const existing = this.mockProviders.find((item) => item.providerId === provider.providerId);
    if (existing !== undefined) {
      existing.name = provider.name;
      existing.protocol = provider.protocol;
      existing.baseUrl = provider.baseUrl;
      existing.models = models;
      if (apiKey !== undefined && apiKey !== "") existing.credentialConfigured = true;
    } else {
      this.mockProviders.push({
        providerId: provider.providerId,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        models,
        credentialConfigured: apiKey !== undefined && apiKey !== "",
      });
    }
    return Promise.resolve();
  }

  /* ---- 会话设置 / 模型 / 用量（mock） ---- */

  listModels(): Promise<readonly ModelOption[]> {
    return Promise.resolve(this.mockProviders.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.providerId,
        modelId: model.modelId,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        credentialConfigured: provider.credentialConfigured,
      })),
    ));
  }

  getPreferences(): Promise<PreferencesView> {
    return Promise.resolve(this.mockPreferences);
  }

  updatePreferences(patch: { defaults: { model?: ModelRef | null; toolMode?: string; thinkingLevel?: string } }): Promise<void> {
    this.mockPreferences = {
      defaults: {
        model: patch.defaults.model === undefined ? this.mockPreferences.defaults.model : patch.defaults.model,
        thinkingLevel: patch.defaults.thinkingLevel ?? this.mockPreferences.defaults.thinkingLevel,
        toolMode: patch.defaults.toolMode ?? this.mockPreferences.defaults.toolMode,
      },
    };
    return Promise.resolve();
  }

  getSessionSettings(): Promise<SessionSettingsView> {
    return Promise.resolve({
      toolMode: this.mockToolMode,
      thinkingLevel: "high",
      workspaceCwd: "D:\\PI-study\\opencolorful",
      workspaceConfirmed: this.mockConfirmed,
      model: { providerId: "deepseek-local", modelId: "deepseek-v3.2" },
    });
  }

  updateSessionModel(): Promise<void> {
    return Promise.resolve();
  }

  updateSessionSettings(_sessionId: string, patch?: { toolMode?: string; thinkingLevel?: string; workspaceConfirmed?: boolean }): Promise<void> {
    if (patch?.workspaceConfirmed !== undefined) this.mockConfirmed = patch.workspaceConfirmed;
    if (patch?.toolMode !== undefined) this.mockToolMode = patch.toolMode;
    return Promise.resolve();
  }

  getSessionUsage(): Promise<SessionUsageView> {
    return Promise.resolve({ totalTokens: 39200, turns: 6, contextTokens: 38400, contextWindow: 128000, contextPercent: 30 });
  }

  /* ---- 记忆增强（mock） ---- */

  deepDiveMemory(): Promise<void> {
    return Promise.resolve();
  }

  getMemoryRunReport(): Promise<string> {
    return Promise.resolve("## 后台整理报告（mock）\n\n- 核对事实 3 条，无冲突\n- 合并相近记忆 1 组\n- 强度提案 0 条待审批");
  }

  /* ---- T5：助理档案与记忆日用写操作（mock） ---- */

  getAgentProfile(): Promise<AgentProfileView> {
    return Promise.resolve(this.mockProfile);
  }

  async updateAgentProfile(_agentId: string, patch: { readonly name?: string; readonly description?: string }): Promise<void> {
    this.mockProfile = {
      ...this.mockProfile,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { persona: patch.description } : {}),
    };
  }

  async updateAgentBaseColor(_agentId: string, patch: import("./source.js").AgentBaseColorPatch): Promise<void> {
    this.mockProfile = {
      ...this.mockProfile,
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
      ...(patch.personality !== undefined ? { personality: [...patch.personality] } : {}),
      ...(patch.replyStyle !== undefined ? { replyStyle: patch.replyStyle } : {}),
    };
  }

  getMemorySettings(): Promise<MemoryAgentSettingsView> {
    return Promise.resolve(this.mockMemorySettings);
  }

  async updateMemorySettings(_agentId: string, patch: Partial<MemoryAgentSettingsView>): Promise<void> {
    this.mockMemorySettings = { ...this.mockMemorySettings, ...patch };
  }

  async addPinnedMemory(_agentId: string, content: string): Promise<import("../mock-data.js").PinnedMemory> {
    this.pinnedIdCounter += 1;
    const item: import("../mock-data.js").PinnedMemory = {
      id: `pin-mock-${this.pinnedIdCounter}`,
      content: content.trim(),
      createdAt: new Date().toISOString(),
    };
    this.mockPinned.unshift(item);
    return item;
  }

  async removePinnedMemory(_agentId: string, pinnedId: string): Promise<void> {
    this.mockPinned = this.mockPinned.filter((item) => item.id !== pinnedId);
  }

  /* ---- 日志服务端查询 / 实时跟随（mock） ---- */

  queryActivity(filter: ActivityFilter): Promise<ActivityPageResult> {
    const rows = activityLogs.filter((row) => {
      if (filter.category !== undefined && filter.category !== "" && row.category !== filter.category) return false;
      if (filter.level !== undefined && filter.level !== "" && row.level !== filter.level) return false;
      if (filter.status !== undefined && filter.status !== "" && row.status !== filter.status) return false;
      if (filter.search !== undefined && filter.search !== "" && !row.eventName.includes(filter.search)) return false;
      return true;
    });
    return Promise.resolve({ rows, nextCursor: null });
  }

  subscribeActivityStream(): () => void {
    return () => { /* mock 不产生实时日志 */ };
  }

  /* ---- Subagent 只读（mock） ---- */

  listSubagentThreads(): Promise<readonly SubagentThreadCard[]> {
    return Promise.resolve([
      {
        threadId: "sat_mock01",
        createdAt: "2026-08-20T10:47:00+08:00",
        title: "前端参考调研",
        status: "closed",
        model: "deepseek-v3.2",
        latestRunStatus: "succeeded",
        resultSummary: "三家共同点：普通文本不折叠；执行块给出短摘要、状态与明确的展开入口。",
        artifactCount: 1,
      },
    ]);
  }

  getSubagentTranscript(): Promise<SubagentTranscriptView> {
    return Promise.resolve({
      threadId: "sat_mock01",
      title: "前端参考调研",
      status: "closed",
      model: "deepseek-v3.2",
      taskObjective: "核对 openhanako、deepseek-harness、codex 的消息与执行块渲染方式，输出可借鉴点。",
      runs: [
        { runId: "sar_mock01", status: "succeeded", toolCallCount: 9, totalTokens: 8200, resultSummary: "调研完成，结论已回传。" },
      ],
      messages: [
        { id: "sm1", runId: "sar_mock01", type: "task", sender: "parent_agent:yuan", text: "核对三个参考项目的前端渲染方式。", deliveryStatus: "delivered", createdAt: "2026-08-20T10:45:31+08:00" },
        { id: "sm2", runId: "sar_mock01", type: "progress", sender: "subagent:lin", text: "openhanako 的折叠语义已确认，继续看 harness。", deliveryStatus: "delivered", createdAt: "2026-08-20T10:46:12+08:00" },
        { id: "sm3", runId: "sar_mock01", type: "result", sender: "subagent:lin", text: "三家共同点：普通文本不折叠；执行块给出短摘要、状态与明确的展开入口。", deliveryStatus: "delivered", createdAt: "2026-08-20T10:46:58+08:00" },
      ],
      artifacts: [
        { artifactId: "saa_mock01", name: "ui-research-notes.md", kind: "file", sizeBytes: 2048 },
      ],
    });
  }
}
