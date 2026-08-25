import fs from "node:fs";

import type { ParentMailboxId, ParentMailboxNotificationKind, SubagentRunId, SubagentThreadId } from "../../../contracts/subagents.js";
import { ParentMailboxStore, type ParentMailboxCursor, type ParentMailboxRecord } from "../stores/parent-mailbox-store.js";
import type { SubagentMessageRecord } from "../stores/message-store.js";
import { MessageStore } from "../stores/message-store.js";
import { RunStore } from "../stores/run-store.js";
import { ThreadStore } from "../stores/thread-store.js";
import type { SubagentTransactions } from "../stores/subagent-transactions.js";
import type { SubagentOwnership } from "../stores/types.js";
import type { ParentContinuationOutcome, ParentSessionPort } from "./parent-session-port.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：ParentMailboxDeliveryCoordinator（plans/phase-14.md §14）
//
// parent_mailbox 通知的分发器：
// - signal()：新 mailbox 行写入后触发（T6 接线 host.onTerminal /
//   onMessage(input_required)）；按 ownerAgentId+parentSessionId 聚合；
// - 幂等消费：queued → delivering（attempt++）→ delivered / suppressed /
//   failed；同一 Mailbox 项只触发一次父 Turn（§14.1 / §14.3）；
// - 投递策略（§14.2）：父 idle 且可运行 → 一次 continuation（多通知聚合）；
//   父 busy → 排队到下一个安全输入边界（Turn 结束 / retry 定时器）；
//   父 archived/deleted → suppress + 联动（取消活动 Run、closeThread、
//   删除 Thread 目录）；started 等非触发行立即结算为 delivered；
// - pending 重试：指数退避、上限 5 分钟（§14.3）；启动恢复 retryPending；
// - 触发失败/被打断终态语义（§T5 交付 2）：rejected（未触发）→ failed +
//   退避重试；interrupted（已触发）→ delivered（不重复触发）；
// - cursor/wait 查询（父侧轮询/等待新通知）：listForSession /
//   waitForNotifications（wait 订阅 signal 事件 + 超时 + abort）；
// - 父 Session archive/delete 联动（§14.4 / §16.3）：取消活动 Run → 关闭
//   Thread（同事务 suppress mailbox）→ 删除 Thread 目录（delete 模式）。
// ═══════════════════════════════════════════════════════════════

export interface ParentMailboxDeliveryCoordinatorDeps {
  readonly mailboxStore: ParentMailboxStore;
  readonly messageStore: MessageStore;
  readonly runStore: RunStore;
  readonly threadStore: ThreadStore;
  readonly transactions: SubagentTransactions;
  /** 取消活动 Run（生产：wire 到 SubagentRuntimeHost.cancelRun；§14.4 联动） */
  readonly cancelRun: (input: { readonly runId: SubagentRunId; readonly ownership: SubagentOwnership; readonly reasonCode: string }) => boolean;
  /** Thread 目录解析（生产：getRuntimePaths() 的 <subagentsBase>/<owner>/subagents/<threadId>） */
  readonly threadDirResolver?: (input: { readonly threadId: SubagentThreadId; readonly ownerAgentId: string }) => string;
  readonly now?: () => number;
  /** 投递退避：base 默认 2s；上限 5 分钟（§14.3） */
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  /** 诊断回调（T7 observability 埋点；best-effort） */
  readonly onDiagnostic?: (event: { readonly code: string; readonly detail: string; readonly sessionId?: string }) => void;
}

export interface ParentMailboxPage {
  readonly items: readonly ParentMailboxRecord[];
  readonly nextCursor: ParentMailboxCursor | null;
}

export interface WaitForNotificationsOptions {
  readonly after: ParentMailboxCursor | null;
  readonly limit?: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface LifecycleLinkageReport {
  readonly threadsProcessed: number;
  readonly runsCancelled: number;
  readonly threadsClosedNow: number;
  readonly mailboxSuppressed: number;
  readonly directoriesDeleted: number;
  readonly errors: readonly string[];
}

interface SessionEntry {
  port: ParentSessionPort;
  inFlight: { readonly mailboxIds: readonly ParentMailboxId[]; readonly operationId: string } | null;
  retryTimer: NodeJS.Timeout | null;
}

const NOTIFICATION_LABELS: Readonly<Record<ParentMailboxNotificationKind, string>> = {
  started: "已开始",
  input_required: "等待父输入",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
  interrupted: "被打断",
  budget_exhausted: "预算耗尽",
};

export class ParentMailboxDeliveryCoordinator {
  private readonly now: () => number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly changeListeners = new Set<() => void>();
  /** closing Thread 的 closeReason（onRunFinished 终态化时回填；§14.4 联动） */
  private readonly closeReasons = new Map<SubagentThreadId, string>();
  private continuationSequence = 0;

  constructor(private readonly deps: ParentMailboxDeliveryCoordinatorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.retryBaseDelayMs = deps.retryBaseDelayMs ?? 2_000;
    this.retryMaxDelayMs = deps.retryMaxDelayMs ?? 300_000;
  }

  // ── 父 Session 注册（T6 组合根接线）────────────────────────────

  /** 注册父 Session 端口：订阅用户打断/安全边界事件并立即检查 pending 投递 */
  registerParentSession(port: ParentSessionPort): void {
    const existing = this.sessions.get(port.sessionId);
    if (existing !== undefined) {
      existing.port = port;
      this.attemptDelivery(port.sessionId);
      return;
    }
    const entry: SessionEntry = { port, inFlight: null, retryTimer: null };
    this.sessions.set(port.sessionId, entry);
    port.subscribe({
      onUserInterrupt: () => {
        // in-flight continuation 的结算由 startContinuation outcome 完成；
        // 这里重检其他 pending（用户 Turn 进行中 → busy → 排队）
        this.attemptDelivery(port.sessionId);
      },
      onTurnEnd: () => {
        // 下一个安全输入边界：排队到这里的通知现在可以触发
        this.attemptDelivery(port.sessionId);
      },
    });
    this.attemptDelivery(port.sessionId);
  }

  unregisterParentSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer);
    }
    this.sessions.delete(sessionId);
  }

  /**
   * 新 mailbox 行已写入的信号（T6 接线 host.onTerminal / onMessage
   * input_required 后调用；或任何写入方直接调用）。同时通知 wait 监听器。
   */
  signal(input: { readonly threadId?: SubagentThreadId; readonly sessionId?: string }): void {
    let sessionId = input.sessionId;
    if (sessionId === undefined && input.threadId !== undefined) {
      const thread = this.deps.threadStore.getSystem(input.threadId);
      sessionId = thread?.parentSessionId;
    }
    for (const listener of [...this.changeListeners]) {
      listener();
    }
    if (sessionId !== undefined) {
      this.attemptDelivery(sessionId);
    }
  }

  /**
   * 启动恢复/定期重试：扫描 queued/delivering（delivering 视为可重试，§14.3）
   * 以及 failed 到期行，按会话聚合后重新投递。
   */
  retryPending(): { readonly sessionsRetried: number; readonly rows: number } {
    const rows = this.deps.mailboxStore.listRetryableDue(this.iso(), 1000);
    const touched = new Set<string>();
    for (const row of rows) {
      const key = `${row.ownerAgentId}::${row.parentSessionId}`;
      if (touched.has(key)) continue;
      touched.add(key);
      const entry = this.sessions.get(row.parentSessionId);
      if (entry !== undefined && entry.port.ownerAgentId === row.ownerAgentId) {
        this.attemptDelivery(row.parentSessionId);
      }
      // 未注册端口的会话：保持 pending，注册时（registerParentSession）
      // 或下次 retryPending 再投递（§14.1：父 Session 存在且可运行才投递）
    }
    return { sessionsRetried: touched.size, rows: rows.length };
  }

  // ── 父侧 cursor/wait 查询（§8.4 / §14.1：轮询/等待新通知）──────

  /** 按 session cursor 分页（所有状态可见；父侧轮询接口） */
  listForSession(ownership: SubagentOwnership, options: { readonly after?: ParentMailboxCursor | null; readonly limit?: number } = {}): ParentMailboxPage {
    const after = options.after ?? null;
    const items = this.deps.mailboxStore.listForSessionCursor(ownership, after, options.limit ?? 50);
    const last = items.at(-1);
    return {
      items,
      nextCursor: last === undefined ? null : { createdAt: last.createdAt, mailboxId: last.mailboxId },
    };
  }

  /**
   * 等待新通知（父侧 wait 接口；wait_subagent 等工具用）：先查一次，
   * 无新项则订阅 signal 事件；新行出现 / 超时 / abort 时返回当前页。
   */
  async waitForNotifications(ownership: SubagentOwnership, options: WaitForNotificationsOptions): Promise<ParentMailboxPage> {
    const page = (): ParentMailboxPage =>
      this.listForSession(ownership, {
        after: options.after,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    const initial = page();
    if (initial.items.length > 0) {
      return initial;
    }
    return new Promise<ParentMailboxPage>((resolve, reject) => {
      const onChange = (): void => {
        const latest = page();
        if (latest.items.length > 0) {
          cleanup();
          resolve(latest);
        }
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error("waitForNotifications aborted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(page());
      }, Math.max(options.timeoutMs, 0));
      const cleanup = (): void => {
        clearTimeout(timer);
        this.changeListeners.delete(onChange);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.changeListeners.add(onChange);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ── 父 Session 生命周期联动（§14.4 / §16.3）──────────────────

  /** 父 Session archived：取消活动 Run、closeThread（同事务 suppress mailbox） */
  handleParentSessionArchived(ownership: SubagentOwnership): LifecycleLinkageReport {
    return this.linkage(ownership, "archived");
  }

  /** 父 Session deleted：同 archive + 删除 Thread 目录（保留 Audit；§16.3） */
  handleParentSessionDeleted(ownership: SubagentOwnership): LifecycleLinkageReport {
    return this.linkage(ownership, "deleted");
  }

  /**
   * Run 完全清理后（host.onRunFinished 接线）：closing Thread 无活动 Run
   * → 终态化 closed（closeThread 幂等；closeReason 回填）。
   */
  onRunFinished(input: { readonly runId: SubagentRunId; readonly threadId: SubagentThreadId }): void {
    const thread = this.deps.threadStore.getSystem(input.threadId);
    if (thread === null || thread.status !== "closing") {
      return;
    }
    const ownership = { ownerAgentId: thread.ownerAgentId, parentSessionId: thread.parentSessionId };
    if (this.deps.runStore.hasActiveRun(input.threadId, ownership)) {
      return; // 仍有活动 Run（同 Thread 串行执行中）：继续等待
    }
    const reason = this.closeReasons.get(input.threadId) ?? thread.closeReason ?? "subagent_close_finalized";
    this.closeReasons.delete(input.threadId);
    try {
      this.deps.transactions.closeThread({ threadId: input.threadId, ownership, at: this.iso(), closeReason: reason, suppressMailboxIds: [] });
    } catch (error) {
      this.diagnose("subagent_operation_failed", `closing Thread 终态化失败：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`, thread.parentSessionId);
    }
  }

  /** 清定时器（Server 关闭/重启；pending 行由启动恢复接管） */
  dispose(): void {
    for (const entry of this.sessions.values()) {
      if (entry.retryTimer !== null) {
        clearTimeout(entry.retryTimer);
      }
    }
    this.sessions.clear();
    this.closeReasons.clear();
  }

  // ── 投递核心（§14.2 / §14.3）─────────────────────────────────

  private attemptDelivery(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      return;
    }
    const ownership = { ownerAgentId: entry.port.ownerAgentId, parentSessionId: sessionId };
    let rows = this.deps.mailboxStore.listRetryableDue(this.iso(), 500).filter(
      (row) => row.parentSessionId === sessionId && row.ownerAgentId === entry.port.ownerAgentId,
    );
    if (rows.length === 0) {
      // 无已到期行：若存在未到期的 failed 退避行，按最近到期时间补排定时器——
      // 一次性重试定时器若早于 next_retry_at 触发（时钟/事件循环偏差），
      // 行会永久搁浅直到下次 signal/重启（§14.3 退避重试的空洞）。
      this.scheduleNextDueRetry(sessionId, entry);
      return;
    }
    // failed 且已到期 → requeue（保留 last_error_code 供诊断；§14.3）
    const requeued: ParentMailboxRecord[] = [];
    for (const row of rows) {
      if (row.status === "failed") {
        this.deps.mailboxStore.requeue(row.mailboxId, ownership);
        requeued.push(row);
      }
    }
    rows = rows.filter((row) => row.status !== "failed").concat(requeued);

    // 非触发行（started，§8.4：只供状态查询）→ 立即结算 delivered
    for (const row of rows) {
      if (!row.triggerParentTurn) {
        this.markDelivered(row, ownership);
      }
    }
    const triggerRows = rows.filter((row) => row.triggerParentTurn);
    if (triggerRows.length === 0) {
      this.scheduleNextDueRetry(sessionId, entry);
      return;
    }

    const status = entry.port.getStatus();
    if (status === "archived" || status === "deleted") {
      // §14.2：父 Session 已归档/删除 → suppress delivery + 联动取消/关闭
      this.linkage(ownership, status === "archived" ? "archived" : "deleted");
      for (const row of triggerRows) {
        this.deps.mailboxStore.markSuppressed(row.mailboxId, ownership, this.iso());
      }
      return;
    }
    if (status === "busy" || status === "unknown") {
      // §14.2：父 Turn 正在运行且未 wait → 排队到下一个安全输入边界
      this.scheduleRetry(sessionId);
      return;
    }
    if (entry.inFlight !== null) {
      return; // 同一 Session 至多一个并发 continuation（§T5 交付 2）
    }

    // 父 idle 且可运行：聚合所有 pending 触发一次 continuation（幂等消费）
    for (const row of triggerRows) {
      this.deps.mailboxStore.markDelivering(row.mailboxId, ownership);
    }
    this.continuationSequence += 1;
    const operationId = `continuation-${sessionId}-${this.continuationSequence}`;
    entry.inFlight = { mailboxIds: triggerRows.map((row) => row.mailboxId), operationId };
    const text = this.renderContinuationText(triggerRows, ownership);
    void this.runContinuation(entry, triggerRows, text, ownership, operationId);
  }

  private async runContinuation(
    entry: SessionEntry,
    rows: readonly ParentMailboxRecord[],
    text: string,
    ownership: SubagentOwnership,
    operationId: string,
  ): Promise<void> {
    let outcome: ParentContinuationOutcome;
    try {
      outcome = await entry.port.startContinuation({ text, operationId });
    } catch (error) {
      outcome = { status: "rejected", reasonCode: "parent_continuation_failed" };
    }
    const now = this.iso();
    if (outcome.status === "triggered" || outcome.status === "interrupted") {
      // 已触发（正常结束或被用户打断）：终态语义——同一 Mailbox 项只触发
      // 一次父 Turn，不重复触发（§14.1 / §T5 交付 2：被打断不再重试）
      for (const row of rows) {
        this.markDelivered(row, ownership, now);
      }
    } else {
      // 未触发（父忙/abort pending/竞态抢占）：failed + 指数退避重试（§14.3）
      let attempt = 0;
      for (const row of rows) {
        attempt = Math.max(attempt, row.attemptCount + 1);
      }
      const delay = Math.min(this.retryBaseDelayMs * 2 ** Math.max(attempt - 1, 0), this.retryMaxDelayMs);
      const retryAt = new Date(this.now() + delay).toISOString();
      for (const row of rows) {
        this.deps.mailboxStore.markFailed(row.mailboxId, ownership, outcome.reasonCode, retryAt);
      }
      this.scheduleRetry(entry.port.sessionId, delay);
      this.diagnose(outcome.reasonCode, `continuation 未触发（${operationId}），${rows.length} 项 pending 进入退避重试`, entry.port.sessionId);
    }
    entry.inFlight = null;
    // 安全输入边界：重检（可能有新的 pending 通知）
    this.attemptDelivery(entry.port.sessionId);
  }

  private scheduleRetry(sessionId: string, delayMs = this.retryBaseDelayMs): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.retryTimer !== null) {
      return; // 已排队
    }
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.attemptDelivery(sessionId);
    }, delayMs);
  }

  /**
   * 存在未到期 failed 退避行时，按最近到期时间补排重试（§14.3 兜底）。
   * 一次性 setTimeout 触发时刻可能略早于 next_retry_at（libuv 循环时间与
   * Date.now 的毫秒级偏差），此时扫描不到到期行；不补排则该行搁浅到
   * 下次 signal/重启。+1ms 越过边界；若再次早触发则继续顺延（自愈）。
   */
  private scheduleNextDueRetry(sessionId: string, entry: SessionEntry): void {
    const dueAt = this.deps.mailboxStore.nextRetryDueAt({ ownerAgentId: entry.port.ownerAgentId, parentSessionId: sessionId });
    if (dueAt === null) {
      return;
    }
    const delay = Math.max(new Date(dueAt).getTime() - this.now(), 0) + 1;
    this.scheduleRetry(sessionId, delay);
  }

  // ── continuation 输入渲染（§14.2：只含摘要，不复制 transcript）──

  private renderContinuationText(rows: readonly ParentMailboxRecord[], ownership: SubagentOwnership): string {
    const blocks: string[] = [];
    for (const row of rows) {
      const thread = this.safe(() => this.deps.threadStore.get(row.threadId, ownership));
      const run = this.safe(() => this.deps.runStore.get(row.runId, ownership));
      const message = this.safe(() => this.deps.messageStore.get(row.messageId, ownership));
      const lines: string[] = [];
      lines.push(`【Subagent 通知】${thread?.title ?? row.threadId}`);
      lines.push(`Thread: ${row.threadId}`);
      lines.push(`Run: ${row.runId}`);
      lines.push(`状态: ${NOTIFICATION_LABELS[row.notificationKind] ?? row.notificationKind}`);
      if (row.notificationKind === "input_required") {
        const question = firstTextPart(message) ?? "";
        lines.push(`父输入请求: ${truncate(question, 800)}`);
        lines.push(`请调用 steer_subagent（threadId/runId 见上，action=answer_input）回答后 Run 自动恢复。`);
      } else {
        const result = run?.result ?? null;
        if (result !== null) {
          lines.push(`结果: ${result.disposition} — ${truncate(result.summary, 800)}`);
          if (result.artifacts.length > 0) {
            lines.push(`工件: ${result.artifacts.map((artifact) => artifact.name).join("、")}`);
          }
          lines.push(`建议下一步: ${result.recommendedNextAction}`);
        } else if (run?.reasonCode !== null && run?.reasonCode !== undefined) {
          lines.push(`原因: ${truncate(run.reasonCode, 400)}`);
        }
      }
      lines.push(`如需细节请调用 get_subagent_status / inspect_subagent 查看完整结果与证据。`);
      blocks.push(lines.join("\n"));
    }
    return truncate(blocks.join("\n\n---\n\n"), 4000);
  }

  // ── 生命周期联动（§14.4 / §16.3）──────────────────────────────

  private linkage(ownership: SubagentOwnership, mode: "archived" | "deleted"): LifecycleLinkageReport {
    const now = this.iso();
    const errors: string[] = [];
    let threadsProcessed = 0;
    let runsCancelled = 0;
    let threadsClosedNow = 0;
    let mailboxSuppressed = 0;
    let directoriesDeleted = 0;
    const reasonCode = mode === "archived" ? "subagent_cancelled_session_archived" : "subagent_cancelled_session_deleted";
    const closeReason = mode === "archived" ? "parent_session_archived" : "parent_session_deleted";
    const threads = this.deps.threadStore.listByOwner(ownership, 500);
    for (const thread of threads) {
      if (thread.status === "closed") {
        continue;
      }
      threadsProcessed += 1;
      const mailboxIds = this.deps.mailboxStore
        .listByThread(thread.threadId, ownership)
        .filter((row) => row.status !== "delivered" && row.status !== "suppressed")
        .map((row) => row.mailboxId);
      const activeRun = this.deps.runStore.getActiveRunByThread(thread.threadId, ownership);
      if (activeRun !== null) {
        try {
          if (this.deps.cancelRun({ runId: activeRun.runId, ownership, reasonCode })) {
            runsCancelled += 1;
          }
        } catch (error) {
          errors.push(`cancel ${activeRun.runId}: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
        }
      }
      try {
        const outcome = this.deps.transactions.closeThread({ threadId: thread.threadId, ownership, at: now, closeReason, suppressMailboxIds: mailboxIds });
        mailboxSuppressed += outcome.suppressed;
        if (outcome.closedNow) {
          threadsClosedNow += 1;
        } else {
          // 有活动 Run：取消终态后由 onRunFinished 终态化 closed
          this.closeReasons.set(thread.threadId, closeReason);
        }
      } catch (error) {
        errors.push(`close ${thread.threadId}: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
      }
    }
    if (mode === "deleted") {
      for (const thread of threads) {
        if (this.deps.threadDirResolver === undefined) {
          break; // 未接线目录解析：跳过文件删除（DB 侧已 close + suppress）
        }
        try {
          const dir = this.deps.threadDirResolver({ threadId: thread.threadId, ownerAgentId: ownership.ownerAgentId });
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
          if (fs.existsSync(dir)) {
            throw new Error("directory still exists after rm");
          }
          directoriesDeleted += 1;
        } catch (error) {
          errors.push(`rmdir ${thread.threadId}: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
        }
      }
    }
    if (errors.length > 0) {
      this.diagnose("subagent_operation_failed", `父 Session ${mode} 联动部分失败：${errors.join("; ")}`, ownership.parentSessionId);
    }
    return { threadsProcessed, runsCancelled, threadsClosedNow, mailboxSuppressed, directoriesDeleted, errors };
  }

  // ── helpers ──────────────────────────────────────────────────

  private markDelivered(row: ParentMailboxRecord, ownership: SubagentOwnership, at = this.iso()): void {
    this.deps.mailboxStore.markDelivered(row.mailboxId, ownership, at);
    // 消息与 mailbox 行共享 messageId（started 行是合成 messageId，无对应
    // 消息 → 跳过）；父侧消费记账（§8.2）
    if (this.deps.messageStore.get(row.messageId, ownership) !== null) {
      this.deps.messageStore.markDelivered(row.messageId, ownership, at);
    }
  }

  private safe<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch {
      return null;
    }
  }

  private diagnose(code: string, detail: string, sessionId?: string): void {
    this.deps.onDiagnostic?.({ code, detail, ...(sessionId !== undefined ? { sessionId } : {}) });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

function firstTextPart(message: SubagentMessageRecord | null): string | null {
  if (message === null) {
    return null;
  }
  for (const part of message.envelope.parts) {
    if (part.kind === "text" && part.text.length > 0) {
      return part.text;
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
