// Web 客户端类型，与服务端契约对齐

// --- Platform Event Envelope（src/contracts/events.ts）---
export interface PlatformEventEnvelope {
  readonly protocolVersion: 1;
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly streamId: string | null;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly payload: unknown;
}

// --- API Error（src/contracts/api-error.ts）---
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

// --- Provider ---
export interface ProviderModelCapabilities {
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ProviderModelSetting {
  readonly modelId: string;
  readonly name: string;
  readonly capabilities: ProviderModelCapabilities;
}

export interface ProviderView {
  readonly providerId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly models: ProviderModelSetting[];
  readonly credentialConfigured: boolean;
}

export interface ModelSummary {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly protocol: string;
  readonly baseUrl: string;
  readonly capabilities: ProviderModelCapabilities;
  readonly credentialConfigured: boolean;
}

// --- Session（与服务端 src/runtime/session-service.ts SessionView 对齐）---

export interface HistoryToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: "completed" | "error";
  readonly result?: string;
}

export interface MessageEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly HistoryToolCall[];
}

export interface SessionModelRef {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SessionView {
  readonly id: string;
  readonly title: string;
  readonly sessionPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly toolMode: string;
  readonly workspaceCwd: string | null;
  readonly workspaceConfirmed: boolean;
  readonly thinkingLevel: string;
  readonly messages: readonly string[];
  readonly messageEntries: readonly MessageEntry[];
  readonly model: SessionModelRef | null;
  readonly agentId: string | null;
}

export interface SessionSettings {
  readonly toolMode?: "off" | "read-only" | "all";
  readonly workspaceCwd?: string;
  readonly workspaceConfirmed?: boolean;
  readonly thinkingLevel?: string;
  readonly agentId?: string;
}

// --- Supervisor ---
export interface SupervisorStatusResponse {
  readonly status: string;
  readonly supervisor: {
    readonly pid: number;
    readonly port: number;
    readonly version: string;
    readonly uptimeSeconds: number;
  };
  readonly agentServer: {
    readonly status: string;
    readonly pid: number | null;
    readonly port: number | null;
    readonly version: string | null;
  };
}

export interface AgentServerDiscovery {
  readonly url: string;
  readonly port: number;
  readonly wsUrl: string;
}

// --- Prompt ---
export interface PromptResponse {
  readonly status: string;
  readonly sessionId: string;
  readonly streamId: string;
}

export interface AbortResponse {
  readonly status: string;
}

// --- Health ---
export interface HealthResponse {
  readonly status: string;
  readonly version: string;
  readonly pid: number;
  readonly uptimeSeconds: number;
}

// --- Preferences（src/contracts/preferences.ts）---
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ToolMode = "off" | "read-only" | "all";
export type ReducedMotion = "system" | "on" | "off";

export interface ModelReference {
  readonly providerId: string;
  readonly modelId: string;
}

export interface DefaultsPreferences {
  readonly model: ModelReference | null;
  readonly thinkingLevel: ThinkingLevel;
  readonly toolMode: ToolMode;
}

export interface LayoutPreferences {
  readonly leftSidebarWidth: number;
  readonly rightSidebarWidth: number;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
  readonly focusMode: boolean;
  readonly reducedMotion: ReducedMotion;
}

export interface AppearancePreferences {
  readonly theme: "dark" | "light";
  readonly showToolCalls: boolean;
  readonly showThinking: boolean;
  readonly timelineVisible?: boolean;
}

export interface PreferencesDocument {
  readonly version: 1;
  readonly defaults: DefaultsPreferences;
  readonly layout: LayoutPreferences;
  readonly appearance: AppearancePreferences;
}

// --- Supervisor logs 查询---
export interface LogQuery {
  readonly limit?: number;
  readonly since?: string | null;
  readonly level?: "all" | "info" | "warn" | "error";
  readonly query?: string;
}

export interface LogTail {
  readonly logs: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly status?: string;
}

// --- Token 用量（src/contracts/events.ts TokenUsageSchema / ContextUsageSchema）---
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export interface ContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

// GET /api/sessions/:id/usage 响应
export interface SessionUsageResponse {
  readonly sessionId: string;
  readonly totals: TokenUsage;
  readonly cacheHitRate: number | null;
  readonly turns: number;
  readonly context: ContextUsage | null;
}

// GET /api/usage/summary?days=N 响应
export interface UsageSummaryResponse {
  readonly days: number;
  readonly totals: TokenUsage;
  readonly cacheHitRate: number | null;
  readonly sessions: number;
  readonly turns: number;
  readonly byDay: readonly UsageSummaryByDay[];
  readonly byModel: readonly UsageSummaryByModel[];
}

export interface UsageSummaryByDay extends TokenUsage {
  readonly date: string;
}

export interface UsageSummaryByModel extends TokenUsage {
  readonly provider: string;
  readonly model: string;
}

// --- Agent ---
// 对齐 src/contracts/agent-identity.ts（version 2，废弃旧 type 枚举）
export interface AgentIdentity {
  readonly version: 2;
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

// Agent 底色（人格配置）。对齐 src/contracts/agent-identity.ts BaseColorSchema
export interface BaseColor {
  readonly version: 1;
  readonly persona: string;
  readonly personality: readonly string[];
  readonly replyStyle: string;
  readonly innerSetting: string;
  readonly updatedAt: string;
}

// Agent 运行设置。对齐 src/contracts/agent-settings.ts v2
export interface AgentSettings {
  readonly version: 2;
  readonly defaultCwd: string | null;
  readonly sandbox?: {
    readonly workspaceAccess: "rw";
    readonly extraReadPaths: readonly string[];
    readonly protectedPaths: readonly string[];
  };
  readonly updatedAt: string;
}

// 装饰色调色板，基于 Agent ID 稳定生成，不持久化
export type DecorColor = "blue" | "teal" | "coral" | "amber" | "purple" | "pink" | "green";

export interface AgentView {
  readonly identity: AgentIdentity;
  readonly baseColor: BaseColor;
  readonly settings: AgentSettings;
  readonly sessionCount: number;
  readonly decorColor: DecorColor;
}

// 底色模板。对齐 src/contracts/base-color-templates.ts
export interface BaseColorTemplate {
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

// --- Directory ---
// POST /api/directories/pick 响应。macOS/Linux 返回 501
export interface PickDirectoryResult {
  readonly path: string | null;
  readonly cancelled: boolean;
}

// --- Observability（Phase 11，对齐 src/observability/observability-query.ts）---

export interface ObservabilityDiskUsage {
  readonly totalBytes: number;
  readonly debugBytes: number;
  readonly mainBytes: number;
}

// GET /api/observability/health 响应（不可用时 503 {status:"unavailable"}）
export interface ObservabilityHealthResponse {
  readonly status: "ok" | "unavailable";
  readonly logger: {
    readonly dropped: number;
    readonly failed: number;
    readonly degraded: boolean;
    readonly disk: ObservabilityDiskUsage;
  };
  readonly spool: {
    readonly failedWrites: number;
    readonly pendingSegments: number;
    readonly totalBytes: number;
  };
  readonly auditEpoch: number;
  readonly recovery: {
    readonly lastInterrupted: number;
    readonly lastSpoolImported: number;
  };
}

export interface ActivityRow {
  readonly id: number;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly occurredAt: string;
  readonly eventName: string;
  readonly category: string;
  readonly level: string;
  readonly status: string | null;
  readonly significance: string | null;
  readonly actorKind: string;
  readonly actorId: string;
  readonly executorKind: string;
  readonly executorId: string;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly ownerAgentId: string | null;
  readonly sessionId: string | null;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly operationId: string | null;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly retryable: number;
  readonly producerComponent: string;
  readonly producerProcessType: string;
  readonly payloadJson: string;
}

// GET /api/observability/activity 查询过滤参数（全部可选，缺省不过滤）
export interface ActivityQuery {
  readonly from?: string;
  readonly to?: string;
  readonly ownerAgentId?: string;
  readonly sessionId?: string;
  readonly eventName?: string;
  readonly category?: string;
  readonly level?: string;
  readonly status?: string;
  readonly significance?: string;
  readonly component?: string;
  readonly errorCode?: string;
  readonly traceId?: string;
  readonly operationId?: string;
  readonly search?: string;
}

// GET /api/observability/audit 查询过滤参数
export interface AuditQuery {
  readonly epoch?: number;
  readonly action?: string;
  readonly decision?: string;
  readonly ownerAgentId?: string;
  readonly sessionId?: string;
  readonly traceId?: string;
}

// GET /api/observability/activity 响应
export interface ActivityPage {
  readonly items: readonly ActivityRow[];
  readonly nextCursor: string | null;
}

export interface AuditRow {
  readonly id: number;
  readonly eventId: string;
  readonly ledgerEpoch: number;
  readonly recordedAt: string;
  readonly action: string;
  readonly decision: string;
  readonly reasonCode: string | null;
  readonly actorKind: string;
  readonly actorId: string;
  readonly ownerAgentId: string | null;
  readonly sessionId: string | null;
  readonly traceId: string;
  readonly payloadJson: string;
}

// GET /api/observability/audit 响应
export interface AuditPage {
  readonly items: readonly AuditRow[];
  readonly nextCursor: string | null;
}

export interface ErrorGroup {
  readonly eventName: string;
  readonly errorCode: string | null;
  readonly count: number;
  readonly lastRecordedAt: string;
}

export interface DailyMetric {
  readonly date: string;
  readonly eventCount: number;
  readonly errorCount: number;
  readonly failedCount: number;
  readonly degradedCount: number;
  readonly byLevel: Record<string, number>;
}

export interface TraceSpan {
  readonly id: number;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly eventName: string;
  readonly status: string | null;
  readonly recordedAt: string;
  readonly durationMs: number | null;
  readonly operationId: string | null;
  readonly children: readonly TraceSpan[];
}

export interface LinkedGraphNode {
  readonly traceId: string;
  readonly relation: string;
  readonly direction: "forward" | "reverse";
}

export interface LinkedGraph {
  readonly rootTraceId: string;
  readonly nodes: readonly LinkedGraphNode[];
  readonly truncated: boolean;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

// GET /api/observability/traces/:traceId?linked=1 响应
export interface TraceResponse {
  readonly trace: {
    readonly root: TraceSpan | null;
    readonly total: number;
  };
  readonly linked?: LinkedGraph;
}

// GET /api/observability/diagnostic/tail 响应
export interface DiagnosticTail {
  readonly process: string;
  readonly file: string;
  readonly lines: number;
  readonly totalBytes: number;
  readonly tail: readonly string[];
}

// Phase 11 可观测性偏好（评审 P1-7）：GET/PUT /api/preferences/observability
export interface ObservabilityPreferences {
  readonly diagnosticLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly diagnosticRetentionDays: { readonly debug: number; readonly main: number };
  readonly diagnosticFileSizeBytes: number;
  readonly diagnosticDiskBudgetBytes: number;
  readonly activityRetentionDays: { readonly routine: number; readonly notable: number };
  readonly emergencySpoolBudgetBytes: number;
}
