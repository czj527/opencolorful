import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  SUBAGENT_MESSAGE_PROTOCOL,
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type ParentMailboxId,
  type ParentMailboxNotificationKind,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import {
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
  type SubagentOwnership,
} from "../../src/runtime/subagents/stores/index.js";
import {
  ParentMailboxDeliveryCoordinator,
  type ParentMailboxDeliveryCoordinatorDeps,
} from "../../src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.js";
import type {
  ParentContinuationInput,
  ParentContinuationOutcome,
  ParentSessionPort,
  ParentSessionPortEvents,
  ParentSessionStatus,
} from "../../src/runtime/subagents/mailbox/parent-session-port.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：ParentMailboxDeliveryCoordinator 测试（plans/phase-14.md §14 / §25.6）
//
// 覆盖：
// - started 不唤醒父 Turn；terminal/input_required 可唤醒；
// - 父 idle → 一次 continuation（多通知聚合一次）；父 busy → 排队到安全边界；
// - 同一 Mailbox 项只触发一次父 Turn（delivered 重放不触发第二次）；
// - 触发失败（rejected）→ failed + 退避重试；被打断（interrupted）→ delivered；
// - cursor 分页 + wait 查询（signal 唤醒 / 超时 / abort）；
// - 父 Session archive/delete 联动：取消活动 Run、closeThread + mailbox
//   suppression、删除 Thread 目录、onRunFinished 终态化 closing。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];
const trackedCoordinators: ParentMailboxDeliveryCoordinator[] = [];

function createDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-mailbox-"));
  temporaryDirectories.push(dir);
  const db = openMetadataDatabase(path.join(dir, "metadata.db"));
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const coordinator of trackedCoordinators.splice(0)) {
    coordinator.dispose();
  }
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭或无效句柄，忽略
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const THREAD_ID = "sat_thread000001" as SubagentThreadId;
const RUN_ID = "sar_run000000001" as SubagentRunId;
const OWNERSHIP: SubagentOwnership = { ownerAgentId: "agent-a", parentSessionId: "sess-1" };

/** 可编程父 Session 端口（Faux） */
class FauxParentSessionPort implements ParentSessionPort {
  readonly sessionId = "sess-1";
  readonly ownerAgentId = "agent-a";
  status: ParentSessionStatus = "idle";
  readonly startCalls: Array<{ text: string; operationId: string }> = [];
  pendingOutcomes: ParentContinuationOutcome[] = [];
  private resolveStart: ((outcome: ParentContinuationOutcome) => void) | null = null;
  private events: ParentSessionPortEvents | null = null;
  turnEnds = 0;
  interrupts = 0;

  getStatus(): ParentSessionStatus {
    return this.status;
  }

  startContinuation(input: ParentContinuationInput): Promise<ParentContinuationOutcome> {
    this.startCalls.push(input);
    return new Promise((resolve) => {
      this.resolveStart = resolve;
    });
  }

  /** 测试：结束当前 continuation（按队列依次结算） */
  finishNext(outcome: ParentContinuationOutcome): void {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    resolve?.(outcome);
  }

  noteUserMessage(): void {
    this.events?.onUserInterrupt();
  }

  noteUserTurnEnd(): void {
    this.turnEnds += 1;
    this.events?.onTurnEnd();
  }

  noteUserAbort(): void {
    this.interrupts += 1;
    this.events?.onUserInterrupt();
  }

  subscribe(events: ParentSessionPortEvents): () => void {
    this.events = events;
    return () => {
      this.events = null;
    };
  }
}

interface Harness {
  readonly db: Database.Database;
  readonly runs: RunStore;
  readonly messages: MessageStore;
  readonly mailboxStore: ParentMailboxStore;
  readonly transactions: SubagentTransactions;
  readonly threadStore: ThreadStore;
  readonly port: FauxParentSessionPort;
  readonly coordinator: ParentMailboxDeliveryCoordinator;
  readonly cancelCalls: Array<{ runId: SubagentRunId; reasonCode: string }>;
  readonly diagnostics: Array<{ code: string; detail: string }>;
  createRun(runId: SubagentRunId): void;
  makeTerminalMailbox(kind: ParentMailboxNotificationKind, runId?: SubagentRunId): ParentMailboxId;
  makeInputRequiredMailbox(question: string, runId?: SubagentRunId): ParentMailboxId;
}

function resultEnvelope(runId: SubagentRunId, messageId: AgentMessageId): Omit<AgentMessageEnvelopeV1, "sequence"> {
  return {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId,
    contextId: THREAD_ID,
    taskId: runId,
    sender: { kind: "subagent", id: runId },
    recipient: { kind: "parent_agent", id: "agent-a" },
    messageType: "result",
    deliveryMode: "mailbox",
    parts: [{ kind: "text", text: "done" }],
    metadata: { createdAt: NOW, traceId: "trace-mb", schemaName: "subagent.result" },
  };
}

function createThread(db: Database.Database): { threadStore: ThreadStore; runs: RunStore; messages: MessageStore; mailboxStore: ParentMailboxStore; transactions: SubagentTransactions } {
  const threadStore = new ThreadStore(db);
  const runs = new RunStore(db, threadStore);
  const messages = new MessageStore(db, threadStore);
  const mailboxStore = new ParentMailboxStore(db);
  const transactions = new SubagentTransactions(db, { threadStore, runStore: runs, messageStore: messages, mailboxStore });
  transactions.createThreadWithFirstRun({
    thread: {
      threadId: THREAD_ID,
      title: "T5 mailbox",
      modelProviderId: "faux",
      modelId: "faux-1",
      modelSource: "user_default",
      thinkingLevel: "normal",
      workspaceCwd: "/tmp",
      capabilityCeiling: {
        ceilingHash: "hash12345678",
        workspaceAccess: "read",
        toolIds: [],
        pluginContributionIds: [],
        skillRefs: [],
        network: "inherit",
        fixedDenials: [],
      },
      contextPacketHash: "hash12345678",
      createdFromTurnId: "turn-1",
    },
    ownership: OWNERSHIP,
    firstRun: { runId: RUN_ID, triggerMessageId: "sam_task00000001" as AgentMessageId },
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    taskEnvelope: {
      protocol: SUBAGENT_MESSAGE_PROTOCOL,
      version: 1,
      messageId: "sam_task00000001" as AgentMessageId,
      contextId: THREAD_ID,
      taskId: RUN_ID,
      sender: { kind: "parent_agent", id: "agent-a" },
      recipient: { kind: "subagent", id: RUN_ID },
      messageType: "task",
      deliveryMode: "immediate",
      parts: [{ kind: "text", text: "研究并汇报" }],
      metadata: { createdAt: NOW, traceId: "trace-mb", schemaName: "subagent.task" },
    },
    now: NOW,
  });
  return { threadStore, runs, messages, mailboxStore, transactions };
}

function createHarness(overrides: { retryBaseDelayMs?: number; threadDirResolver?: ParentMailboxDeliveryCoordinatorDeps["threadDirResolver"] } = {}): Harness {
  const db = createDatabase();
  const { threadStore, runs, messages, mailboxStore, transactions } = createThread(db);
  const port = new FauxParentSessionPort();
  const cancelCalls: Harness["cancelCalls"] = [];
  const diagnostics: Harness["diagnostics"] = [];
  const coordinator = new ParentMailboxDeliveryCoordinator({
    mailboxStore,
    messageStore: messages,
    runStore: runs,
    threadStore,
    transactions,
    cancelRun: ({ runId, reasonCode }) => {
      cancelCalls.push({ runId, reasonCode });
      return true;
    },
    ...(overrides.threadDirResolver !== undefined ? { threadDirResolver: overrides.threadDirResolver } : {}),
    retryBaseDelayMs: overrides.retryBaseDelayMs ?? 15,
    retryMaxDelayMs: 60,
    onDiagnostic: ({ code, detail }) => {
      diagnostics.push({ code, detail });
    },
  });
  trackedCoordinators.push(coordinator);
  coordinator.registerParentSession(port);
  return {
    db,
    runs,
    messages,
    mailboxStore,
    transactions,
    threadStore,
    port,
    coordinator,
    cancelCalls,
    diagnostics,
    createRun(runId) {
      // 同 Thread 新 Run（上一 Run 已终态后允许；§7.4 多轮规则）
      runs.create(
        {
          runId,
          threadId: THREAD_ID,
          triggerMessageId: `sam_trig${Math.random().toString(36).slice(2, 14)}` as AgentMessageId,
          limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
          createdAt: NOW,
        },
        OWNERSHIP,
      );
    },
    makeTerminalMailbox(kind, runId = RUN_ID) {
      // 把 Run 走到 running 再终态（terminal + result message + mailbox 单事务）
      runs.transit({ runId, from: "queued", to: "starting", reasonCode: null, now: NOW }, OWNERSHIP);
      runs.transit({ runId, from: "starting", to: "running", reasonCode: null, now: NOW }, OWNERSHIP);
      const messageId = `sam_term${Math.random().toString(36).slice(2, 14)}` as AgentMessageId;
      const result: SubagentResultV1 = {
        version: 1,
        disposition: "satisfied",
        summary: "任务完成",
        criteria: [],
        artifacts: [],
        unresolvedIssues: [],
        recommendedNextAction: "accept",
      };
      const outcome = transactions.completeRunWithResult({
        runId,
        threadId: THREAD_ID,
        ownership: OWNERSHIP,
        from: "running",
        to: kind === "failed" ? "failed" : "succeeded",
        result: kind === "failed" ? null : result,
        reasonCode: kind === "failed" ? "subagent_operation_failed" : null,
        usage: null,
        resultEnvelope: resultEnvelope(runId, messageId),
        mailbox: {
          mailboxId: `smb_mb${Math.random().toString(36).slice(2, 14)}` as ParentMailboxId,
          messageId,
          notificationKind: kind,
          operationId: `test-terminal-${runId}-${kind}`,
          triggerParentTurn: kind !== "started",
        },
        now: NOW,
      });
      return outcome.mailbox?.mailboxId ?? (`smb_mb${Math.random().toString(36).slice(2, 14)}` as ParentMailboxId);
    },
    makeInputRequiredMailbox(question, runId = RUN_ID) {
      runs.transit({ runId, from: "queued", to: "starting", reasonCode: null, now: NOW }, OWNERSHIP);
      runs.transit({ runId, from: "starting", to: "running", reasonCode: null, now: NOW }, OWNERSHIP);
      const envelope: Omit<AgentMessageEnvelopeV1, "sequence"> = {
        protocol: SUBAGENT_MESSAGE_PROTOCOL,
        version: 1,
        messageId: `sam_inp${Math.random().toString(36).slice(2, 14)}` as AgentMessageId,
        contextId: THREAD_ID,
        taskId: runId,
        sender: { kind: "subagent", id: runId },
        recipient: { kind: "parent_agent", id: "agent-a" },
        messageType: "input_required",
        deliveryMode: "mailbox",
        parts: [{ kind: "text", text: question }],
        metadata: { createdAt: NOW, traceId: "trace-mb", schemaName: "subagent.input_required" },
      };
      const outcome = transactions.waitingForInputWithMailbox({
        runId,
        threadId: THREAD_ID,
        ownership: OWNERSHIP,
        envelope,
        mailbox: { mailboxId: `smb_mb${Math.random().toString(36).slice(2, 14)}` as ParentMailboxId, messageId: envelope.messageId, operationId: `test-input-${runId}` },
        now: NOW,
      });
      return outcome.mailbox.mailboxId;
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Mailbox 投递：唤醒规则（§8.4 / §14.1）", () => {
  it("started 通知不唤醒父 Turn（无 continuation）", () => {
    const h = createHarness();
    h.coordinator.signal({ threadId: THREAD_ID });
    expect(h.port.startCalls).toHaveLength(0);
    // started 行结算为 delivered（状态记录；不触发）
    const rows = h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP);
    expect(rows.every((row) => row.status === "delivered")).toBe(true);
  });

  it("terminal（completed）→ 父 idle 时触发一次 continuation，mailbox 结算 delivered", async () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.coordinator.signal({ threadId: THREAD_ID });
    await waitUntil(() => h.port.startCalls.length === 1);
    expect(h.port.startCalls[0]?.text).toContain(THREAD_ID);
    expect(h.port.startCalls[0]?.text).toContain("已完成");
    expect(h.port.startCalls[0]?.text).toContain("任务完成"); // 短摘要（§14.2）
    expect(h.port.startCalls[0]?.text).toContain("inspect_subagent");
    h.port.finishNext({ status: "triggered" });
    await waitUntil(() => h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP).every((row) => row.status === "delivered"));
  });

  it("input_required → 触发 continuation（question 进入输入，附 answer_input 提示）", async () => {
    const h = createHarness();
    h.makeInputRequiredMailbox("需要确认目标目录");
    h.coordinator.signal({ threadId: THREAD_ID });
    await waitUntil(() => h.port.startCalls.length === 1);
    expect(h.port.startCalls[0]?.text).toContain("需要确认目标目录");
    expect(h.port.startCalls[0]?.text).toContain("answer_input");
  });

  it("普通 progress 不创建 mailbox（无通知可投递）", () => {
    const h = createHarness();
    // progress 消息落库但不投影 mailbox（§8.4：普通 progress 只投影给面板）
    const envelope: Omit<AgentMessageEnvelopeV1, "sequence"> = {
      protocol: SUBAGENT_MESSAGE_PROTOCOL,
      version: 1,
      messageId: "sam_prog00000001" as AgentMessageId,
      contextId: THREAD_ID,
      taskId: RUN_ID,
      sender: { kind: "subagent", id: RUN_ID },
      recipient: { kind: "parent_agent", id: "agent-a" },
      messageType: "progress",
      deliveryMode: "immediate",
      parts: [{ kind: "text", text: "进展 50%" }],
      metadata: { createdAt: NOW, traceId: "trace-mb", schemaName: "subagent.progress" },
    };
    h.messages.append({ envelope, ownership: OWNERSHIP, createdAt: NOW });
    h.coordinator.signal({ threadId: THREAD_ID });
    expect(h.port.startCalls).toHaveLength(0);
    expect(h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP)).toHaveLength(0);
  });
});

describe("Mailbox 投递：幂等与聚合（§14.1 / §14.3）", () => {
  it("多个 pending 通知聚合为一次 continuation（父 idle 只触发一次）", async () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.createRun("sar_run000000002" as SubagentRunId);
    h.makeTerminalMailbox("failed", "sar_run000000002" as SubagentRunId);
    h.coordinator.signal({ threadId: THREAD_ID });
    await waitUntil(() => h.port.startCalls.length === 1);
    expect(h.port.startCalls[0]?.text).toContain("已完成");
    expect(h.port.startCalls[0]?.text).toContain("失败");
    h.port.finishNext({ status: "triggered" });
    await waitUntil(() => h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP).filter((row) => row.status === "delivered").length === 2);
    // 已 delivered，不重复触发（同一 Mailbox 项只触发一次父 Turn）
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.port.startCalls).toHaveLength(1);
  });

  it("Delivered 重放（再次 signal）不触发第二个父 Turn", async () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.coordinator.signal({ threadId: THREAD_ID });
    await waitUntil(() => h.port.startCalls.length === 1);
    h.port.finishNext({ status: "triggered" });
    await waitUntil(() => h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP).every((row) => row.status === "delivered"));
    h.coordinator.signal({ threadId: THREAD_ID });
    h.coordinator.retryPending();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.port.startCalls).toHaveLength(1);
  });

  it("in-flight 期间新通知排队，至多一个并发 continuation", async () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.coordinator.signal({ threadId: THREAD_ID });
    await waitUntil(() => h.port.startCalls.length === 1);
    // 第一个 continuation 尚未结算时又来新通知
    h.createRun("sar_run000000002" as SubagentRunId);
    h.makeTerminalMailbox("failed", "sar_run000000002" as SubagentRunId);
    h.coordinator.signal({ threadId: THREAD_ID });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.port.startCalls).toHaveLength(1); // 不并发
    h.port.finishNext({ status: "triggered" });
    await waitUntil(() => h.port.startCalls.length === 2); // 结算后处理排队项
  });
});

describe("Mailbox 投递：父 busy / 触发失败 / 打断（§14.2 / §T5 交付 2）", () => {
  it("父 Turn 运行中（busy）→ 排队到安全边界；用户 Turn 结束（onTurnEnd）后触发", async () => {
    const h = createHarness({ retryBaseDelayMs: 60_000 }); // 关闭快速重试，验证边界语义
    h.port.status = "busy";
    h.makeTerminalMailbox("completed");
    h.coordinator.signal({ threadId: THREAD_ID });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.port.startCalls).toHaveLength(0); // busy：排队不触发
    h.port.status = "idle";
    h.port.noteUserTurnEnd(); // 下一个安全输入边界
    await waitUntil(() => h.port.startCalls.length === 1);
  });

  it("触发失败（rejected）→ failed + 指数退避重试，最终 delivered", async () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.coordinator.signal({ threadId: THREAD_ID });
    await waitUntil(() => h.port.startCalls.length === 1);
    h.port.finishNext({ status: "rejected", reasonCode: "parent_session_busy" });
    await waitUntil(() => {
      const rows = h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP);
      return rows.some((row) => row.status === "failed" && row.lastErrorCode === "parent_session_busy" && row.nextRetryAt !== null);
    });
    // 退避到期后 retryPending 重新投递（delivering 视为可重试，§14.3）
    await waitUntil(() => h.port.startCalls.length >= 2);
    h.port.finishNext({ status: "triggered" });
    await waitUntil(() => h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP).every((row) => row.status === "delivered"));
  });

  it("被用户打断（interrupted）→ delivered（已触发一次，不重复触发）", async () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.coordinator.signal({ threadId: THREAD_ID });
    await waitUntil(() => h.port.startCalls.length === 1);
    h.port.finishNext({ status: "interrupted" }); // 用户消息抢占
    await waitUntil(() => h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP).every((row) => row.status === "delivered"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.port.startCalls).toHaveLength(1); // 不重试
  });
});

describe("Mailbox 查询：cursor 分页与 wait（§8.4 / §14.1）", () => {
  it("listForSession cursor 分页（createdAt + mailboxId 字典序，不重不漏）", () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.createRun("sar_run000000002" as SubagentRunId);
    h.makeTerminalMailbox("failed", "sar_run000000002" as SubagentRunId);
    const page1 = h.coordinator.listForSession(OWNERSHIP, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = h.coordinator.listForSession(OWNERSHIP, { after: page1.nextCursor, limit: 1 });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.mailboxId).not.toBe(page1.items[0]?.mailboxId);
    const page3 = h.coordinator.listForSession(OWNERSHIP, { after: page2.nextCursor });
    expect(page3.items).toHaveLength(0);
  });

  it("waitForNotifications：新通知出现即返回（signal 唤醒）", async () => {
    const h = createHarness();
    const waiting = h.coordinator.waitForNotifications(OWNERSHIP, { after: null, timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.makeTerminalMailbox("completed");
    h.coordinator.signal({ threadId: THREAD_ID });
    const page = await waiting;
    expect(page.items).toHaveLength(1);
  });

  it("waitForNotifications：超时返回当前页（空）", async () => {
    const h = createHarness();
    const page = await h.coordinator.waitForNotifications(OWNERSHIP, { after: null, timeoutMs: 30 });
    expect(page.items).toHaveLength(0);
  });

  it("waitForNotifications：abort 拒绝", async () => {
    const h = createHarness();
    const controller = new AbortController();
    const waiting = h.coordinator.waitForNotifications(OWNERSHIP, { after: null, timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
  });
});

describe("父 Session 生命周期联动（§14.4 / §16.3 / §25.6）", () => {
  it("archived：取消活动 Run + closeThread + mailbox suppression（同事务）", async () => {
    const h = createHarness();
    // 活动 Run（queued → running）+ 未投递的 queued mailbox 行
    h.runs.transit({ runId: RUN_ID, from: "queued", to: "starting", reasonCode: null, now: NOW }, OWNERSHIP);
    h.runs.transit({ runId: RUN_ID, from: "starting", to: "running", reasonCode: null, now: NOW }, OWNERSHIP);
    h.mailboxStore.enqueue({
      mailboxId: "smb_mbqueued0001" as ParentMailboxId,
      ownerAgentId: "agent-a",
      parentSessionId: "sess-1",
      threadId: THREAD_ID,
      runId: RUN_ID,
      messageId: "sam_queued000001" as AgentMessageId,
      notificationKind: "failed",
      triggerParentTurn: true,
      operationId: "test-queued-notif",
      createdAt: NOW,
    });
    const report = h.coordinator.handleParentSessionArchived(OWNERSHIP);
    expect(report.runsCancelled).toBe(1);
    expect(h.cancelCalls).toEqual([{ runId: RUN_ID, reasonCode: "subagent_cancelled_session_archived" }]);
    expect(h.threadStore.get(THREAD_ID, OWNERSHIP)?.status).toBe("closing"); // 活动 Run 取消后终态化 closed
    expect(report.mailboxSuppressed).toBe(1);
    const suppressed = h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP).filter((row) => row.status === "suppressed");
    expect(suppressed).toHaveLength(1);
  });

  it("onRunFinished：活动 Run 取消终态后 closing → closed（保留只读历史）", async () => {
    const h = createHarness();
    h.runs.transit({ runId: RUN_ID, from: "queued", to: "starting", reasonCode: null, now: NOW }, OWNERSHIP);
    h.runs.transit({ runId: RUN_ID, from: "starting", to: "running", reasonCode: null, now: NOW }, OWNERSHIP);
    h.coordinator.handleParentSessionArchived(OWNERSHIP);
    expect(h.threadStore.get(THREAD_ID, OWNERSHIP)?.status).toBe("closing");
    // 取消终态：running → cancelling → cancelled（转换表无 running → cancelled 直接边）
    h.runs.transit({ runId: RUN_ID, from: "running", to: "cancelling", reasonCode: null, now: NOW }, OWNERSHIP);
    const messageId = "sam_cancelterm01" as AgentMessageId;
    h.transactions.completeRunWithResult({
      runId: RUN_ID,
      threadId: THREAD_ID,
      ownership: OWNERSHIP,
      from: "cancelling",
      to: "cancelled",
      result: null,
      reasonCode: "subagent_cancelled_session_archived",
      usage: null,
      resultEnvelope: resultEnvelope(RUN_ID, messageId),
      mailbox: {
        mailboxId: "smb_mbcancel0001" as ParentMailboxId,
        messageId,
        notificationKind: "cancelled",
        operationId: "test-cancel-term",
        triggerParentTurn: false,
      },
      now: NOW,
    });
    h.coordinator.onRunFinished({ runId: RUN_ID, threadId: THREAD_ID });
    expect(h.threadStore.get(THREAD_ID, OWNERSHIP)?.status).toBe("closed");
    expect(h.threadStore.get(THREAD_ID, OWNERSHIP)?.closeReason).toBe("parent_session_archived");
  });

  it("deleted：同 archive + 删除 Thread 目录（保留 Audit 不在本层）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-threaddir-"));
    temporaryDirectories.push(dir);
    fs.writeFileSync(path.join(dir, "session.jsonl"), "line1\n");
    const h = createHarness({ threadDirResolver: () => dir });
    // 先让 Run 终态（无活动 Run → closeThread 直接 closed）
    h.runs.transit({ runId: RUN_ID, from: "queued", to: "starting", reasonCode: null, now: NOW }, OWNERSHIP);
    h.runs.transit({ runId: RUN_ID, from: "starting", to: "running", reasonCode: null, now: NOW }, OWNERSHIP);
    h.runs.transit({ runId: RUN_ID, from: "running", to: "succeeded", reasonCode: null, now: NOW }, OWNERSHIP);
    const report = h.coordinator.handleParentSessionDeleted(OWNERSHIP);
    expect(report.directoriesDeleted).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.threadStore.get(THREAD_ID, OWNERSHIP)?.status).toBe("closed");
    expect(h.threadStore.get(THREAD_ID, OWNERSHIP)?.closeReason).toBe("parent_session_deleted");
  });

  it("attemptDelivery 发现父 archived → suppress + 联动（不触发 continuation）", async () => {
    const h = createHarness();
    h.makeTerminalMailbox("completed");
    h.port.status = "archived";
    h.coordinator.signal({ threadId: THREAD_ID });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.port.startCalls).toHaveLength(0);
    const rows = h.mailboxStore.listByThread(THREAD_ID, OWNERSHIP);
    expect(rows.every((row) => row.status === "suppressed" || row.status === "delivered")).toBe(true);
  });
});

describe("Mailbox 投递：crash window（§14.3 / §16.5）", () => {
  it("delivering 遗留（投递中崩溃）→ retryPending 补投递一次", async () => {
    const h = createHarness();
    const mailboxId = h.makeTerminalMailbox("completed");
    // 模拟崩溃：mailbox 停在 delivering、消息停在 queued（没有 delivered 事实）
    h.db.prepare("UPDATE subagent_parent_mailbox SET status = 'delivering' WHERE mailbox_id = ?").run(mailboxId);
    h.db.prepare("UPDATE subagent_messages SET delivery_status = 'queued' WHERE message_id = (SELECT message_id FROM subagent_parent_mailbox WHERE mailbox_id = ?)").run(mailboxId);
    // 未注册端口（模拟重启后还没接线）→ 保持 pending；注册后补投递
    h.coordinator.unregisterParentSession("sess-1");
    const { rows } = h.coordinator.retryPending();
    expect(rows).toBeGreaterThan(0);
    h.coordinator.registerParentSession(h.port);
    await waitUntil(() => h.port.startCalls.length === 1);
    h.port.finishNext({ status: "triggered" });
    await waitUntil(() => h.mailboxStore.get(mailboxId, OWNERSHIP)?.status === "delivered");
  });
});
