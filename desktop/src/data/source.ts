import type {
  ActivityLogRow,
  Agent,
  AuditLogRow,
  ErrorGroup,
  LogsHealth,
  MemoryCompiled,
  MemoryEventItem,
  MemoryFact,
  MemoryHealth,
  MemoryMaintenance,
  PinnedMemory,
  Thread,
  TimelineEventItem,
  TimelineFact,
} from "../mock-data.js";
import type { ChatSnapshot } from "./projector.js";

/** T5：助理档案页聚合视图 */
export interface AgentProfileView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string | null;
  readonly persona: string;
  readonly personality: readonly string[];
  readonly replyStyle: string;
  readonly workspace: string | null;
  readonly sessionCount: number;
  readonly decorColor: string;
}

/** T9：底色编辑补丁（对齐 PUT /api/agents/:id/base-color 的可写字段） */
export interface AgentBaseColorPatch {
  readonly persona?: string;
  readonly personality?: readonly string[];
  readonly replyStyle?: string;
  readonly innerSetting?: string;
}

/** T5：记忆设置入口只暴露最常用的字段（完整对象在 IPC 实现中与远端合并） */
export interface MemoryAgentSettingsView {
  readonly enabled: boolean;
  readonly dailyRunTime: string;
  readonly minIdleMinutes: number;
  readonly injectBudgetChars: number;
}

export interface ConnectionInfo {
  readonly mode: "ipc" | "mock";
  readonly connected: boolean;
  readonly label: string;
}

export interface MemoryPageData {
  readonly compiled: MemoryCompiled;
  readonly facts: readonly MemoryFact[];
  readonly events: readonly MemoryEventItem[];
  readonly pinned: readonly PinnedMemory[];
  readonly health: MemoryHealth;
  readonly timelineFacts: readonly TimelineFact[];
  readonly timelineEvents: readonly TimelineEventItem[];
  readonly maintenance: MemoryMaintenance | null;
}

export interface LogsPageData {
  readonly health: LogsHealth | null;
  readonly activity: readonly ActivityLogRow[];
  readonly audit: readonly AuditLogRow[];
  readonly errors: readonly ErrorGroup[];
}

/* ---- 会话设置 / 模型 / 用量 ---- */

export interface ModelOption {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly credentialConfigured: boolean;
}

export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SessionSettingsView {
  readonly toolMode: string;
  readonly thinkingLevel: string;
  readonly workspaceCwd: string | null;
  readonly workspaceConfirmed: boolean;
  readonly model: ModelRef | null;
}

export interface SessionUsageView {
  readonly totalTokens: number;
  readonly turns: number;
  readonly contextTokens: number | null;
  readonly contextWindow: number;
  readonly contextPercent: number | null;
}

/** 全局偏好（对齐 GET /api/settings/preferences 的 defaults 段） */
export interface PreferencesView {
  readonly defaults: {
    readonly model: ModelRef | null;
    readonly toolMode: string;
    readonly thinkingLevel: string;
  };
}

/** T1：onboarding 底色模板（对齐 GET /api/agents/templates → contracts/base-color-templates.ts） */
export interface AgentTemplateView {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly color: string;
  readonly baseColor: {
    readonly persona: string;
    readonly personality: readonly string[];
    readonly replyStyle: string;
    readonly innerSetting: string;
  };
}

/** T1：onboarding 创建助理输入（对齐 POST /api/agents；不带 id，由服务端生成） */
export interface CreateAgentInput {
  readonly name: string;
  readonly baseColor: AgentTemplateView["baseColor"];
  readonly defaultCwd?: string | null;
}

/* ---- 日志服务端查询 ---- */

export interface ActivityFilter {
  readonly category?: string;
  readonly level?: string;
  readonly status?: string;
  readonly search?: string;
  readonly ownerAgentId?: string;
  readonly sessionId?: string;
}

export interface ActivityPageResult {
  readonly rows: readonly ActivityLogRow[];
  readonly nextCursor: string | null;
}

/* ---- Subagent 只读投影 ---- */

export interface SubagentThreadCard {
  readonly threadId: string;
  readonly createdAt: string;
  readonly title: string;
  readonly status: string;
  readonly model: string;
  readonly latestRunStatus: string | null;
  readonly resultSummary: string | null;
  readonly artifactCount: number;
}

export interface SubagentMessageView {
  readonly id: string;
  readonly runId: string;
  readonly type: string;
  readonly sender: string;
  readonly text: string;
  readonly deliveryStatus: string;
  readonly createdAt: string;
}

export interface SubagentArtifactView {
  readonly artifactId: string;
  readonly name: string;
  readonly kind: string;
  readonly sizeBytes: number | null;
}

export interface SubagentTranscriptView {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly model: string;
  readonly taskObjective: string | null;
  readonly runs: readonly {
    readonly runId: string;
    readonly status: string;
    readonly toolCallCount: number;
    readonly totalTokens: number;
    readonly resultSummary: string | null;
  }[];
  readonly messages: readonly SubagentMessageView[];
  readonly artifacts: readonly SubagentArtifactView[];
}

/* ---- Provider 管理（模型接入） ---- */

export interface ProviderModelView {
  readonly modelId: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ProviderView {
  readonly providerId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly models: readonly ProviderModelView[];
  readonly credentialConfigured: boolean;
}

export interface ProviderInput {
  readonly providerId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly models: readonly {
    readonly modelId: string;
    readonly name: string;
    readonly capabilities: {
      readonly reasoning: boolean;
      readonly input: readonly ["text"];
      readonly contextWindow: number;
      readonly maxTokens: number;
    };
  }[];
}

/** T3：高级新建会话可覆盖的运行选项 */
export interface CreateThreadOptions {
  /** 覆盖 Agent 默认工作目录；缺省沿用 Agent defaultCwd */
  readonly cwd?: string;
  /** 工具模式；缺省由服务端偏好决定 */
  readonly toolMode?: string;
  /** 思考级别；缺省由服务端偏好决定 */
  readonly thinkingLevel?: string;
  /**
   * 工作区确认（仅 toolMode=all 时有意义）：必须如实转发用户在表单里的勾选状态。
   * 缺省/未确认时服务端按 fail-safe 降级只读并走横幅确认流程（安全语义，不许自动置真）。
   */
  readonly workspaceConfirmed?: boolean;
}

/** renderer 只依赖这个接口；Mock 与 IPC 实现可互换（docs/design.md §7） */
export interface DesktopDataSource {
  readonly info: ConnectionInfo;
  /** 连接状态订阅（可选；注册即回调当前值。ipc 为探活驱动动态更新，mock 为静态一次性） */
  subscribeConnection?(handler: (info: ConnectionInfo) => void): () => void;

  /* Provider / 模型接入 */
  listProviders(): Promise<readonly ProviderView[]>;
  upsertProvider(provider: ProviderInput, apiKey?: string): Promise<void>;

  /* 会话（T9 起列表跨助理返回，每行 Thread 自带 agentId；是否展示归属 badge 由 UI 按助理数量决定） */
  listAgents(): Promise<readonly Agent[]>;
  listThreads(): Promise<readonly Thread[]>;
  listArchivedThreads(): Promise<readonly Thread[]>;
  createThread(agentId: string, title: string, options?: CreateThreadOptions): Promise<Thread>;
  updateThreadTitle(sessionId: string, title: string): Promise<void>;
  unarchiveThread(sessionId: string): Promise<void>;
  compactSession(sessionId: string): Promise<void>;
  sendPrompt(sessionId: string, content: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  subscribeChat(sessionId: string, handler: (snapshot: ChatSnapshot) => void): () => void;

  /* 会话设置 / 模型 / 用量 */
  listModels(): Promise<readonly ModelOption[]>;
  /** 全局偏好（IPC 实现由主会话按 GET /api/settings/preferences 补齐；缺失时桌面端退回兜底默认） */
  getPreferences?(): Promise<PreferencesView>;
  getSessionSettings(sessionId: string): Promise<SessionSettingsView>;
  updateSessionModel(sessionId: string, model: ModelRef): Promise<void>;
  updateSessionSettings(sessionId: string, patch: {
    readonly toolMode?: string;
    readonly thinkingLevel?: string;
    readonly workspaceConfirmed?: boolean;
  }): Promise<void>;
  getSessionUsage(sessionId: string): Promise<SessionUsageView>;

  /* 记忆 */
  getMemoryData(agentId: string, query?: string): Promise<MemoryPageData>;
  subscribeMemoryMaintenance(agentId: string, handler: (maintenance: MemoryMaintenance) => void): () => void;
  deepDiveMemory(agentId: string): Promise<void>;
  getMemoryRunReport(agentId: string, runId: string): Promise<string>;

  /* T5：助理档案与记忆日用写操作 */
  getAgentProfile(agentId: string): Promise<AgentProfileView>;
  updateAgentProfile(agentId: string, patch: { readonly name?: string; readonly description?: string }): Promise<void>;
  /** T9：底色（人设）编辑 → PUT /api/agents/:id/base-color */
  updateAgentBaseColor(agentId: string, patch: AgentBaseColorPatch): Promise<void>;
  getMemorySettings(agentId: string): Promise<MemoryAgentSettingsView>;
  updateMemorySettings(agentId: string, patch: Partial<MemoryAgentSettingsView>): Promise<void>;
  addPinnedMemory(agentId: string, content: string): Promise<PinnedMemory>;
  removePinnedMemory(agentId: string, pinnedId: string): Promise<void>;

  /* T1：onboarding 创建助理 */
  listAgentTemplates(): Promise<readonly AgentTemplateView[]>;
  createAgent(input: CreateAgentInput): Promise<Agent>;

  /* 日志 */
  getLogsData(): Promise<LogsPageData>;
  queryActivity(filter: ActivityFilter, cursor?: string | null, limit?: number): Promise<ActivityPageResult>;
  subscribeActivityStream(handler: (row: ActivityLogRow) => void): () => void;

  /* Subagent 只读 */
  listSubagentThreads(agentId: string, sessionId: string): Promise<readonly SubagentThreadCard[]>;
  getSubagentTranscript(agentId: string, sessionId: string, threadId: string): Promise<SubagentTranscriptView>;

  /** 仅 mock 使用：跟随 UI 选中的 Agent 名（真实数据源从会话归属推导） */
  setActiveAgentName?(name: string): void;
}

export async function createDataSource(): Promise<DesktopDataSource> {
  if (window.desktopApi !== undefined) {
    try {
      const { IpcDataSource } = await import("./ipc-source.js");
      const probe = await IpcDataSource.probe();
      if (probe !== null) return probe;
    } catch {
      // 桥存在但服务不可达 → 回退 mock
    }
  }
  const { MockDataSource } = await import("./mock-source.js");
  return new MockDataSource();
}
