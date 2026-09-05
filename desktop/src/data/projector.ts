import type { ChatEvent, ChatMessage, CompactionItem, CompactionStatus, SessionTodoItem, TimelineItem, ToolCall } from "../mock-data.js";

/** 平台事件 Envelope 的 renderer 侧最小形状（payload 防御式解析） */
export interface LiveEnvelope {
  readonly eventId: string;
  readonly streamId: string | null;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: string;
  readonly payload: unknown;
}

/** GET /api/sessions/:id 的 messageEntries 条目形状（对齐 web HistoryMessageEntry） */
export interface HistoryEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly {
    toolCallId: string;
    toolName: string;
    status: "completed" | "error";
    result?: string;
  }[];
}

/**
 * 波次 B3：分支条目视图（对齐 GET /api/sessions/:id/entries 的 SessionEntryView）。
 * entryId 在 PI JSONL 中不可变 → 作为 timeline 稳定锚点（data-anchor / 轮次导航）。
 */
export interface BranchEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  /** `turn-<userEntryId>`；首个用户消息之前的条目为 null */
  readonly turnId: string | null;
  readonly type: string;
  readonly role?: "user" | "assistant" | "toolResult";
  readonly text: string;
  readonly timestamp: string;
  readonly toolCalls?: readonly {
    toolCallId: string;
    toolName: string;
    status: "completed" | "error";
    result?: string;
  }[];
}

export interface ChatSnapshot {
  readonly items: readonly TimelineItem[];
  readonly streaming: boolean;
  /** 波次 B5b：durable session todo 只读投影（空列表 = 无卡） */
  readonly todos: readonly SessionTodoItem[];
}

export interface ProjectorState {
  items: TimelineItem[];
  streaming: boolean;
  activeStreamId: string | null;
  pendingPrompt: boolean;
  readonly seenStreams: Set<string>;
  agentName: string;
  /** id → items 下标索引：replaceItem / 事件 upsert 定位 O(1)（替代 items.find 线性扫描） */
  readonly indexOf: Map<string, number>;
  /** 最后一条 message 型 item 的下标（-1 表示还没有）；事件追加不影响它 */
  lastMessageIndex: number;
  /** 波次 B5b：durable session todo 只读投影（todo.updated 整表替换；空列表=清空） */
  todos: readonly SessionTodoItem[];
  /** 波次 B4：进行中压缩卡的 item id（session.compacting → session.compacted 配对；无进行中压缩时为 null） */
  activeCompactionId: string | null;
  /** items 自上次快照后被原地改动；snapshotOf 时重建数组以获得新引用（不可变契约） */
  dirty: boolean;
}

export function createProjector(agentName: string): ProjectorState {
  return {
    items: [], streaming: false, activeStreamId: null, pendingPrompt: false,
    seenStreams: new Set(), agentName,
    indexOf: new Map(), lastMessageIndex: -1, todos: [], activeCompactionId: null, dirty: false,
  };
}

/**
 * 波次 B5b：todo 只读投影的种子（SessionView.todos，打开/重启恢复）与
 * todo.updated 整表替换共用入口；UI 永远不是写入方，这里只替代表达。
 */
export function applyTodoSnapshot(state: ProjectorState, todos: readonly SessionTodoItem[]): void {
  state.todos = todos;
}

export function snapshotOf(state: ProjectorState): ChatSnapshot {
  // 合批窗口内 applyEvent 只做 items 就地累积；快照（flush）时才重建数组：
  // React 依赖 items 引用变化触发重渲染，而数组拷贝从"每事件"降到"每 flush 一次"
  if (state.dirty) {
    state.items = [...state.items];
    state.dirty = false;
  }
  return { items: state.items, streaming: state.streaming, todos: state.todos };
}

/** 整表替换（历史投影 / 外部重建）：重建索引与末消息指针；数组已是新引用，不置 dirty */
export function seedItems(state: ProjectorState, items: TimelineItem[]): void {
  state.items = items;
  state.indexOf.clear();
  let lastMessageIndex = -1;
  items.forEach((item, index) => {
    state.indexOf.set(item.id, index);
    if (item.type === "message") lastMessageIndex = index;
  });
  state.lastMessageIndex = lastMessageIndex;
  // 整表替换意味着受控视图重建（历史/分支条目投影）：进行中的压缩卡不再存在
  state.activeCompactionId = null;
  state.dirty = false;
}

/** 历史重建：用户消息 →（思考）→（工具）→ 助手回答（语义对齐 web buildChatStateFromHistory） */
export function projectHistory(entries: readonly HistoryEntry[], agentName: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  entries.forEach((entry, index) => {
    if (entry.role === "user") {
      items.push({ id: `history-${index}`, type: "message", role: "user", body: entry.content, meta: "" });
      return;
    }
    if (entry.thinking) {
      items.push({
        id: `history-thinking-${index}`, type: "event", kind: "thinking",
        title: "思考", summary: "思考完成", meta: "", detail: entry.thinking,
      });
    }
    if (entry.toolCalls && entry.toolCalls.length > 0) {
      const tools: ToolCall[] = entry.toolCalls.map((call) => ({
        name: call.toolName,
        target: (call.result ?? "").slice(0, 120),
        status: call.status === "error" ? "failed" : "succeeded",
      }));
      items.push({
        id: `history-tools-${index}`, type: "event", kind: "tool",
        title: "工具调用", summary: `${tools.length} 个工具`, meta: "历史", tools,
      });
    }
    items.push({ id: `history-${index}`, type: "message", role: "assistant", author: agentName, body: entry.content, meta: "" });
  });
  return items;
}

/**
 * 波次 B3：分支条目 → timeline 投影（当前分支根→叶）。
 * 优先于 projectHistory：条目携带不可变 entryId/turnId/timestamp，
 * 消息行据此产出稳定锚点（timeline 导航跨刷新/重启存活）。
 * 波次 B4：compaction 条目投影为压缩卡（与 live 事件同一卡片结构），
 * 其余非 message 条目（label 等）仍渲染为状态事件行，不产生锚点。
 */
export function projectBranchEntries(entries: readonly BranchEntry[], agentName: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role === undefined || entry.role === "toolResult") {
      // compaction：历史重放卡片（id 与 live 卡同前缀；status=completed，tokens 不在条目视图中）
      if (entry.type === "compaction") {
        items.push({
          id: `compaction-${entry.entryId}`, type: "compaction", status: "completed",
          reason: "history", summary: entry.text,
        });
        continue;
      }
      // label / 其他受控条目：一行状态事件（无锚点语义）
      if (entry.type !== "message") {
        items.push({
          id: `entry-${entry.entryId}`, type: "event", kind: "status",
          title: "条目",
          summary: entry.text !== "" ? entry.text.slice(0, 80) : entry.type, meta: "历史",
        });
      }
      continue;
    }
    const meta = relativeEntryTime(entry.timestamp);
    if (entry.role === "user") {
      items.push({
        id: `entry-${entry.entryId}`, type: "message", role: "user",
        body: entry.text, meta, entryId: entry.entryId, timestamp: entry.timestamp,
        ...(entry.turnId !== null ? { turnId: entry.turnId } : {}),
      });
      continue;
    }
    if (entry.toolCalls && entry.toolCalls.length > 0) {
      const tools: ToolCall[] = entry.toolCalls.map((call) => ({
        name: call.toolName,
        target: (call.result ?? "").slice(0, 120),
        status: call.status === "error" ? "failed" : "succeeded",
      }));
      items.push({
        id: `entry-tools-${entry.entryId}`, type: "event", kind: "tool",
        title: "工具调用", summary: `${tools.length} 个工具`, meta: "历史", tools,
      });
    }
    items.push({
      id: `entry-${entry.entryId}`, type: "message", role: "assistant", author: agentName,
      body: entry.text, meta, entryId: entry.entryId, timestamp: entry.timestamp,
      ...(entry.turnId !== null ? { turnId: entry.turnId } : {}),
    });
  }
  return items;
}

/** 条目时间戳 → 相对时间文案（历史行 meta；解析失败回退空串） */
function relativeEntryTime(timestamp: string): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return "";
  const diffMin = Math.floor((Date.now() - then) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return `${Math.floor(diffDay / 30)} 个月前`;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 波次 B4：构造压缩卡 item（nullable/空串字段按 optional 语义缺省，
 * 满足 exactOptionalPropertyTypes）。live 事件与历史条目共用同一 item 形状。
 */
function compactionCard(
  id: string,
  status: CompactionStatus,
  fields: { reason: string; tokensBefore: number | null; tokensAfter: number | null; summary: string; errorMessage: string },
): CompactionItem {
  return {
    id,
    type: "compaction",
    status,
    reason: fields.reason,
    ...(fields.tokensBefore !== null ? { tokensBefore: fields.tokensBefore } : {}),
    ...(fields.tokensAfter !== null ? { tokensAfter: fields.tokensAfter } : {}),
    ...(fields.summary !== "" ? { summary: fields.summary } : {}),
    ...(fields.errorMessage !== "" ? { errorMessage: fields.errorMessage } : {}),
  };
}

/**
 * id → 下标定位。索引一致时 O(1) 命中；索引失效（如 mock 源直接覆写 items 数组、
 * 历史重建）时自愈：线性扫一次重建该条目并回填索引——只发生在失效瞬间，稳态热路径不扫描。
 */
function indexById(state: ProjectorState, id: string): number {
  const index = state.indexOf.get(id);
  if (index !== undefined && index < state.items.length && state.items[index]?.id === id) return index;
  const found = state.items.findIndex((item) => item.id === id);
  if (found !== -1) state.indexOf.set(id, found);
  return found;
}

/** 原地替换第 index 个条目：不重建数组（Items 不可变契约由 snapshotOf 每 flush 兑现） */
function setItemAt(state: ProjectorState, index: number, next: TimelineItem) {
  state.items[index] = next;
  if (next.type === "message") state.lastMessageIndex = Math.max(state.lastMessageIndex, index);
  state.dirty = true;
}

/** 追加条目：push 原地累积，同步索引与末消息指针 */
function appendItem(state: ProjectorState, item: TimelineItem) {
  const index = state.items.length;
  state.items.push(item);
  state.indexOf.set(item.id, index);
  if (item.type === "message") state.lastMessageIndex = index;
  state.dirty = true;
}

function replaceItem(state: ProjectorState, id: string, next: TimelineItem) {
  const index = indexById(state, id);
  if (index !== -1) {
    setItemAt(state, index, next);
  } else {
    appendItem(state, next);
  }
}

/** 最后一条 message 型条目：末消息指针 O(1)；指针失效（外部覆写）时自愈回填 */
function lastMessage(state: ProjectorState): ChatMessage | undefined {
  const index = state.lastMessageIndex;
  const item = index >= 0 && index < state.items.length ? state.items[index] : undefined;
  if (item !== undefined && item.type === "message") return item;
  for (let cursor = state.items.length - 1; cursor >= 0; cursor -= 1) {
    const candidate = state.items[cursor];
    if (candidate?.type === "message") {
      state.lastMessageIndex = cursor;
      return candidate;
    }
  }
  state.lastMessageIndex = -1;
  return undefined;
}

function pushStatusEvent(state: ProjectorState, id: string, title: string, summary: string) {
  replaceItem(state, id, { id, type: "event", kind: "status", title, summary, meta: "" });
}

function toolEventId(streamKey: string): string {
  return `tools-${streamKey}`;
}

function upsertToolEvent(state: ProjectorState, streamKey: string, mutate: (rows: ToolCall[]) => ToolCall[]) {
  const id = toolEventId(streamKey);
  const index = indexById(state, id);
  const existing = index !== -1 ? state.items[index] : undefined;
  const rows = existing?.type === "event" ? [...(existing.tools ?? [])] : [];
  const nextRows = mutate(rows);
  const done = nextRows.filter((row) => row.status !== "running").length;
  const running = nextRows.length - done;
  const summary = running > 0 ? `${done}/${nextRows.length} 个工具完成` : `${nextRows.length} 个工具已完成`;
  replaceItem(state, id, {
    id, type: "event", kind: "tool", title: "工具调用", summary,
    meta: running > 0 ? "运行中" : "完成", tools: nextRows,
  });
}

/** 发送前的本地乐观用户消息（服务器不回放用户消息事件） */
export function applyLocalUserMessage(state: ProjectorState, content: string) {
  state.pendingPrompt = true;
  state.streaming = true;
  appendItem(state, { id: `local-user-${Date.now()}`, type: "message", role: "user", body: content, meta: "刚刚" });
}

/** prompt 被服务端接受后登记 streamId（202 响应到达时） */
export function markPromptSent(state: ProjectorState, streamId: string) {
  state.pendingPrompt = false;
  state.activeStreamId = streamId;
  state.seenStreams.add(streamId);
}

/** prompt 失败：退出等待态并提示 */
export function markPromptFailed(state: ProjectorState, message: string) {
  state.pendingPrompt = false;
  state.streaming = false;
  pushStatusEvent(state, `error-${Date.now()}`, "发送失败", message);
}

/** 波次 B5b：todo.updated 条目的防御式解析（形状分歧按缺省兜底，不抛错） */
function parseTodoItem(value: unknown): SessionTodoItem {
  const row = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const status = row["status"] === "in_progress" || row["status"] === "completed" || row["status"] === "cancelled"
    ? row["status"]
    : "pending";
  const priority = row["priority"] === "high" || row["priority"] === "low" ? row["priority"] : "medium";
  return {
    content: asString(row["content"]),
    status,
    priority,
    ...(typeof row["activeForm"] === "string" && row["activeForm"] !== "" ? { activeForm: row["activeForm"] } : {}),
  };
}

// eslint-disable-next-line complexity
export function applyEvent(state: ProjectorState, envelope: LiveEnvelope) {
  const type = envelope.type;
  // 波次 B3：分支事件挂在独立 branch-<uuid> 流上（streamId 与 prompt 流无关、
  // 可能出现在任何时刻）。它们不投影为 items，只驱动 timeline/分支树重载，
  // 由数据源（ipc-source / mock-source）的 channel 逻辑消费；这里仅放行过滤，
  // 不落入下面的 prompt 流收养门（否则会被当成未知流丢弃或收养错流）。
  if (type === "session.branch.switched" || type === "session.branches.changed") {
    return;
  }
  // 波次 B5b：todo.updated 挂在稳定 todo:<sessionId> 流上，同样不进入 prompt 流
  // 收养门；整表替换只读投影（写入方是 todo_write 工具，UI 只消费）。
  if (type === "todo.updated") {
    const todoPayload = envelope.payload !== null && typeof envelope.payload === "object"
      ? envelope.payload as Record<string, unknown>
      : {};
    const rawItems = Array.isArray(todoPayload["items"]) ? todoPayload["items"] as unknown[] : [];
    applyTodoSnapshot(state, rawItems.map(parseTodoItem));
    return;
  }
  const isControl = type === "session.compacting" || type === "session.compacted";
  const streamId = envelope.streamId;

  if (!isControl && streamId !== null) {
    if (state.activeStreamId !== null && streamId !== state.activeStreamId) return;
    if (state.activeStreamId === null) {
      // 空闲时到达的旧 stream 事件是重放，丢弃；pending 期间的第一个新 stream 被收养
      if (!state.pendingPrompt || state.seenStreams.has(streamId)) return;
      state.activeStreamId = streamId;
    }
    state.seenStreams.add(streamId);
  }
  const streamKey = streamId ?? "";
  const payload = asRecord(envelope.payload);

  switch (type) {
    case "session.status": {
      state.streaming = payload["status"] === "running";
      break;
    }
    case "turn.started": {
      state.streaming = true;
      break;
    }
    case "message.started": {
      appendItem(state, {
        id: envelope.eventId, type: "message", role: "assistant",
        author: state.agentName, body: "", meta: "正在输入…", streaming: true,
      });
      break;
    }
    case "message.delta": {
      const delta = asString(payload["delta"]);
      if (delta === "") return;
      const last = lastMessage(state);
      if (last !== undefined && last.role === "assistant" && last.streaming === true) {
        replaceItem(state, last.id, { ...last, body: last.body + delta });
      } else {
        appendItem(state, {
          id: envelope.eventId, type: "message", role: "assistant",
          author: state.agentName, body: delta, meta: "正在输入…", streaming: true,
        });
      }
      break;
    }
    case "message.completed": {
      const content = asString(payload["content"]);
      const last = lastMessage(state);
      if (last !== undefined && last.role === "assistant" && last.streaming === true) {
        replaceItem(state, last.id, { ...last, body: content !== "" ? content : last.body, streaming: false, meta: "刚刚" });
      } else if (content !== "") {
        appendItem(state, {
          id: envelope.eventId, type: "message", role: "assistant",
          author: state.agentName, body: content, meta: "刚刚",
        });
      }
      break;
    }
    case "thinking.delta": {
      const id = `thinking-${streamKey}`;
      const index = indexById(state, id);
      const existing = index !== -1 ? state.items[index] : undefined;
      const detail = (existing?.type === "event" ? existing.detail ?? "" : "") + asString(payload["delta"]);
      replaceItem(state, id, {
        id, type: "event", kind: "thinking", title: "思考",
        summary: state.streaming ? "正在思考…" : "思考完成", meta: "", detail,
      });
      break;
    }
    case "tool.started": {
      const toolCallId = asString(payload["toolCallId"]);
      upsertToolEvent(state, streamKey, (rows) => [
        ...rows.filter((row) => row.target !== `__${toolCallId}`),
        { name: asString(payload["toolName"]), target: "", status: "running" },
      ]);
      break;
    }
    case "tool.delta": {
      // delta 是工具输入的增量文本；按顺序拼到最后一个 running 行上（近似展示）
      upsertToolEvent(state, streamKey, (rows) => {
        let index = -1;
        for (let cursor = rows.length - 1; cursor >= 0; cursor -= 1) {
          if (rows[cursor]?.status === "running") {
            index = cursor;
            break;
          }
        }
        if (index === -1) return rows;
        const row = rows[index];
        if (row === undefined) return rows;
        const target = (row.target + asString(payload["delta"])).slice(0, 160);
        return [...rows.slice(0, index), { ...row, target }, ...rows.slice(index + 1)];
      });
      break;
    }
    case "tool.completed": {
      const failed = payload["isError"] === true;
      upsertToolEvent(state, streamKey, (rows) => {
        const index = rows.findIndex((row) => row.status === "running");
        if (index === -1) return rows;
        const row = rows[index];
        if (row === undefined) return rows;
        const result = typeof payload["result"] === "string" ? payload["result"].slice(0, 120) : row.target;
        return [...rows.slice(0, index), { ...row, status: failed ? "failed" : "succeeded", target: row.target !== "" ? row.target : result }, ...rows.slice(index + 1)];
      });
      break;
    }
    case "plan.updated": {
      const items = Array.isArray(payload["items"]) ? payload["items"].filter((item): item is string => typeof item === "string") : [];
      const id = `plan-${streamKey}`;
      replaceItem(state, id, {
        id, type: "event", kind: "plan", title: "工作计划",
        summary: `${items.length} 项`, meta: "",
        plan: items.map((label) => ({ label, status: "queued" as const })),
      });
      break;
    }
    case "memory.recall.started":
    case "memory.recall.completed":
    case "memory.recall.empty":
    case "memory.recall.failed":
    case "memory.recall.cancelled": {
      const recallId = asString(payload["recallId"]);
      const id = `recall-${recallId !== "" ? recallId : streamKey}`;
      const resultCount = typeof payload["resultCount"] === "number" ? payload["resultCount"] : 0;
      const layer = asString(payload["layer"]);
      const summary = type === "memory.recall.started" ? "正在回想…"
        : type === "memory.recall.completed" ? `命中 ${resultCount} 条相关记忆`
        : type === "memory.recall.empty" ? "未命中相关记忆"
        : type === "memory.recall.failed" ? "回想失败" : "回想已取消";
      replaceItem(state, id, {
        id, type: "event", kind: "memory", title: "记忆回想", summary,
        meta: layer !== "" ? `search_memory · ${layer}` : "search_memory",
      });
      break;
    }
    case "sandbox.denied":
    case "sandbox.preflight-denied": {
      pushStatusEvent(state, `sandbox-${envelope.eventId}`, "沙箱拒绝", asString(payload["reason"]) || "操作被沙箱策略拒绝");
      break;
    }
    case "session.compacting": {
      // 波次 B4：压缩开始 → 插入进行中压缩卡（无正文；id 记入 activeCompactionId 与 compacted 配对）
      const id = `compaction-${envelope.eventId}`;
      state.activeCompactionId = id;
      replaceItem(state, id, {
        id, type: "compaction", status: "compacting",
        reason: asString(payload["reason"]),
      });
      break;
    }
    case "session.compacted": {
      const aborted = payload["aborted"] === true;
      const errorMessage = asString(payload["errorMessage"]);
      const summary = asString(payload["summary"]);
      const reason = asString(payload["reason"]);
      // 分态优先级：有错误信息 → failed；已中止（无错误）→ aborted；否则 completed
      const status: CompactionStatus = errorMessage !== ""
        ? "failed"
        : aborted ? "aborted" : "completed";
      const item = compactionCard(
        state.activeCompactionId ?? `compaction-${envelope.eventId}`,
        status,
        {
          reason,
          tokensBefore: typeof payload["tokensBefore"] === "number" ? payload["tokensBefore"] : null,
          // 服务端 estimatedTokensAfter（估算值）→ UI 标注「约」
          tokensAfter: typeof payload["tokensAfter"] === "number" ? payload["tokensAfter"] : null,
          summary,
          errorMessage,
        },
      );
      state.activeCompactionId = null;
      replaceItem(state, item.id, item);
      break;
    }
    case "error": {
      pushStatusEvent(state, `error-${envelope.eventId}`, "运行错误", asString(payload["message"]) || "未知错误");
      state.streaming = false;
      break;
    }
    case "turn.completed": {
      state.streaming = false;
      const usage = asRecord(payload["usage"]);
      const totalTokens = typeof usage["totalTokens"] === "number" ? usage["totalTokens"] : null;
      const last = lastMessage(state);
      if (last !== undefined && last.role === "assistant") {
        replaceItem(state, last.id, {
          ...last,
          streaming: false,
          meta: totalTokens !== null ? `${totalTokens} tokens` : last.meta === "正在输入…" ? "刚刚" : last.meta,
        });
      }
      const thinkingId = `thinking-${streamKey}`;
      const thinkingIndex = indexById(state, thinkingId);
      const thinking = thinkingIndex !== -1 ? state.items[thinkingIndex] : undefined;
      if (thinking?.type === "event" && thinking.summary === "正在思考…") {
        replaceItem(state, thinkingId, { ...thinking, summary: "思考完成" });
      }
      break;
    }
    case "turn.failed":
    case "turn.cancelled":
    case "turn.interrupted": {
      // Abort/失败终态：与 turn.completed 同样收尾，否则 UI 永远停在流式态
      // （2026-09-01 真链实测：模型 401 与用户停止后发送按钮都卡死）
      state.streaming = false;
      const failed = type === "turn.failed";
      const last = lastMessage(state);
      if (last !== undefined && last.role === "assistant") {
        replaceItem(state, last.id, {
          ...last,
          streaming: false,
          meta: failed ? "生成失败" : "已停止",
        });
      }
      const abortedThinkingId = `thinking-${streamKey}`;
      const abortedThinkingIndex = indexById(state, abortedThinkingId);
      const abortedThinking = abortedThinkingIndex !== -1 ? state.items[abortedThinkingIndex] : undefined;
      if (abortedThinking?.type === "event" && abortedThinking.summary === "正在思考…") {
        replaceItem(state, abortedThinkingId, { ...abortedThinking, summary: failed ? "思考中断" : "思考完成" });
      }
      if (failed) {
        const detail = asString(payload["errorMessage"]) || asString(payload["message"]) || asString(payload["reason"]);
        pushStatusEvent(state, `error-${envelope.eventId}`, "运行错误", detail === "" ? "本轮生成失败，请重试" : detail);
      }
      break;
    }
    default:
      break;
  }
}
