/**
 * durable session todo 工具（波次 B5a，plans/p1-conversation-workbench §3.2.5）。
 *
 * 唯一工具 todo_write：会话级待办清单的整体替换写入（whole-list replacement）。
 * 执行链：参数校验 → SessionTodoStore.replace（单事务）→ 发布
 * `todo.updated {items}`（Replay Store 先写再广播）→ 返回结构化结果告知模型
 * 本次写入是否被接受（拒绝时给出中文原因）。
 *
 * 上下文注入模仿 memory-tools/skill-tools 的 global-Symbol state 模式：
 * - bootstrap 每 Runtime 装配时 registerTodoContext(sessionId, ctx)，onDispose
 *   注销（与记忆/Skill 上下文同一接线点，runtime-bootstrap.ts）；
 * - 生产执行按 sessionId 精确匹配并 fail-closed（未注册的会话调用直接拒绝，
 *   不静默 no-op）；
 * - publish 端口由组合根注入（replayStore.publish = Replay Store 先写、订阅者
 *   异步广播，与 MemoryRecallService 的 publish 端口同一条机制）。
 *
 * 工具经 PluginSessionTool（customTools 通道）注入 PI 工具注册表——与插件
 * 工具同一平台机制；todo 属于会话而非 Agent，因此无 Agent 绑定要求。
 */

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { Type } from "typebox";
import Value from "typebox/value";

import {
  type PlatformEventEnvelope,
  type SessionTodoItemView,
} from "../contracts/events.js";
import type { SessionTodoStore } from "../storage/session-todos.js";
import type { PluginSessionTool } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// TodoContext
// ═══════════════════════════════════════════════════════════════

export interface TodoContext {
  readonly sessionId: string;
  readonly store: SessionTodoStore;
  /**
   * 平台事件发布端口（组合根注入）：实现为 replayStore.publish——
   * Replay Store 先写、订阅者异步广播，write-before-broadcast 由
   * EventReplayStore.publish 的实现顺序保证。
   */
  readonly publish: (envelope: PlatformEventEnvelope) => void;
}

interface TodoContextState {
  readonly storage: AsyncLocalStorage<TodoContext>;
  readonly sessionContexts: Map<string, TodoContext>;
}

const STATE_KEY = Symbol.for("opencolorful.todo-context-state");
const globalState = globalThis as typeof globalThis & Record<symbol, unknown>;
let state = globalState[STATE_KEY] as TodoContextState | undefined;
if (!state) {
  state = {
    storage: new AsyncLocalStorage<TodoContext>(),
    sessionContexts: new Map<string, TodoContext>(),
  };
  globalState[STATE_KEY] = state;
}

const storage = state.storage;
const sessionContexts = state.sessionContexts;

/** 在直接调用/测试的异步上下文中注入 todo 上下文。 */
export function runWithTodoContext<T>(ctx: TodoContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * 将生产 Session 与其 todo 上下文绑定。清理函数只删除同一份上下文，
 * 避免旧 Runtime dispose 时误删已重建的新 Runtime。
 */
export function registerTodoContext(
  sessionId: string,
  ctx: TodoContext,
): () => void {
  sessionContexts.set(sessionId, ctx);
  return () => {
    if (sessionContexts.get(sessionId) === ctx) {
      sessionContexts.delete(sessionId);
    }
  };
}

/** 获取当前 todo 上下文（注册表按 sessionId 精确匹配，fail-closed）。 */
export function requireTodoContext(sessionId: string): TodoContext {
  const registered = sessionContexts.get(sessionId);
  if (!registered) {
    const fallback = storage.getStore();
    if (fallback && fallback.sessionId === sessionId) {
      return fallback;
    }
    throw new Error("待办工具上下文未就绪，工具调用被阻止");
  }
  return registered;
}

/** 测试/诊断用：只读访问 per-Session 上下文注册表（bootstrap 接线断言）。 */
export function todoSessionContexts(): ReadonlyMap<string, TodoContext> {
  return sessionContexts;
}

// ═══════════════════════════════════════════════════════════════
// todo.updated 事件发布（per-Session 稳定流，sequence 单调递增）
// ═══════════════════════════════════════════════════════════════

/**
 * todo.updated 走独立的会话级稳定流（`todo:<sessionId>`），不占用进行中
 * prompt 的 streamId 序列；序号由进程内共享分配器维护（对齐 memory agent
 * 流的 nextAgentStreamSequence 模式），保证 Last-Event-ID 续传与 Replay 语义。
 */
const TODO_STREAM_PREFIX = "todo:";
const todoStreamSequences = new Map<string, number>();

/** 取流内下一条单调递增序号（单线程内同步递增，天然无竞争）。 */
function nextTodoStreamSequence(streamId: string): number {
  const next = (todoStreamSequences.get(streamId) ?? 0) + 1;
  todoStreamSequences.set(streamId, next);
  return next;
}

/** 测试用：重置共享序号（用例隔离）。 */
export function resetTodoStreamSequences(): void {
  todoStreamSequences.clear();
}

/** 构造并发布 todo.updated {items}（Replay Store 先写再广播）。 */
function publishTodoUpdated(ctx: TodoContext, items: readonly SessionTodoItemView[]): void {
  const streamId = `${TODO_STREAM_PREFIX}${ctx.sessionId}`;
  const envelope: PlatformEventEnvelope = {
    protocolVersion: 1,
    eventId: crypto.randomUUID(),
    sessionId: ctx.sessionId,
    streamId,
    sequence: nextTodoStreamSequence(streamId),
    timestamp: new Date().toISOString(),
    type: "todo.updated",
    payload: { items: [...items] },
  };
  ctx.publish(envelope);
}

// ═══════════════════════════════════════════════════════════════
// 工具定义（PluginSessionTool / customTools 通道）
// ═══════════════════════════════════════════════════════════════

/** durable todo 工具名称（customTools 注册路径：平台 first-party 工具）。 */
export const TODO_TOOL_NAMES = ["todo_write"] as const;

/**
 * 工具参数 Schema：`{ todos: [{content, status, priority, activeForm?}] }`。
 * 注意：status/priority 刻意用宽松 string 而非枚举字面量——PI 在 invoke 之前
 * 会按工具 Schema 校验参数（validateToolArguments），枚举非法值将被 PI 以
 * 英文报错拦截，模型拿不到结构化拒绝。冻结语义的枚举权威是 SessionTodoStore
 * （触达 DB 之前校验，DB CHECK 兜底），拒绝原因以中文结构化结果回给模型。
 * todo.updated 事件负载契约（contracts/events.ts SessionTodoItemSchema）不受
 * 影响：事件只会在 store 校验通过后发布，负载恒为合法枚举。
 */
export const TodoWriteArgsSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String(),
      status: Type.String(),
      priority: Type.String(),
      activeForm: Type.Optional(Type.String()),
    }),
  ),
});

/** 工具描述契约断言用（tests 校验冻结语义引导齐全）。 */
export const TODO_WRITE_TOOL_DESCRIPTION =
  "维护本会话的持久待办清单（跨重启保留，用户界面可见）。每次调用都是【整体替换】：" +
  "传入完整的目标列表，未列出的既有条目会被删除；传入空数组即清空全部待办。" +
  "status 取值：pending（待开始）/ in_progress（进行中）/ completed（已完成）/ cancelled（已取消）；" +
  "priority 取值：high / medium / low。同一时刻至多保留一条 in_progress。" +
  "WHEN：开始多步工作前列出计划清单；每完成一步立即更新对应条目状态；" +
  "计划取消或全部完成时用空列表清空。activeForm 填进行中条目的现在进行时短语（如「正在重构存储层」）。" +
  "拒绝场景：状态/优先级取值非法、内容为空或超长、存储写入失败——结果会给出中文原因。";

/** 结构化失败结果（稳定 reasonCode，不走自由文本）。 */
function rejection(reasonCode: string, reason: string) {
  return {
    ok: true as const,
    result: {
      status: "rejected",
      reasonCode,
      reason,
    },
  };
}

/**
 * 构建会话级 todo_write 工具（customTools 通道注入 PI 工具注册表）。
 * invoke 按 sessionId 从注册表解析上下文并 fail-closed；工具不带 turnContext
 * 快照槽（非插件贡献，不参与插件冻结/委派）。
 */
export function buildTodoSessionTool(sessionId: string): PluginSessionTool {
  return {
    qualifiedName: "todo_write",
    pluginId: "platform.todo",
    name: "todo_write",
    description: TODO_WRITE_TOOL_DESCRIPTION,
    inputSchema: TodoWriteArgsSchema as unknown as Record<string, unknown>,
    invoke: async (params) => {
      let ctx;
      try {
        ctx = requireTodoContext(sessionId);
      } catch {
        return {
          ok: false as const,
          code: "todo_context_missing",
          message: "待办工具上下文未就绪，工具调用被阻止",
        };
      }
      if (!Value.Check(TodoWriteArgsSchema, params)) {
        return rejection(
          "invalid_args",
          "参数校验失败（todos 必须是列表，每条含 content/status/priority，activeForm 可选；status 取值 pending/in_progress/completed/cancelled，priority 取值 high/medium/low）",
        );
      }
      const raw = params as { todos: readonly SessionTodoItemView[] };
      try {
        const items = ctx.store.replace(ctx.sessionId, raw.todos);
        // Replay Store 先写再广播（publish 端口由组合根注入）
        publishTodoUpdated(ctx, items);
        return {
          ok: true as const,
          result: {
            status: "accepted",
            message:
              raw.todos.length === 0
                ? "待办清单已清空"
                : `待办清单已更新（共 ${items.length} 条）`,
            items,
          },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return rejection("store_failed", reason);
      }
    },
  };
}
