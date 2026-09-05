export type ThreadStatus = "active" | "waiting" | "quiet";
export type EventKind = "thinking" | "tool" | "file" | "plan" | "approval" | "subagent" | "memory" | "status";

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly color: string;
  readonly description: string;
  readonly workspace?: string;
}

export interface Thread {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  readonly time: string;
  readonly status: ThreadStatus;
  /** 所属助理 id（T9 会话中心 IA）；历史遗留会话可能为 null（不显示 badge） */
  readonly agentId: string | null;
  /** 归档时间（ISO 字符串）；存在且非空表示已归档 */
  readonly archivedAt?: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly type: "message";
  readonly role: "user" | "assistant";
  readonly author?: string;
  readonly body: string;
  readonly meta: string;
  readonly streaming?: boolean;
  /**
   * 波次 B3：稳定锚点（来自分支条目视图）。entryId 在 JSONL 中不可变，
   * timeline 定位/轮次导航跨刷新与重启存活；流式中的本地条目无锚点。
   */
  readonly entryId?: string;
  /** `turn-<userEntryId>`；user message 条目开启 turn，assistant 条目归属其 turn */
  readonly turnId?: string;
  /** 条目时间戳（ISO）；timeline 导航的相对时间来源 */
  readonly timestamp?: string;
}

export interface ToolCall {
  readonly name: string;
  readonly target: string;
  readonly status: "succeeded" | "running" | "failed";
  readonly duration?: string;
}

export interface FileChange {
  readonly path: string;
  readonly note: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface PlanStep {
  readonly label: string;
  readonly status: "done" | "active" | "queued";
}

export interface SubagentInfo {
  readonly name: string;
  readonly model: string;
  readonly status: "completed" | "running" | "waiting";
  readonly task: string;
  readonly result: string;
}

export interface ApprovalRequest {
  readonly action: string;
  readonly scope: string;
}

export interface ChatEvent {
  readonly id: string;
  readonly type: "event";
  readonly kind: EventKind;
  readonly title: string;
  readonly summary: string;
  readonly meta: string;
  readonly detail?: string;
  readonly tools?: readonly ToolCall[];
  readonly files?: readonly FileChange[];
  readonly plan?: readonly PlanStep[];
  readonly subagent?: SubagentInfo;
  readonly approval?: ApprovalRequest;
  readonly recalled?: readonly string[];
}

export type TimelineItem = ChatMessage | ChatEvent | CompactionItem;

/* ---------- 波次 B4：压缩卡（§3.2.4 冻结分态；live 事件与历史条目共用同一结构） ---------- */

export type CompactionStatus = "compacting" | "completed" | "aborted" | "failed";

/** 压缩卡 item：与通用状态行不同，携带 tokens / summary 正文 / 错误信息（正文不做客户端截断） */
export interface CompactionItem {
  readonly id: string;
  readonly type: "compaction";
  readonly status: CompactionStatus;
  /** 触发原因（服务端 payload.reason，如 manual / auto） */
  readonly reason: string;
  readonly tokensBefore?: number;
  /** 服务端估算值 → UI 必须标注「约」 */
  readonly tokensAfter?: number;
  /** 服务端已脱敏（≤500 字符）的压缩摘要正文；compacting/为空时缺省 */
  readonly summary?: string;
  /** 失败态错误行（服务端已脱敏） */
  readonly errorMessage?: string;
}

/* ---------- 波次 B5b：durable session todo（只读投影；写入方是 todo_write 工具） ---------- */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

/** todo.updated 事件负载条目 / SessionView.todos 条目（服务端 SessionTodoItemView 的 Wire 镜像） */
export interface SessionTodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
  readonly activeForm?: string;
}

export interface DockFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly diff: readonly string[];
}

/* ---------- 记忆（对齐 GET /api/agents/:id/memory/* 的真实响应形状） ---------- */

/** GET .../memory/compiled → { sections } —— 四段上下文制品 */
export interface MemoryCompiled {
  readonly today?: string;
  readonly week?: string;
  readonly longterm?: string;
  readonly facts?: string;
}

/** GET .../memory/facts —— 已审批事实 */
export interface MemoryFact {
  readonly id: string;
  readonly fact: string;
  readonly tags: readonly string[];
  readonly factTime: string;
  readonly confidence: number;
}

/** GET .../memory/events —— 事件时间线 */
export interface MemoryEventItem {
  readonly id: string;
  readonly date: string;
  readonly summary: string;
  readonly topics: readonly string[];
  readonly sessionId?: string;
  readonly messageCount?: number;
  readonly toolCalls?: number;
}

/** GET .../memory/pinned */
export interface PinnedMemory {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
}

/** GET .../memory/health */
export interface MemoryHealth {
  readonly latestRecallStatus: string;
  readonly latestRecallEpisodes: readonly { status: string; resultCount: number; layer: string }[];
  readonly pendingBatches: readonly { id: string }[];
}

/** SSE memory.agent.* → 后台整理状态（不进入主对话消息流） */
export type MaintenanceStatus = "queued" | "started" | "processing" | "completed" | "deferred" | "failed" | "cancelled";
export interface MemoryMaintenance {
  readonly status: MaintenanceStatus;
  readonly phase?: string;
  readonly runId?: string;
  readonly at: string;
}

/** GET .../memory/timeline —— 强度时间线（派生视图，不落库） */
export interface TimelineFact {
  readonly id: string;
  readonly fact: string;
  readonly retentionStrength: number;
  readonly activationStrength: number;
  readonly confidence: number;
  readonly status: string;
  readonly validUntil?: string;
  readonly hitDates: number;
}

export interface TimelineEventItem {
  readonly id: string;
  readonly summary: string;
  readonly date: string;
  readonly salience: number;
  readonly status: string;
}

/** 后台整理状态文案（与 web MemoryPage 一致） */
export function maintenanceLabel(status: MaintenanceStatus, phase?: string): string {
  switch (status) {
    case "queued": return "已排队";
    case "started": return "正在整理往事";
    case "processing": return phase === "策略审批" ? "正在合并相近记忆" : "正在核对记忆";
    case "completed": return "整理完成";
    case "deferred": return "整理延期";
    case "failed": return "整理失败";
    case "cancelled": return "已取消";
  }
}

/* ---------- 日志（对齐 /api/observability/* 的真实行形状） ---------- */

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "fatal";
export type AuditDecision = "allowed" | "denied" | "required";

/** 活动事件行（Activity channel） */
export interface ActivityLogRow {
  readonly id: number;
  readonly recordedAt: string;
  readonly eventName: string;
  readonly level: LogLevel;
  readonly status: string;
  readonly category: string;
  readonly producerComponent: string;
  readonly durationMs: number | null;
  readonly sessionId: string | null;
  readonly ownerAgentId: string | null;
  readonly traceId: string;
  readonly payloadPreview: string;
}

/** 错误分组（按 eventName + errorCode） */
export interface ErrorGroup {
  readonly eventName: string;
  readonly errorCode: string | null;
  readonly count: number;
  readonly lastRecordedAt: string;
}

/** 审计账本行（Audit channel，只读） */
export interface AuditLogRow {
  readonly id: number;
  readonly recordedAt: string;
  readonly eventName: string;
  readonly action: string;
  readonly decision: AuditDecision;
  readonly reasonCode: string | null;
  readonly actorKind: string;
  readonly actorId: string;
  readonly sessionId: string | null;
  readonly traceId: string;
  readonly ledgerEpoch: number;
}

/** GET /api/observability/health */
export interface LogsHealth {
  readonly logger: { readonly degraded: boolean; readonly dropped: number; readonly failed: number; readonly diskTotalMb: number };
  readonly spool: { readonly pendingSegments: number };
  readonly auditEpoch: number;
}

/** Activity 过滤维度（与 ActivityQuery 对齐） */
export const activityCategories = [
  "system", "supervisor", "storage", "agent", "session", "turn", "model", "provider",
  "tool", "sandbox", "memory", "api", "connection", "client", "plugin", "observability", "audit",
] as const;
export const activityLevels = ["error", "warn", "info", "debug", "trace", "fatal"] as const;
export const activityStatuses = [
  "started", "processing", "completed", "degraded", "failed", "cancelled",
  "denied", "deferred", "retrying", "skipped", "interrupted",
] as const;

/* ---------- 会话 mock ---------- */

/** 分支演示会话 id（mock-source 据此装载分支场景；桌面侧栏新增的演示会话行） */
export const BRANCH_DEMO_SESSION_ID = "branch-demo";

export const agents: readonly Agent[] = [
  { id: "yuan", name: "原", initial: "原", color: "#3aa96c", description: "在代码、记忆与长期计划之间保持连续性。", workspace: "D:\\PI-study\\opencolorful" },
  { id: "lin", name: "林间", initial: "林", color: "#5b8def", description: "负责研究、整理与把复杂问题讲清楚。", workspace: "D:\\PI-study\\references" },
  { id: "zi", name: "紫藤", initial: "紫", color: "#9a86e0", description: "偏向视觉、叙事与形态探索。" },
];

export const initialThreads: readonly Thread[] = [
  { id: "desktop", title: "极简桌面原型", preview: "事件层、工作台与亮暗主题", time: "刚刚", status: "active", agentId: "yuan" },
  { id: "memory", title: "记忆整理策略", preview: "本周摘要与三条待确认事实", time: "09:42", status: "waiting", agentId: "yuan" },
  { id: "plugin", title: "插件运行时复盘", preview: "权限快照与失败恢复的边界", time: "昨天", status: "quiet", agentId: "lin" },
  { id: "github", title: "GitHub 发布准备", preview: "README、仓库结构与安全清单", time: "周日", status: "quiet", agentId: "zi" },
  { id: "archived-demo", title: "已归档会话演示", preview: "用于验证归档区恢复", time: "08-15", status: "quiet", agentId: "lin", archivedAt: "2026-08-15T21:00:00+08:00" },
  { id: BRANCH_DEMO_SESSION_ID, title: "分支演示：重生成与 Fork", preview: "两分支 · 重生成 · 切换", time: "刚刚", status: "active", agentId: "yuan" },
];

export const initialTimeline: readonly TimelineItem[] = [
  {
    id: "m1", type: "message", role: "user",
    body: "把桌面原型改成极简风格：普通回复保持自然，思考、工具、文件和子任务是可检查的事件，亮暗两种主题。",
    meta: "今天 10:14",
  },
  {
    id: "m2", type: "message", role: "assistant", author: "原",
    body: "明白。对话是主叙事，执行过程是可检查的附着层。事件默认收起为单行摘要，需要时再展开。",
    meta: "DeepSeek V3.2 · 18 秒",
  },
  {
    id: "e1", type: "event", kind: "thinking", title: "思考", summary: "重新定义消息与执行层的边界", meta: "high · 2.8s",
    detail: "普通 text 保持连续可读；thinking、tool、file、approval、subagent、memory 作为独立事件呈现。事件摘要默认收起，用户需要检查时再打开，展开后是操作证据而不是另一段回复。",
  },
  {
    id: "e2", type: "event", kind: "tool", title: "工具调用", summary: "4 个工具已完成", meta: "4/4 成功 · 6.4s",
    tools: [
      { name: "read", target: "desktop/src/App.tsx", status: "succeeded", duration: "0.3s" },
      { name: "read", target: "src/contracts/events.ts", status: "succeeded", duration: "0.4s" },
      { name: "grep", target: "codex / history_cell", status: "succeeded", duration: "1.1s" },
      { name: "write", target: "desktop/src/styles.css", status: "succeeded", duration: "4.6s" },
    ],
  },
  {
    id: "e3", type: "event", kind: "file", title: "文件变更", summary: "2 个文件已修改", meta: "+42 −18 · 待审查",
    detail: "消息与执行事件分离，后端已有的运行字段映射到界面。",
    files: [
      { path: "desktop/src/App.tsx", note: "布局与状态装配", additions: 31, deletions: 14 },
      { path: "desktop/src/styles.css", note: "亮暗双主题令牌", additions: 11, deletions: 4 },
    ],
  },
  {
    id: "e4", type: "event", kind: "subagent", title: "Subagent", summary: "前端参考调研已完成", meta: "林间 · 1m 12s",
    subagent: {
      name: "林间 / ui-research", model: "DeepSeek V3.2", status: "completed",
      task: "核对 openhanako、deepseek-harness、codex 的消息与执行块渲染方式",
      result: "三家共同点：普通文本不折叠；执行块给出短摘要、状态与明确的展开入口；主题由一组语义 CSS 变量驱动。",
    },
  },
  {
    id: "e5", type: "event", kind: "plan", title: "工作计划", summary: "3/4 项已完成", meta: "当前任务 · 进行中",
    plan: [
      { label: "确认事件边界", status: "done" },
      { label: "重构会话时间线", status: "done" },
      { label: "接入亮暗双主题", status: "active" },
      { label: "接入 DesktopDataSource", status: "queued" },
    ],
  },
  {
    id: "e7", type: "event", kind: "memory", title: "记忆回想", summary: "命中 3 条相关记忆", meta: "search_memory · 0.4s",
    recalled: [
      "识见 · 桌面端事件层不与消息混排（2026-08-18）",
      "往事 · Phase 7 UI 重构确立了设计令牌体系（2026-07-25）",
      "今日记 · 用户确认初期以极简、功能展示优先（今天 09:51）",
    ],
  },
  {
    id: "m3", type: "message", role: "assistant", author: "原",
    body: "现在这条回复本身不需要展开。需要检查时，点开上面的思考、工具、文件或 Subagent 事件即可；右侧工作台只在你主动打开后出现。",
    meta: "刚刚",
  },
  {
    id: "e6", type: "event", kind: "approval", title: "需要确认", summary: "允许在工作区写入文件并继续执行", meta: "等待你的决定",
    detail: "当前会话 toolMode=all。写入文件或执行 bash 前需要确认工作区。",
    approval: { action: "工作区写入", scope: "D:\\PI-study\\opencolorful" },
  },
];

export const mockReplies: readonly string[] = [
  "收到。我会把执行细节留在事件层：思考、工具调用和文件变更都以摘要呈现，你可以随时展开检查，普通回复保持连续可读。",
  "好的，这一步我先读相关文件再动手。需要写入工作区时，我会在事件里请你确认；右侧工作台可以打开变更审查和终端。",
  "完成。本轮修改已经列入文件变更事件，diff 可以在右侧工作台逐个文件查看；如果有不满意的地方，直接指出，我会返工。",
];

/* ---------- 波次 B3：分支演示会话（Mock 分支场景脚本，与 B2 条目视图形状一致） ---------- */

/** 分支演示场景的单条目（对齐 GET /api/sessions/:id/entries 的 SessionEntryView） */
export interface BranchDemoEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly turnId: string | null;
  readonly type: string;
  readonly role?: "user" | "assistant" | "toolResult";
  readonly text: string;
  readonly timestamp: string;
}

/** 分支演示场景的分支记录（对齐 SessionBranchSummary；entries 为该分支根→叶路径） */
export interface BranchDemoBranch {
  readonly branchId: string;
  readonly leafPreview: string;
  readonly entries: readonly BranchDemoEntry[];
}

/**
 * 波次 B4：分支演示会话的压缩摘要 fixture（模拟服务端脱敏后的 ≤500 字符摘要）。
 * 同时用于历史 compaction 条目（e-c1）与 live compactSession 事件，保证 Mock 场景
 * 里「历史重放」与「live 压缩」的卡正文一致。
 */
export const BRANCH_DEMO_COMPACTION_SUMMARY =
  "会话此前围绕桌面端亮暗主题展开：确认了语义令牌方向——组件不引用具体色值，只引用 --bg/--text 等" +
  "语义层；暗色主题通过 data-theme 属性整体覆盖；事件层（思考/工具/文件/子任务）默认收起为单行摘要，" +
  "普通回复保持连续可读。用户接下来关心令牌的具体分层方式。";

/**
 * 脚本化分支树（两分支，用于 Mock 分支切换 / 重生成 / Fork 场景）：
 * root
 *   ├─ e-u1（用户 · turn-e-u1）→ e-a1（助手）→ e-c1（compaction）→ e-u2（用户 · 分支A继续 e-u2 → e-a2）   ← 分支A（默认当前）
 *   └─ e-u1b（用户 · turn-e-u1b）→ e-a1b（助手）                        ← 分支B（turn1 的重生成兄弟）
 * 波次 B4：分支 A 含一条 compaction 历史条目 → 投影为压缩卡（历史重放场景）。
 */
export const branchDemoBranches: readonly BranchDemoBranch[] = [
  {
    branchId: "e-a2",
    leafPreview: "令牌按「基础色板 → 语义令牌 → 组件别名」三层组织，组件只引用语义层。",
    entries: [
      { entryId: "e-u1", parentId: null, turnId: "turn-e-u1", type: "message", role: "user", text: "帮我梳理桌面端亮暗主题的实现要点。", timestamp: "2026-09-05T09:30:00+08:00" },
      { entryId: "e-a1", parentId: "e-u1", turnId: "turn-e-u1", type: "message", role: "assistant", text: "核心是语义令牌：组件不引用具体色值，只引用 --bg/--text 等语义层，暗色主题靠 data-theme 覆盖。", timestamp: "2026-09-05T09:30:20+08:00" },
      { entryId: "e-c1", parentId: "e-a1", turnId: null, type: "compaction", text: BRANCH_DEMO_COMPACTION_SUMMARY, timestamp: "2026-09-05T09:30:40+08:00" },
      { entryId: "e-u2", parentId: "e-a1", turnId: "turn-e-u2", type: "message", role: "user", text: "那令牌具体怎么分层？", timestamp: "2026-09-05T09:31:00+08:00" },
      { entryId: "e-a2", parentId: "e-u2", turnId: "turn-e-u2", type: "message", role: "assistant", text: "令牌按「基础色板 → 语义令牌 → 组件别名」三层组织，组件只引用语义层。", timestamp: "2026-09-05T09:31:25+08:00" },
    ],
  },
  {
    branchId: "e-a1b",
    leafPreview: "先用 data-theme 挂两套值，再把常用色收敛成语义令牌即可。",
    entries: [
      { entryId: "e-u1b", parentId: null, turnId: "turn-e-u1b", type: "message", role: "user", text: "给我一个更小的方案：亮暗主题最少要做哪些事？", timestamp: "2026-09-05T10:02:00+08:00" },
      { entryId: "e-a1b", parentId: "e-u1b", turnId: "turn-e-u1b", type: "message", role: "assistant", text: "先用 data-theme 挂两套值，再把常用色收敛成语义令牌即可。", timestamp: "2026-09-05T10:02:15+08:00" },
    ],
  },
];

export const dockFiles: readonly DockFile[] = [
  {
    path: "desktop/src/App.tsx", additions: 31, deletions: 14,
    diff: [
      "- 普通消息按长度截断",
      "+ 消息与执行事件分层渲染",
      "+ 事件默认收起，可展开检查",
      "+ 亮暗主题经 data-theme 切换",
    ],
  },
  {
    path: "desktop/src/styles.css", additions: 11, deletions: 4,
    diff: [
      "- :root 写死纸色水彩令牌",
      "+ :root 语义令牌 + [data-theme=dark] 覆盖",
      "+ 单色 accent + 灰阶文字层级",
    ],
  },
  {
    path: "desktop/src/mock-data.ts", additions: 9, deletions: 2,
    diff: [
      "+ 记忆回想事件 fixture",
      "+ 日志 / 记忆页 fixture",
    ],
  },
];

/* ---------- 记忆 mock（字段名与后端契约一致，适配层可平替） ---------- */

export const memoryHealth: MemoryHealth = {
  latestRecallStatus: "completed",
  latestRecallEpisodes: [{ status: "completed", resultCount: 3, layer: "摘要层" }],
  pendingBatches: [{ id: "sb-2026-08-19" }, { id: "sb-2026-08-20" }],
};

export const memoryMaintenance: MemoryMaintenance = {
  status: "processing",
  phase: "核对记忆",
  runId: "run-9f2c71ab",
  at: "2026-08-20T10:47:00+08:00",
};

export const memoryCompiled: MemoryCompiled = {
  today: "## 今天\n- 09:36 桌面原型评审：Window Desk 方向对初期过重，转极简。\n- 09:51 确认亮/暗双主题 + 功能展示优先。\n- 10:14 开始重构 desktop/src。",
  week: "## 本周\n- Phase 14 Subagent 两轮复审修复完成并合入 main。\n- 桌面端方向从 web 运维面转向 Electron 产品面。\n- 确定下一步：Cordis 插件化与前后端对接。",
  longterm: "## 长期\n- OpenColorful = 承载 agent 完整一生的本地优先平台基础设施。\n- 形态特化是完整交互基础设施，不是技能包。\n- 人格（yuan）是稳定锚点，成长发生在识见与手艺层。",
  facts: "## 重要事实\n- 事件层不与消息混排（2026-08-18 起有效）\n- 右侧工作台按需出现（2026-08-18 起有效）",
};

export const memoryPinned: readonly PinnedMemory[] = [
  { id: "pin-1", content: "初期桌面端以极简风格为主：聚焦交互与功能展示，不做花哨视觉。", createdAt: "2026-08-20T09:51:00+08:00" },
  { id: "pin-2", content: "人格是稳定锚点：成长发生在识见与手艺层面，yuan 不漂移。", createdAt: "2026-07-27T21:00:00+08:00" },
];

export const memoryFacts: readonly MemoryFact[] = [
  { id: "f-101", fact: "事件层不与消息混排：执行事件可折叠、有状态与摘要", tags: ["desktop", "ui"], factTime: "2026-08-18T15:00:00+08:00", confidence: 0.92 },
  { id: "f-88", fact: "形态特化是完整交互基础设施（专用 UI + 工具链 + 工作区），由插件提供", tags: ["positioning"], factTime: "2026-07-28T10:00:00+08:00", confidence: 0.97 },
  { id: "f-64", fact: "Phase 9 沙箱：应用层 PathGuard 四级 + 能力声明先行", tags: ["sandbox", "security"], factTime: "2026-07-30T16:00:00+08:00", confidence: 0.9 },
];

export const memoryTimelineFacts: readonly TimelineFact[] = [
  { id: "f-101", fact: "事件层不与消息混排", retentionStrength: 74, activationStrength: 88, confidence: 0.92, status: "中期", hitDates: 6 },
  { id: "f-88", fact: "形态特化 = 完整交互基础设施", retentionStrength: 91, activationStrength: 42, confidence: 0.97, status: "永久", validUntil: "2027-07-28T00:00:00+08:00", hitDates: 11 },
  { id: "f-64", fact: "PathGuard 四级 + 能力声明", retentionStrength: 58, activationStrength: 23, confidence: 0.9, status: "短期", hitDates: 3 },
];

export const memoryTimelineEvents: readonly TimelineEventItem[] = [
  { id: "ev-31", summary: "桌面原型极简重构", date: "2026-08-20T10:14:00+08:00", salience: 82, status: "active" },
  { id: "ev-27", summary: "Phase 14 Subagent 验收", date: "2026-08-08T18:30:00+08:00", salience: 76, status: "sealed" },
  { id: "ev-19", summary: "Phase 7 UI 重构", date: "2026-07-25T20:00:00+08:00", salience: 45, status: "sealed" },
];

export const memoryEvents: readonly MemoryEventItem[] = [
  { id: "ev-31", date: "2026-08-20T10:14:00+08:00", summary: "桌面原型极简重构", topics: ["desktop", "theme", "events"], sessionId: "desktop", messageCount: 12, toolCalls: 9 },
  { id: "ev-30", date: "2026-08-20T09:36:00+08:00", summary: "桌面原型评审：确认极简方向", topics: ["desktop", "review"], sessionId: "memory", messageCount: 6, toolCalls: 2 },
  { id: "ev-27", date: "2026-08-08T18:30:00+08:00", summary: "Phase 14 Subagent 验收通过", topics: ["subagent", "phase14"], sessionId: "plugin", messageCount: 34, toolCalls: 51 },
];

/* ---------- 日志 mock ---------- */

export const logsHealth: LogsHealth = {
  logger: { degraded: false, dropped: 0, failed: 1, diskTotalMb: 183 },
  spool: { pendingSegments: 2 },
  auditEpoch: 4,
};

export const activityLogs: readonly ActivityLogRow[] = [
  { id: 128, recordedAt: "2026-08-20T10:48:12+08:00", eventName: "session.prompt.accepted", level: "info", status: "completed", category: "session", producerComponent: "PromptService", durationMs: 34, sessionId: "desktop", ownerAgentId: "yuan", traceId: "tr-9f2c71ab", payloadPreview: "{ seq: 128, agent: yuan }" },
  { id: 127, recordedAt: "2026-08-20T10:47:58+08:00", eventName: "memory.recall.completed", level: "info", status: "completed", category: "memory", producerComponent: "RecallService", durationMs: 412, sessionId: "desktop", ownerAgentId: "yuan", traceId: "tr-9f2c71ab", payloadPreview: "{ hits: 3, layer: 摘要层 }" },
  { id: 126, recordedAt: "2026-08-20T10:47:31+08:00", eventName: "subagent.run.succeeded", level: "info", status: "completed", category: "agent", producerComponent: "SubagentRuntimeHost", durationMs: 72000, sessionId: "desktop", ownerAgentId: "yuan", traceId: "tr-51aa02", payloadPreview: "{ thread: ui-research, tokens: 8200 }" },
  { id: 125, recordedAt: "2026-08-20T10:46:02+08:00", eventName: "provider.request.retrying", level: "warn", status: "retrying", category: "provider", producerComponent: "ModelService", durationMs: null, sessionId: "desktop", ownerAgentId: "yuan", traceId: "tr-77bd10", payloadPreview: "{ provider: deepseek-local, timeout: 15000 }" },
  { id: 124, recordedAt: "2026-08-20T10:44:19+08:00", eventName: "plugin.skill.snapshot.frozen", level: "info", status: "completed", category: "plugin", producerComponent: "SkillSnapshotStore", durationMs: 18, sessionId: "desktop", ownerAgentId: "yuan", traceId: "tr-77bd10", payloadPreview: "{ entries: 6, turn: 41 }" },
  { id: 123, recordedAt: "2026-08-20T10:41:55+08:00", eventName: "tool.failed", level: "error", status: "failed", category: "tool", producerComponent: "ToolPolicy", durationMs: 96, sessionId: "desktop", ownerAgentId: "yuan", traceId: "tr-77bd10", payloadPreview: "{ tool: grep, errorCode: PATTERN_TOO_BROAD }" },
  { id: 122, recordedAt: "2026-08-20T10:40:03+08:00", eventName: "subagent.spawn.completed", level: "info", status: "completed", category: "agent", producerComponent: "SubagentTools", durationMs: 210, sessionId: "desktop", ownerAgentId: "yuan", traceId: "tr-51aa02", payloadPreview: "{ run: r9, audit: recorded }" },
  { id: 121, recordedAt: "2026-08-20T10:38:47+08:00", eventName: "connection.sse.attached", level: "info", status: "completed", category: "connection", producerComponent: "SseHub", durationMs: null, sessionId: null, ownerAgentId: null, traceId: "", payloadPreview: "{ resumedFrom: 121 }" },
  { id: 120, recordedAt: "2026-08-20T10:35:20+08:00", eventName: "memory.sealed_batch.pending", level: "warn", status: "deferred", category: "memory", producerComponent: "MemoryScheduler", durationMs: null, sessionId: null, ownerAgentId: "yuan", traceId: "", payloadPreview: "{ reason: waiting for idle window }" },
  { id: 119, recordedAt: "2026-08-20T10:31:02+08:00", eventName: "system.started", level: "info", status: "completed", category: "system", producerComponent: "ServerCompositionRoot", durationMs: 1250, sessionId: null, ownerAgentId: null, traceId: "", payloadPreview: "{ version: 0.1.0, port: 4310 }" },
];

export const errorGroups: readonly ErrorGroup[] = [
  { eventName: "tool.failed", errorCode: "PATTERN_TOO_BROAD", count: 3, lastRecordedAt: "2026-08-20T10:41:55+08:00" },
  { eventName: "provider.request.retrying", errorCode: "TIMEOUT", count: 2, lastRecordedAt: "2026-08-20T10:46:02+08:00" },
  { eventName: "session.restore.degraded", errorCode: "ORPHAN_RUN", count: 1, lastRecordedAt: "2026-08-19T22:14:40+08:00" },
];

export const auditLogs: readonly AuditLogRow[] = [
  { id: 45, recordedAt: "2026-08-20T10:48:10+08:00", eventName: "sandbox.write.granted", action: "sandbox.write", decision: "allowed", reasonCode: "workspace_confirmed", actorKind: "agent", actorId: "yuan", sessionId: "desktop", traceId: "tr-9f2c71ab", ledgerEpoch: 4 },
  { id: 44, recordedAt: "2026-08-20T10:40:03+08:00", eventName: "subagent.spawn.completed", action: "subagent.spawn", decision: "allowed", reasonCode: "capability_snapshot_ok", actorKind: "agent", actorId: "yuan", sessionId: "desktop", traceId: "tr-51aa02", ledgerEpoch: 4 },
  { id: 43, recordedAt: "2026-08-20T09:58:44+08:00", eventName: "skill.install.required", action: "skill.install", decision: "required", reasonCode: "risk_review", actorKind: "user", actorId: "local", sessionId: "memory", traceId: "tr-20cc8e", ledgerEpoch: 4 },
  { id: 42, recordedAt: "2026-08-20T09:12:07+08:00", eventName: "sandbox.path.denied", action: "sandbox.write", decision: "denied", reasonCode: "protected_path", actorKind: "agent", actorId: "lin", sessionId: "plugin", traceId: "tr-0f31d2", ledgerEpoch: 4 },
];
