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

/** renderer 只依赖这个接口；Mock 与 IPC 实现可互换（docs/design.md §7） */
export interface DesktopDataSource {
  readonly info: ConnectionInfo;
  /** 连接状态订阅（可选；注册即回调当前值。ipc 为探活驱动动态更新，mock 为静态一次性） */
  subscribeConnection?(handler: (info: ConnectionInfo) => void): () => void;

  /* Provider / 模型接入 */
  listProviders(): Promise<readonly ProviderView[]>;
  upsertProvider(provider: ProviderInput, apiKey?: string): Promise<void>;

  /* 会话 */
  listAgents(): Promise<readonly Agent[]>;
  listThreads(agentId: string): Promise<readonly Thread[]>;
  listArchivedThreads(agentId: string): Promise<readonly Thread[]>;
  createThread(agentId: string, title: string): Promise<Thread>;
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
