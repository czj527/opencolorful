import {
  activityLogs,
  agents,
  auditLogs,
  BRANCH_DEMO_SESSION_ID,
  branchDemoBranches,
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
  projectBranchEntries,
  seedItems,
  snapshotOf,
  type BranchEntry,
  type ChatSnapshot,
  type LiveEnvelope,
  type ProjectorState,
} from "./projector.js";
import type {
  ActivityFilter,
  ActivityPageResult,
  AgentProfileView,
  AgentTemplateView,
  BranchEntriesView,
  BranchEntryView,
  BranchStateUpdate,
  BranchSummaryView,
  BranchTreeView,
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
  UsageSummaryFilterView,
  UsageSummaryView,
  UsageTokenTotals,
} from "./source.js";

interface MockSession {
  readonly projector: ProjectorState;
  readonly handlers: Set<(snapshot: ChatSnapshot) => void>;
  timers: number[];
  streamSeq: number;
  replyIndex: number;
  /** 波次 B3：分支状态订阅者（mock 分支场景驱动） */
  readonly branchHandlers: Set<(update: BranchStateUpdate) => void>;
}

/** 波次 B3：分支演示会话的可变运行状态（脚本化分支树 + 模拟 busy 409） */
interface MockBranchState {
  /** 当前分支在「脚本分支 + extra」序列中的下标 */
  currentIndex: number;
  /** 额外分支（fork 产物 / 重生成新分支），追加在脚本分支之后 */
  extra: { branchId: string; leafPreview: string; entries: readonly BranchEntry[] }[];
  /** 演示用：置真后下一次分支操作返回 409 SESSION_BUSY（setBranchBusy 测试钩子） */
  busy: boolean;
}

/** T1：onboarding 模板 fixture（镜像服务端 BASE_COLOR_TEMPLATES 的形状与色系） */
const mockAgentTemplates: readonly AgentTemplateView[] = [
  { key: "blank", label: "空白", description: "从零开始自定义底色", color: "#888888", baseColor: { persona: "", personality: [], replyStyle: "", innerSetting: "" } },
  { key: "blue", label: "蓝色", description: "冷静理性", color: "#378ADD", baseColor: { persona: "我是一个冷静理性的助手，重视事实与逻辑，回答直接而不带情绪。", personality: ["理性", "客观", "严谨"], replyStyle: "简洁直接", innerSetting: "重视事实与逻辑，避免情绪化表达；不确定时明确说明。" } },
  { key: "orange", label: "橙色", description: "温柔知性", color: "#EF9F27", baseColor: { persona: "我是一个温柔知性的伙伴，善于倾听，愿意花时间陪伴。", personality: ["温和", "耐心", "善解人意"], replyStyle: "亲切详细", innerSetting: "注重陪伴感，关心对方情绪；不催促，不敷衍。" } },
  { key: "green", label: "绿色", description: "稳定包容", color: "#639922", baseColor: { persona: "我是一个稳定包容的对话者，遇事不躁，给你一个可以停靠的空间。", personality: ["稳重", "包容", "可靠"], replyStyle: "稳健平和", innerSetting: "尊重差异，不急于给结论；允许犹豫与反复。" } },
];

const MOCK_AGENT_COLORS = ["#5b8def", "#3aa96c", "#e87561", "#e8b128", "#8c72bf", "#d07fa8"] as const;

/* ---- A8：全局用量 mock fixture（确定性；聚合语义与后端 usage-store 对齐） ---- */

/** 单条用量记录（对应 usage_recorder 落库一行：source/role/status + token 四段） */
interface MockUsageRecord {
  readonly sessionId: string | null;
  readonly source: "main" | "subagent" | "utility";
  readonly role: "primary" | "secondary";
  readonly status: "completed" | "failed" | "cancelled" | "timeout" | "interrupted" | "budget_exhausted";
  readonly provider: string;
  readonly model: string;
  /** 距今天数（0 = 今天）；days 过滤按 recordDays < days 语义（对齐后端近 N 天窗口） */
  readonly daysAgo: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const emptyTotals = (): UsageTokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

/** 可变累加器（UsageTokenTotals 字段 readonly，聚合时用本地可变形状） */
type MutableTotals = { -readonly [K in keyof UsageTokenTotals]: UsageTokenTotals[K] };

function addTotals(target: MutableTotals, record: Pick<MockUsageRecord, "input" | "output" | "cacheRead" | "cacheWrite">): void {
  target.input += record.input;
  target.output += record.output;
  target.cacheRead += record.cacheRead;
  target.cacheWrite += record.cacheWrite;
  target.totalTokens += record.input + record.output + record.cacheRead + record.cacheWrite;
}

/** 日期桶 key（YYYY-MM-DD，按 daysAgo 反推的确定日期） */
function mockDateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 固定记录：main 若干（主对话，primary/secondary 混合，含 failed/cancelled）+ subagent + utility；
 * daysAgo 跨 7/30/90 三个窗口（12/45 天各一条），供时间范围过滤断言 */
const MOCK_USAGE_RECORDS: readonly MockUsageRecord[] = [
  { sessionId: "s-main-1", source: "main", role: "primary", status: "completed", provider: "deepseek-local", model: "deepseek-v3.2", daysAgo: 0, input: 4200, output: 1800, cacheRead: 2600, cacheWrite: 400 },
  { sessionId: "s-main-1", source: "main", role: "primary", status: "completed", provider: "deepseek-local", model: "deepseek-v3.2", daysAgo: 0, input: 3100, output: 1200, cacheRead: 1900, cacheWrite: 0 },
  { sessionId: "s-main-2", source: "main", role: "primary", status: "failed", provider: "deepseek-local", model: "deepseek-v3.2", daysAgo: 1, input: 1500, output: 0, cacheRead: 800, cacheWrite: 0 },
  { sessionId: "s-main-2", source: "main", role: "secondary", status: "cancelled", provider: "moonshot", model: "kimi-k3", daysAgo: 1, input: 900, output: 300, cacheRead: 0, cacheWrite: 0 },
  { sessionId: "s-main-3", source: "main", role: "primary", status: "completed", provider: "moonshot", model: "kimi-k3", daysAgo: 2, input: 5200, output: 2400, cacheRead: 3100, cacheWrite: 600 },
  { sessionId: "s-main-3", source: "main", role: "secondary", status: "completed", provider: "moonshot", model: "kimi-k3", daysAgo: 3, input: 1100, output: 500, cacheRead: 200, cacheWrite: 0 },
  { sessionId: null, source: "subagent", role: "primary", status: "completed", provider: "deepseek-local", model: "deepseek-v3.2", daysAgo: 0, input: 6800, output: 3600, cacheRead: 2200, cacheWrite: 900 },
  { sessionId: null, source: "subagent", role: "secondary", status: "completed", provider: "moonshot", model: "kimi-k3", daysAgo: 1, input: 2400, output: 1100, cacheRead: 500, cacheWrite: 0 },
  { sessionId: null, source: "subagent", role: "primary", status: "timeout", provider: "deepseek-local", model: "deepseek-v3.2", daysAgo: 2, input: 3300, output: 600, cacheRead: 0, cacheWrite: 0 },
  { sessionId: null, source: "utility", role: "secondary", status: "completed", provider: "moonshot", model: "kimi-k3", daysAgo: 0, input: 700, output: 350, cacheRead: 100, cacheWrite: 0 },
  { sessionId: null, source: "utility", role: "secondary", status: "completed", provider: "moonshot", model: "kimi-k3", daysAgo: 12, input: 650, output: 250, cacheRead: 80, cacheWrite: 0 },
  { sessionId: "s-main-4", source: "main", role: "primary", status: "completed", provider: "deepseek-local", model: "deepseek-v3.2", daysAgo: 45, input: 5200, output: 2100, cacheRead: 900, cacheWrite: 100 },
];

/** 服务端 summary(days) 语义：四段求和 + 分组聚合 + cacheHitRate（input+cacheRead 分母） */
function summarizeRecords(records: readonly MockUsageRecord[], days: number): UsageSummaryView {
  const totals = emptyTotals();
  const byDay = new Map<string, UsageTokenTotals>();
  const byModel = new Map<string, UsageTokenTotals & { provider: string; model: string }>();
  const bySource = new Map<MockUsageRecord["source"], UsageTokenTotals & { source: MockUsageRecord["source"]; calls: number }>();
  const byRole = new Map<MockUsageRecord["role"], UsageTokenTotals & { role: MockUsageRecord["role"]; calls: number }>();
  const byStatus = new Map<MockUsageRecord["status"], UsageTokenTotals & { status: MockUsageRecord["status"]; calls: number }>();
  const sessionIds = new Set<string>();
  let turns = 0;

  for (const record of records) {
    addTotals(totals, record);
    if (record.source === "main") turns += 1;
    if (record.sessionId !== null) sessionIds.add(record.sessionId);

    const dayKey = mockDateKey(record.daysAgo);
    const day = byDay.get(dayKey) ?? emptyTotals();
    addTotals(day, record);
    byDay.set(dayKey, day);

    const modelKey = `${record.provider}/${record.model}`;
    const model = byModel.get(modelKey) ?? { provider: record.provider, model: record.model, ...emptyTotals() };
    addTotals(model, record);
    byModel.set(modelKey, model);

    const source = bySource.get(record.source) ?? { source: record.source, ...emptyTotals(), calls: 0 };
    addTotals(source, record);
    source.calls += 1;
    bySource.set(record.source, source);

    const role = byRole.get(record.role) ?? { role: record.role, ...emptyTotals(), calls: 0 };
    addTotals(role, record);
    role.calls += 1;
    byRole.set(record.role, role);

    const status = byStatus.get(record.status) ?? { status: record.status, ...emptyTotals(), calls: 0 };
    addTotals(status, record);
    status.calls += 1;
    byStatus.set(record.status, status);
  }

  const denominator = totals.input + totals.cacheRead;
  const bucket = <K, V extends UsageTokenTotals>(map: Map<K, V>): V[] =>
    [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    days,
    totals,
    cacheHitRate: denominator > 0 ? totals.cacheRead / denominator : null,
    sessions: sessionIds.size,
    turns,
    calls: records.length,
    byDay: [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, day]) => ({ date, ...day })),
    byModel: bucket(byModel),
    bySource: bucket(bySource),
    byRole: bucket(byRole),
    byStatus: bucket(byStatus),
  };
}

/** 波次 B3：Mock 分支操作错误（对齐服务端稳定错误码；UI 按 code 分态） */
class MockBranchError extends Error {
  readonly code: "NOT_FOUND" | "INVALID_INPUT" | "SESSION_BUSY" | "CONFLICT";

  constructor(code: "NOT_FOUND" | "INVALID_INPUT" | "SESSION_BUSY" | "CONFLICT", message: string) {
    super(message);
    this.name = "MockBranchError";
    this.code = code;
  }
}

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
      if (sessionId === BRANCH_DEMO_SESSION_ID) {
        // 波次 B3：分支演示会话以受控条目投影（锚点齐备）作为初始 timeline
        seedItems(projector, projectBranchEntries(this.branchDemoCurrent().entries, this.currentAgentName));
      }
      session = { projector, handlers: new Set(), timers: [], streamSeq: 0, replyIndex: 0, branchHandlers: new Set() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /* ---- 波次 B3：分支演示场景（多分支 / 切换 / 重生成 / Fork） ---- */

  private branchState = new Map<string, MockBranchState>();

  private branchStateFor(sessionId: string): MockBranchState {
    let state = this.branchState.get(sessionId);
    if (state === undefined) {
      state = { currentIndex: 0, extra: [], busy: false };
      this.branchState.set(sessionId, state);
    }
    return state;
  }

  private isBranchScenario(sessionId: string): boolean {
    return sessionId === BRANCH_DEMO_SESSION_ID || this.branchState.has(sessionId);
  }

  /** 当前分支的全部条目（脚本分支 + extra） */
  private branchDemoCurrent(): { branchId: string; leafPreview: string; entries: readonly BranchEntry[] } {
    const state = this.branchStateFor(BRANCH_DEMO_SESSION_ID);
    const scripted: readonly { branchId: string; leafPreview: string; entries: readonly BranchEntry[] }[] = [
      ...branchDemoBranches.map((branch) => ({ branchId: branch.branchId, leafPreview: branch.leafPreview, entries: branch.entries as readonly BranchEntry[] })),
      ...state.extra,
    ];
    const branch = scripted[state.currentIndex] ?? scripted[0];
    if (branch === undefined) return { branchId: "", leafPreview: "", entries: [] };
    return branch;
  }

  /** 分支树视图（含 isCurrent 高亮；空会话/非分支会话 → branches: []） */
  private branchTreeOf(sessionId: string): BranchTreeView {
    if (!this.isBranchScenario(sessionId)) return { currentBranchId: null, branches: [] };
    const state = this.branchStateFor(sessionId);
    const scripted: readonly { branchId: string; leafPreview: string; entries: readonly BranchEntry[] }[] = [
      ...branchDemoBranches.map((branch) => ({ branchId: branch.branchId, leafPreview: branch.leafPreview, entries: branch.entries as readonly BranchEntry[] })),
      ...state.extra,
    ];
    const currentBranchId = this.branchDemoCurrent().branchId;
    const branches: BranchSummaryView[] = scripted.map((branch) => ({
      branchId: branch.branchId,
      leafEntryId: branch.branchId,
      leafPreview: branch.leafPreview,
      entryCount: branch.entries.length,
      updatedAt: branch.entries[branch.entries.length - 1]?.timestamp ?? "",
      isCurrent: branch.branchId === currentBranchId,
    }));
    return { currentBranchId, branches };
  }

  private branchEntriesOf(sessionId: string, branchId?: string): BranchEntriesView {
    if (!this.isBranchScenario(sessionId)) return { branchId: null, currentBranchId: null, entries: [] };
    const tree = this.branchTreeOf(sessionId);
    const target = branchId !== undefined && branchId !== "" ? branchId : tree.currentBranchId;
    const state = this.branchStateFor(sessionId);
    const scripted: readonly { branchId: string; entries: readonly BranchEntry[] }[] = [
      ...branchDemoBranches,
      ...state.extra,
    ];
    const branch = scripted.find((item) => item.branchId === target) ?? scripted[0];
    return {
      branchId: branch?.branchId ?? null,
      currentBranchId: tree.currentBranchId,
      entries: branch ? [...branch.entries] : [],
    };
  }

  private notifyBranchState(sessionId: string, update: BranchStateUpdate): void {
    if (!this.isBranchScenario(sessionId)) return;
    const session = this.sessionFor(sessionId);
    for (const handler of session.branchHandlers) handler(update);
  }

  private emitBranchEvent(session: MockSession, sessionId: string, type: "session.branch.switched" | "session.branches.changed", payload: Record<string, unknown>): void {
    session.streamSeq += 1;
    if (type === "session.branch.switched") {
      this.notifyBranchState(sessionId, { kind: "switched", branchId: String(payload["branchId"] ?? "") });
      return;
    }
    const reason = payload["reason"];
    this.notifyBranchState(sessionId, {
      kind: "branchesChanged",
      reason: reason === "fork" || reason === "switch" ? reason : "regenerate",
    });
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

  /* ---- 波次 B3：分支场景（Mock 与 IPC wire-shape parity） ---- */

  getBranchTree(sessionId: string): Promise<BranchTreeView> {
    return Promise.resolve(this.branchTreeOf(sessionId));
  }

  getBranchEntries(sessionId: string, branchId?: string): Promise<BranchEntriesView> {
    return Promise.resolve(this.branchEntriesOf(sessionId, branchId));
  }

  switchBranch(sessionId: string, branchId: string): Promise<void> {
    if (!this.isBranchScenario(sessionId)) return Promise.resolve();
    const state = this.branchStateFor(sessionId);
    try {
      this.assertBranchIdle(sessionId, state);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const tree = this.branchTreeOf(sessionId);
    if (!tree.branches.some((branch) => branch.branchId === branchId)) {
      return Promise.reject(new MockBranchError("NOT_FOUND", "引用的会话节点不存在，请刷新后重试"));
    }
    const index = this.allBranchIds(sessionId).indexOf(branchId);
    state.currentIndex = Math.max(0, index);
    // 服务端语义：switch 后会话流收到 switched + branches.changed{switch}
    this.emitBranchEvent(this.sessionFor(sessionId), sessionId, "session.branch.switched", { branchId });
    this.emitBranchEvent(this.sessionFor(sessionId), sessionId, "session.branches.changed", { reason: "switch" });
    this.resyncBranchProjector(sessionId);
    return Promise.resolve();
  }

  regenerateMessage(sessionId: string, targetEntryId: string, text: string): Promise<void> {
    const state = this.branchStateFor(sessionId);
    try {
      this.assertBranchIdle(sessionId, state);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const branch = this.branchDemoCurrent();
    // 与服务端一致：目标不存在 → 404；非用户消息目标沿父链解析到所属轮次的用户条目
    const target = branch.entries.find((item) => item.entryId === targetEntryId);
    if (target === undefined) {
      return Promise.reject(new MockBranchError("NOT_FOUND", "引用的会话节点不存在，请刷新后重试"));
    }
    let entry = target;
    while (entry.role !== "user") {
      if (entry.parentId === null) {
        return Promise.reject(new MockBranchError("INVALID_INPUT", "只能从用户消息重新生成"));
      }
      const parent = branch.entries.find((item) => item.entryId === entry.parentId);
      if (parent === undefined) {
        return Promise.reject(new MockBranchError("NOT_FOUND", "引用的会话节点不存在，请刷新后重试"));
      }
      entry = parent;
    }
    if (entry.turnId === null) {
      return Promise.reject(new MockBranchError("INVALID_INPUT", "只能从用户消息重新生成"));
    }
    // 脚本化：与目标同父的脚本兄弟分支视为重生成产物（turn-e-u1 → e-u1b 分支）；
    // 无预置兄弟时按真实语义新建兄弟分支（同父新用户条目 + 助手回复）
    const session = this.sessionFor(sessionId);
    const scriptedSibling = branchDemoBranches.find((item) =>
      item.entries.some((itemEntry) => itemEntry.parentId === entry.parentId && itemEntry.role === "user" && itemEntry.entryId !== entry.entryId));
    const parentId = entry.parentId;
    const newEntryId = scriptedSibling !== undefined
      ? scriptedSibling.branchId
      : `e-regen-${++this.idCounter}`;
    const newBranchId = newEntryId;
    if (scriptedSibling === undefined) {
      const prefix = branch.entries.slice(0, branch.entries.findIndex((item) => item.entryId === entry.entryId) + 1);
      state.extra.push({
        branchId: newBranchId,
        leafPreview: `已按新的表述重新生成：${text.slice(0, 72)}`,
        entries: [
          ...prefix,
          { entryId: newEntryId, parentId, turnId: entry.turnId, type: "message", role: "user" as const, text, timestamp: new Date().toISOString() },
          {
            entryId: `e-regen-reply-${this.idCounter}`, parentId: newEntryId, turnId: entry.turnId,
            type: "message", role: "assistant" as const, text: `已按新的表述重新生成：${text.slice(0, 24)}`,
            timestamp: new Date().toISOString(),
          } as BranchEntry,
        ],
      });
    }
    state.currentIndex = this.allBranchIds(sessionId).indexOf(newBranchId);
    // 重生成走正常 turn 流（乐观条目 + markPromptSent + 完整事件序列），随后切到新分支
    this.emitBranchEvent(session, sessionId, "session.branches.changed", { reason: "regenerate" });
    this.runMockRegenerateTurn(session, sessionId, text, newBranchId);
    return Promise.resolve();
  }

  forkSession(sessionId: string, targetEntryId?: string): Promise<string> {
    const state = this.branchStateFor(sessionId);
    try {
      this.assertBranchIdle(sessionId, state);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const branch = this.branchDemoCurrent();
    if (branch.entries.length === 0) {
      return Promise.reject(new MockBranchError("INVALID_INPUT", "空会话无法 Fork"));
    }
    if (targetEntryId !== undefined && !branch.entries.some((item) => item.entryId === targetEntryId)) {
      return Promise.reject(new MockBranchError("NOT_FOUND", "引用的会话节点不存在，请刷新后重试"));
    }
    const cutIndex = targetEntryId !== undefined
      ? branch.entries.findIndex((item) => item.entryId === targetEntryId)
      : branch.entries.length - 1;
    const forkEntries = branch.entries.slice(0, cutIndex + 1);
    state.extra.push({
      branchId: `fork-${++this.idCounter}`,
      leafPreview: forkEntries[forkEntries.length - 1]?.text.slice(0, 80) ?? "",
      entries: forkEntries,
    });
    const newSessionId = `branch-fork-${++this.idCounter}`;
    // 与服务端一致：fork 建新会话（完整可交互，标题带 Fork 后缀），源会话流广播 branches.changed{fork}
    this.branchState.set(newSessionId, { currentIndex: this.allBranchIds(sessionId).length - 1, extra: [], busy: false });
    const forkSessionState = this.sessionFor(newSessionId);
    seedItems(forkSessionState.projector, projectBranchEntries(forkEntries, this.currentAgentName));
    const sourceThread = this.threads.find((thread) => thread.id === sessionId);
    this.threads.unshift({
      id: newSessionId,
      title: `${sourceThread?.title ?? "会话"}（Fork）`,
      preview: sourceThread?.preview ?? "Fork 会话",
      time: "刚刚",
      status: "active",
      agentId: sourceThread?.agentId ?? null,
    });
    this.emitBranchEvent(this.sessionFor(sessionId), sessionId, "session.branches.changed", { reason: "fork" });
    return Promise.resolve(newSessionId);
  }

  subscribeBranchState(sessionId: string, handler: (update: BranchStateUpdate | null) => void): () => void {
    const session = this.sessionFor(sessionId);
    session.branchHandlers.add(handler);
    return () => {
      session.branchHandlers.delete(handler);
    };
  }

  /** 演示/测试钩子：置真后下一次分支操作 409（对齐 SESSION_BUSY 冻结文案） */
  setBranchBusy(sessionId: string, busy: boolean): void {
    if (!this.isBranchScenario(sessionId)) return;
    this.branchStateFor(sessionId).busy = busy;
  }

  private assertBranchIdle(sessionId: string, state: MockBranchState): void {
    if (state.busy || this.sessionFor(sessionId).projector.streaming) {
      throw new MockBranchError("SESSION_BUSY", "会话正在运行，请先停止后再操作");
    }
  }

  private allBranchIds(sessionId: string): readonly string[] {
    return this.branchTreeOf(sessionId).branches.map((branch) => branch.branchId);
  }

  /** 分支操作后把 projector timeline 重同步为当前分支的受控条目 */
  private resyncBranchProjector(sessionId: string): void {
    if (!this.isBranchScenario(sessionId)) return;
    const session = this.sessionFor(sessionId);
    if (session.projector.streaming || session.projector.pendingPrompt) return;
    seedItems(session.projector, projectBranchEntries(this.branchEntriesOf(sessionId).entries, this.currentAgentName));
    this.notify(session);
  }

  /** 重生成的 turn 流：乐观用户条目 → markPromptSent → 完成/终态（与 sendPrompt 同语义） */
  private runMockRegenerateTurn(session: MockSession, sessionId: string, text: string, newBranchId: string): void {
    const projector = session.projector;
    applyLocalUserMessage(projector, text);
    this.notify(session);
    const streamId = `mock-stream-${session.streamSeq + 1}`;
    this.later(session, 150, () => {
      markPromptSent(projector, streamId);
      this.emit(session, "turn.started", { turnId: "mock-turn" }, streamId);
    });
    const reply = `已按新的表述重新生成：${text.slice(0, 24)}`;
    this.later(session, 500, () => {
      this.emit(session, "message.started", { role: "assistant" }, streamId);
    });
    this.later(session, 700, () => {
      this.emit(session, "message.completed", { role: "assistant", content: reply }, streamId);
    });
    this.later(session, 850, () => {
      this.emit(session, "turn.completed", { turnId: "mock-turn", usage: { input: 300, output: 160, cacheRead: 0, cacheWrite: 0, totalTokens: 460 } }, streamId);
      // turn 终态后切到新分支的受控条目视图（锚点恢复）
      seedItems(projector, projectBranchEntries(this.branchEntriesOf(sessionId, newBranchId).entries, this.currentAgentName));
      this.notify(session);
    });
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

  /* ---- A8：全局用量汇总（mock，固定 fixture + 真实过滤/聚合） ---- */

  getUsageSummary(filter?: UsageSummaryFilterView): Promise<UsageSummaryView> {
    const days = filter?.days ?? 30;
    const source = filter?.source ?? "";
    const role = filter?.role ?? "";
    const records = MOCK_USAGE_RECORDS.filter((record) => {
      if (record.daysAgo >= days) return false;
      if (source !== "" && record.source !== source) return false;
      if (role !== "" && record.role !== role) return false;
      return true;
    });
    return Promise.resolve(summarizeRecords(records, days));
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
