import type { ChatEvent, ChatMessage, TimelineItem, ToolCall } from "../mock-data.js";

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

export interface ChatSnapshot {
  readonly items: readonly TimelineItem[];
  readonly streaming: boolean;
}

export interface ProjectorState {
  items: TimelineItem[];
  streaming: boolean;
  activeStreamId: string | null;
  pendingPrompt: boolean;
  readonly seenStreams: Set<string>;
  agentName: string;
}

export function createProjector(agentName: string): ProjectorState {
  return { items: [], streaming: false, activeStreamId: null, pendingPrompt: false, seenStreams: new Set(), agentName };
}

export function snapshotOf(state: ProjectorState): ChatSnapshot {
  return { items: state.items, streaming: state.streaming };
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

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function replaceItem(state: ProjectorState, id: string, next: TimelineItem) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) {
    state.items = [...state.items, next];
  } else {
    state.items = [...state.items.slice(0, index), next, ...state.items.slice(index + 1)];
  }
}

function lastMessage(state: ProjectorState): ChatMessage | undefined {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item?.type === "message") return item;
  }
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
  const existing = state.items.find((item) => item.id === id);
  const rows = existing?.type === "event" ? [...existing.tools ?? []] : [];
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
  state.items = [...state.items, { id: `local-user-${Date.now()}`, type: "message", role: "user", body: content, meta: "刚刚" }];
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

// eslint-disable-next-line complexity
export function applyEvent(state: ProjectorState, envelope: LiveEnvelope) {
  const type = envelope.type;
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
      state.items = [...state.items, {
        id: envelope.eventId, type: "message", role: "assistant",
        author: state.agentName, body: "", meta: "正在输入…", streaming: true,
      }];
      break;
    }
    case "message.delta": {
      const delta = asString(payload["delta"]);
      if (delta === "") return;
      const last = lastMessage(state);
      if (last !== undefined && last.role === "assistant" && last.streaming === true) {
        replaceItem(state, last.id, { ...last, body: last.body + delta });
      } else {
        state.items = [...state.items, {
          id: envelope.eventId, type: "message", role: "assistant",
          author: state.agentName, body: delta, meta: "正在输入…", streaming: true,
        }];
      }
      break;
    }
    case "message.completed": {
      const content = asString(payload["content"]);
      const last = lastMessage(state);
      if (last !== undefined && last.role === "assistant" && last.streaming === true) {
        replaceItem(state, last.id, { ...last, body: content !== "" ? content : last.body, streaming: false, meta: "刚刚" });
      } else if (content !== "") {
        state.items = [...state.items, {
          id: envelope.eventId, type: "message", role: "assistant",
          author: state.agentName, body: content, meta: "刚刚",
        }];
      }
      break;
    }
    case "thinking.delta": {
      const id = `thinking-${streamKey}`;
      const existing = state.items.find((item) => item.id === id);
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
      pushStatusEvent(state, `compact-${envelope.eventId}`, "上下文压缩", "正在压缩上下文…");
      break;
    }
    case "session.compacted": {
      const before = typeof payload["tokensBefore"] === "number" ? payload["tokensBefore"] : null;
      const after = typeof payload["tokensAfter"] === "number" ? payload["tokensAfter"] : null;
      const failed = payload["aborted"] === true || payload["errorMessage"] !== undefined;
      const summary = failed
        ? `压缩未完成：${asString(payload["errorMessage"]) || "已中止"}`
        : before !== null && after !== null ? `压缩完成 · ${before} → ${after} tokens` : "压缩完成";
      pushStatusEvent(state, `compact-${envelope.eventId}`, "上下文压缩", summary);
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
      const thinking = state.items.find((item) => item.id === thinkingId);
      if (thinking?.type === "event" && thinking.summary === "正在思考…") {
        replaceItem(state, thinkingId, { ...thinking, summary: "思考完成" });
      }
      break;
    }
    default:
      break;
  }
}
