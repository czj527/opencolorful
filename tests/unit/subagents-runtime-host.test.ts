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
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentRunLimitsV1,
  type SubagentRunStatus,
  type SubagentSnapshotId,
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
  REQUEST_PARENT_INPUT_TOOL,
  REPORT_SUBAGENT_RESULT_TOOL,
} from "../../src/runtime/subagents/runtime/internal-tools.js";
import {
  SubagentRuntimeHost,
  SUBAGENT_BUDGET_REASON_CODES,
  SUBAGENT_TIMEOUT_REASON_CODES,
  type ExecuteSubagentRunInput,
  type SubagentRuntimeHostDeps,
} from "../../src/runtime/subagents/runtime/runtime-host.js";
import {
  SubagentScheduler,
  SUBAGENT_SCHEDULER_DEFAULT_CAPACITY,
} from "../../src/runtime/subagents/runtime/scheduler.js";
import type {
  SubagentSessionEvent,
  SubagentSessionFactory,
  SubagentSessionPort,
  SubagentSessionStartInput,
  SubagentToolInvokeResult,
} from "../../src/runtime/subagents/runtime/types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T4：RuntimeHost/Scheduler 全链测试（plans/phase-14.md §15 / §25.3）
//
// Faux Session 适配器（SubagentSessionPort 测试实现）：
// - start gate：测试用 finish() 显式释放（start resolve = 会话完全结束）；
// - emit：同步注入事件流（tool-invoke 带 resolve 回调，返回 Promise 等结果）；
// - 覆盖：成功终态全链、三内部工具 schema/唯一性、缺失 result 两次结束、
//   timeout/budget 四类原因、waiting_for_input 恢复、heartbeat/Lease 丢失
//   停止写、快照冲突 fail-closed、startup 超时、Scheduler 容量排队。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];
const trackedHosts: SubagentRuntimeHost[] = [];

function createDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-runtime-"));
  temporaryDirectories.push(dir);
  const db = openMetadataDatabase(path.join(dir, "metadata.db"));
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const host of trackedHosts.splice(0)) {
    host.dispose();
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

// ── Faux Session ────────────────────────────────────────────────

class FauxSessionPort implements SubagentSessionPort {
  readonly sessionId: string;
  startInput: SubagentSessionStartInput | null = null;
  readonly followUpMessages: string[] = [];
  readonly steerMessages: string[] = [];
  aborted = false;
  disposed = false;
  private readonly listeners = new Set<(event: SubagentSessionEvent) => void>();
  private resolveStart: (() => void) | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  start(input: SubagentSessionStartInput): Promise<void> {
    this.startInput = input;
    return new Promise((resolve) => {
      this.resolveStart = resolve;
    });
  }

  followUp(message: string): void {
    this.followUpMessages.push(message);
  }

  steer(message: string): void {
    this.steerMessages.push(message);
  }

  abort(): void {
    this.aborted = true;
  }

  dispose(): void {
    this.disposed = true;
  }

  onEvent(listener: (event: SubagentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 测试：释放 start gate（start resolve = 会话完全结束） */
  finish(): void {
    if (this.resolveStart !== null) {
      const resolve = this.resolveStart;
      this.resolveStart = null;
      resolve();
    }
  }

  /** 测试：注入事件（同步派发给 host） */
  emit(event: SubagentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  /** 测试：注入工具调用并等待 host 响应 */
  invokeTool(name: string, args: unknown): Promise<SubagentToolInvokeResult> {
    return new Promise((resolve) => {
      this.emit({ type: "tool-invoke", toolCallId: `tc-${Math.random().toString(36).slice(2)}`, name, args, resolve });
    });
  }
}

class FauxSessionFactory implements SubagentSessionFactory {
  readonly sessions: FauxSessionPort[] = [];
  failCreate: Error | null = null;
  create(): Promise<SubagentSessionPort> {
    if (this.failCreate !== null) {
      return Promise.reject(this.failCreate);
    }
    const session = new FauxSessionPort(`faux-session-${this.sessions.length + 1}`);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  latest(): FauxSessionPort {
    const session = this.sessions[this.sessions.length - 1];
    if (session === undefined) {
      throw new Error("no session created yet");
    }
    return session;
  }
}

// ── fixtures ────────────────────────────────────────────────────

function ownership(agent = "agent-a", session = "sess-main"): SubagentOwnership {
  return { ownerAgentId: agent, parentSessionId: session };
}

const THREAD_ID = "sat_thread00001" as SubagentThreadId;
const RUN_ID = "sar_run0000001" as SubagentRunId;
const TRIGGER_MESSAGE_ID = "sam_trigger1" as AgentMessageId;

function taskEnvelope(): Omit<AgentMessageEnvelopeV1, "sequence"> {
  return {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId: TRIGGER_MESSAGE_ID,
    contextId: THREAD_ID,
    taskId: RUN_ID,
    sender: { kind: "parent_agent", id: "agent-a" },
    recipient: { kind: "subagent", id: RUN_ID },
    messageType: "task",
    deliveryMode: "immediate",
    parts: [{ kind: "text", text: "研究并汇报" }],
    metadata: { createdAt: NOW, traceId: "trace-t4", schemaName: "subagent.task" },
  };
}

function fastLimits(overrides: Partial<SubagentRunLimitsV1> = {}) {
  return { ...SUBAGENT_RUN_LIMITS_DEFAULTS, ...overrides };
}

interface Harness {
  readonly db: Database.Database;
  readonly runs: RunStore;
  readonly messages: MessageStore;
  readonly transactions: SubagentTransactions;
  readonly factory: FauxSessionFactory;
  readonly host: SubagentRuntimeHost;
  readonly scheduler: SubagentScheduler;
  readonly terminals: Array<{ runId: SubagentRunId; status: string; reasonCode: string | null }>;
  readonly progressEvents: Array<{ runId: SubagentRunId; text: string }>;
  readonly messageEvents: Array<{ runId: SubagentRunId; messageType: string }>;
  readonly leaseLostRuns: SubagentRunId[];
  submit(input: Partial<ExecuteSubagentRunInput>): void;
}

function createHarness(overrides: Partial<SubagentRuntimeHostDeps> = {}): Harness {
  const db = createDatabase();
  const threadStore = new ThreadStore(db);
  const runs = new RunStore(db, threadStore);
  const messages = new MessageStore(db, threadStore);
  const transactions = new SubagentTransactions(db, { threadStore, runStore: runs, messageStore: messages, mailboxStore: new ParentMailboxStore(db) });
  const factory = new FauxSessionFactory();
  const terminals: Harness["terminals"] = [];
  const progressEvents: Harness["progressEvents"] = [];
  const messageEvents: Harness["messageEvents"] = [];
  const leaseLostRuns: SubagentRunId[] = [];
  let scheduler: SubagentScheduler;
  const host = new SubagentRuntimeHost({
    runs,
    messages,
    transactions,
    sessionFactory: factory,
    bootId: "boot-1",
    heartbeatIntervalMs: 20,
    runtimeLeaseTtlMs: 60,
    onTerminal: (event) => {
      terminals.push({ runId: event.runId, status: event.status, reasonCode: event.reasonCode });
    },
    onRunFinished: () => scheduler.onRunTerminal(), // 容量释放 → 启动排队 Run
    onRunProgress: (event) => progressEvents.push({ runId: event.runId, text: event.text }),
    onMessage: (event) => messageEvents.push({ runId: event.runId, messageType: event.message.envelope.messageType }),
    onLeaseLost: (event) => leaseLostRuns.push(event.runId),
    ...overrides,
  });
  trackedHosts.push(host);
  scheduler = new SubagentScheduler({ host });
  return {
    db,
    runs,
    messages,
    transactions,
    factory,
    host,
    scheduler,
    terminals,
    progressEvents,
    messageEvents,
    leaseLostRuns,
    submit(partial) {
      transactions.createThreadWithFirstRun(
        {
          thread: {
            threadId: THREAD_ID,
            title: "T4 test",
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
          ownership: ownership(),
          firstRun: { runId: RUN_ID, triggerMessageId: TRIGGER_MESSAGE_ID },
          limits: fastLimits(partial.limits),
          taskEnvelope: taskEnvelope(),
          now: NOW,
        },
      );
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function executeInput(limits: SubagentRunLimitsV1 = fastLimits()): ExecuteSubagentRunInput {
  return {
    runId: RUN_ID,
    threadId: THREAD_ID,
    ownership: ownership(),
    snapshotId: "sas_snap000001" as SubagentSnapshotId,
    snapshotJson: JSON.stringify({ ceilingHash: "hash12345678" }),
    prompt: "[任务简报] 研究并汇报\n[上下文] 无",
    abilityTools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
    sessionDir: "/tmp/sessions",
    workspaceCwd: "/tmp",
    limits,
    thinkingLevel: "normal",
    triggerMessageId: TRIGGER_MESSAGE_ID,
  };
}

function resultArgs(disposition = "satisfied") {
  return {
    disposition,
    summary: "任务完成",
    criteria: [{ criterion: "c1", status: "met", evidenceRefs: ["ref-1"] }],
    artifacts: [],
    unresolvedIssues: [],
    recommendedNextAction: "accept",
  };
}

// ── 用例 ────────────────────────────────────────────────────────

describe("SubagentRuntimeHost：成功终态全链", () => {
  it("report_subagent_result → Run succeeded + result message + mailbox(completed) + onTerminal", async () => {
    const h = createHarness();
    h.submit({});
    expect(h.scheduler.submit(executeInput())).toEqual({ status: "accepted", queued: false });
    const session = await waitForSession(h.factory);
    expect(session.startInput?.tools.map((tool) => tool.name)).toContain(REPORT_SUBAGENT_RESULT_TOOL);

    // 进度工具
    const progress = await session.invokeTool("report_subagent_progress", { text: "已冻结契约", phase: "contracts" });
    expect(progress.ok).toBe(true);
    expect(h.progressEvents.map((event) => event.text)).toContain("已冻结契约");
    await waitUntil(() => h.messageEvents.some((event) => event.messageType === "progress"));

    // 结果工具
    const result = await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    expect(result.ok).toBe(true);
    await waitUntil(() => h.terminals.length > 0);
    expect(h.terminals[0]).toMatchObject({ runId: RUN_ID, status: "succeeded", reasonCode: null });

    const run = h.runs.get(RUN_ID, ownership());
    expect(run?.status).toBe("succeeded");
    expect(run?.result?.disposition).toBe("satisfied");
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.leaseBootId).toBeNull(); // 终态清 Lease

    // result message + mailbox
    const resultMessages = h.messages.listByThread(THREAD_ID, ownership()).filter((message) => message.envelope.messageType === "result");
    expect(resultMessages).toHaveLength(1);
    const dataPart = resultMessages[0]?.envelope.parts.find((part) => part.kind === "data");
    expect(dataPart?.kind).toBe("data");
    expect((dataPart as { value: SubagentResultV1 }).value.disposition).toBe("satisfied");

    const mailboxRows = h.db.prepare("SELECT * FROM subagent_parent_mailbox WHERE run_id = ?").all(RUN_ID) as Array<{ notification_kind: string; trigger_parent_turn: number }>;
    // §14.1：Run started 写入不唤醒父 Turn 的状态 Mailbox（started 行，
    // trigger_parent_turn=0），终态另写 completed 行（trigger_parent_turn=1）
    expect(mailboxRows).toHaveLength(2);
    expect(mailboxRows.some((row) => row.notification_kind === "started" && row.trigger_parent_turn === 0)).toBe(true);
    const completed = mailboxRows.find((row) => row.notification_kind === "completed");
    expect(completed?.trigger_parent_turn).toBe(1);

    session.finish();
  });
});

describe("SubagentRuntimeHost：内部控制工具", () => {
  it("schema 校验失败 → resolve ok:false，Run 不终态", async () => {
    const h = createHarness();
    h.submit({});
    h.scheduler.submit(executeInput());
    const session = await waitForSession(h.factory);

    const badResult = await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, { ...resultArgs(), disposition: "bogus" });
    expect(badResult.ok).toBe(false);
    const badInput = await session.invokeTool(REQUEST_PARENT_INPUT_TOOL, { question: "", reason: "", expectedAnswerType: "text" });
    expect(badInput.ok).toBe(false);
    expect(h.runs.get(RUN_ID, ownership())?.status).toBe("running");
    expect(h.terminals).toHaveLength(0);
    session.finish();
  });

  it("report_subagent_result 唯一：第二次调用拒绝", async () => {
    const h = createHarness();
    h.submit({});
    h.scheduler.submit(executeInput());
    const session = await waitForSession(h.factory);

    const first = await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    expect(first.ok).toBe(true);
    await waitUntil(() => h.terminals.length > 0);
    const second = await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs("partial"));
    expect(second.ok).toBe(false);
    expect(h.runs.get(RUN_ID, ownership())?.result?.disposition).toBe("satisfied"); // 首次结果未被覆盖
    session.finish();
  });

  it("request_parent_input → waiting_for_input + input_required 消息；恢复后 result → succeeded", async () => {
    const h = createHarness();
    const inputLimits = { ...SUBAGENT_RUN_LIMITS_DEFAULTS, idleTimeoutMs: 1000 };
    h.submit({ limits: inputLimits });
    h.scheduler.submit(executeInput(inputLimits));
    const session = await waitForSession(h.factory);

    const request = await session.invokeTool(REQUEST_PARENT_INPUT_TOOL, { question: "是否需要写 Lease？", reason: "任务决策", expectedAnswerType: "choice", choices: ["是", "否"] });
    expect(request.ok).toBe(true);
    await waitUntil(() => h.runs.get(RUN_ID, ownership())?.status === "waiting_for_input");
    expect(h.messageEvents.some((event) => event.messageType === "input_required")).toBe(true);
    expect(h.runs.get(RUN_ID, ownership())?.status).toBe("waiting_for_input");
    // §8.4：input_required 原子写入可唤醒父 Turn 的 Mailbox（trigger_parent_turn=1）
    const inputMailbox = h.db.prepare("SELECT notification_kind, trigger_parent_turn FROM subagent_parent_mailbox WHERE run_id = ?").all(RUN_ID) as Array<{ notification_kind: string; trigger_parent_turn: number }>;
    expect(inputMailbox.some((row) => row.notification_kind === "input_required" && row.trigger_parent_turn === 1)).toBe(true);

    // waiting 期间 idle 暂停：超过 idleTimeoutMs 不终态
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(h.terminals).toHaveLength(0);

    // 父回答恢复（waiting_for_input → running）后提交结果（succeeded 恢复路径）
    h.host.resumeFromInput(RUN_ID, "否，不需要写 Lease", ownership(), new Date(Date.now() + 1000).toISOString());
    await waitUntil(() => h.runs.get(RUN_ID, ownership())?.status === "running");
    const result = await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    expect(result.ok).toBe(true);
    await waitUntil(() => h.terminals.length > 0);
    expect(h.terminals[0]?.status).toBe("succeeded");
    session.finish();
  });
});

describe("SubagentRuntimeHost：确定性保护（§15.2）", () => {
  it("total timeout → timed_out/subagent_timeout_total", async () => {
    const h = createHarness();
    const totalLimits = { ...SUBAGENT_RUN_LIMITS_DEFAULTS, totalRunTimeoutMs: 1000, providerFirstEventTimeoutMs: 5000, idleTimeoutMs: 5000 };
    h.submit({ limits: totalLimits });
    h.scheduler.submit(executeInput(totalLimits));
    await waitForSession(h.factory);
    await waitUntil(() => h.terminals.length > 0, 3000);
    expect(h.terminals[0]).toMatchObject({ status: "timed_out", reasonCode: SUBAGENT_TIMEOUT_REASON_CODES.total });
    expect(h.runs.get(RUN_ID, ownership())?.status).toBe("timed_out");
  });

  it("first-event timeout → timed_out/subagent_timeout_first_event", async () => {
    const h = createHarness();
    const firstEventLimits = { ...SUBAGENT_RUN_LIMITS_DEFAULTS, totalRunTimeoutMs: 5000, providerFirstEventTimeoutMs: 1000, idleTimeoutMs: 5000 };
    h.submit({ limits: firstEventLimits });
    h.scheduler.submit(executeInput(firstEventLimits));
    await waitForSession(h.factory);
    await waitUntil(() => h.terminals.length > 0, 3000);
    expect(h.terminals[0]?.reasonCode).toBe(SUBAGENT_TIMEOUT_REASON_CODES.firstEvent);
  });

  it("idle timeout（活动后超时）→ timed_out/subagent_timeout_idle", async () => {
    const h = createHarness();
    const idleLimits = { ...SUBAGENT_RUN_LIMITS_DEFAULTS, totalRunTimeoutMs: 5000, providerFirstEventTimeoutMs: 5000, idleTimeoutMs: 1000 };
    h.submit({ limits: idleLimits });
    h.scheduler.submit(executeInput(idleLimits));
    const session = await waitForSession(h.factory);
    session.emit({ type: "first-event" }); // 取消 first-event 计时
    session.emit({ type: "model-iteration", iteration: 1 });
    await waitUntil(() => h.terminals.length > 0, 3000);
    expect(h.terminals[0]?.reasonCode).toBe(SUBAGENT_TIMEOUT_REASON_CODES.idle);
  });

  it("tool-call 超限 → budget_exhausted/subagent_budget_tool_calls", async () => {
    const h = createHarness();
    const toolCallLimits = { ...SUBAGENT_RUN_LIMITS_DEFAULTS, totalRunTimeoutMs: 5000, maxToolCalls: 2 };
    h.submit({ limits: toolCallLimits });
    h.scheduler.submit(executeInput(toolCallLimits));
    const session = await waitForSession(h.factory);
    session.emit({ type: "first-event" });
    session.emit({ type: "tool-call", toolCallId: "tc-1", name: "read_file" });
    session.emit({ type: "tool-call", toolCallId: "tc-2", name: "read_file" });
    await waitUntil(() => h.terminals.length > 0, 3000);
    expect(h.terminals[0]?.reasonCode).toBe(SUBAGENT_BUDGET_REASON_CODES.toolCalls);
    expect(h.runs.get(RUN_ID, ownership())?.status).toBe("budget_exhausted");
  });

  it("迭代超限 → budget_exhausted/subagent_budget_iterations", async () => {
    const h = createHarness();
    const iterationLimits = { ...SUBAGENT_RUN_LIMITS_DEFAULTS, totalRunTimeoutMs: 5000, maxModelIterations: 3 };
    h.submit({ limits: iterationLimits });
    h.scheduler.submit(executeInput(iterationLimits));
    const session = await waitForSession(h.factory);
    session.emit({ type: "first-event" });
    session.emit({ type: "model-iteration", iteration: 3 });
    await waitUntil(() => h.terminals.length > 0, 3000);
    expect(h.terminals[0]?.reasonCode).toBe(SUBAGENT_BUDGET_REASON_CODES.iterations);
  });

  it("startup 超时（Session 创建卡住）→ timed_out/subagent_timeout_startup", async () => {
    const h = createHarness();
    h.submit({ limits: { ...SUBAGENT_RUN_LIMITS_DEFAULTS, totalRunTimeoutMs: 5000, startupTimeoutMs: 1000 } });
    const neverFactory: SubagentSessionFactory = {
      create(): Promise<SubagentSessionPort> {
        return new Promise(() => {
          // 永不 resolve
        });
      },
    };
    const stalled = new SubagentRuntimeHost({
      runs: h.runs,
      messages: h.messages,
      transactions: h.transactions,
      sessionFactory: neverFactory,
      bootId: "boot-1",
      onTerminal: (event) => h.terminals.push({ runId: event.runId, status: event.status, reasonCode: event.reasonCode }),
      onRunProgress: (event) => h.progressEvents.push({ runId: event.runId, text: event.text }),
    });
    trackedHosts.push(stalled);
    const scheduler = new SubagentScheduler({ host: stalled });
    scheduler.submit(executeInput({ ...SUBAGENT_RUN_LIMITS_DEFAULTS, totalRunTimeoutMs: 5000, startupTimeoutMs: 1000 }));
    await waitUntil(() => h.terminals.length > 0, 3000);
    expect(h.terminals[0]?.reasonCode).toBe(SUBAGENT_TIMEOUT_REASON_CODES.startup);
    expect(h.runs.get(RUN_ID, ownership())?.status).toBe("timed_out");
  });
});

describe("SubagentRuntimeHost：缺失 result 终态（§13.3）", () => {
  it("模型两次结束仍未调用 report_subagent_result → failed/subagent_result_not_reported", async () => {
    const h = createHarness();
    h.submit({});
    h.scheduler.submit(executeInput());
    const session = await waitForSession(h.factory);
    session.emit({ type: "first-event" });

    // 第一次结束 → 提醒一次（followUp），会话继续
    session.emit({ type: "terminal", reason: "completed" });
    await waitUntil(() => session.followUpMessages.length === 1);
    expect(h.terminals).toHaveLength(0);
    expect(session.followUpMessages[0]).toContain("report_subagent_result");

    // 第二次结束 → failed/subagent_result_not_reported
    session.emit({ type: "terminal", reason: "completed" });
    await waitUntil(() => h.terminals.length > 0);
    expect(h.terminals[0]).toMatchObject({ status: "failed", reasonCode: "subagent_result_not_reported" });
    expect(h.runs.get(RUN_ID, ownership())?.status).toBe("failed");
    const mailboxRows = h.db.prepare("SELECT notification_kind FROM subagent_parent_mailbox WHERE run_id = ?").all(RUN_ID) as Array<{ notification_kind: string }>;
    // started 行 + failed 终态行（§14.1：started 不唤醒父 Turn）
    expect(mailboxRows.some((row) => row.notification_kind === "failed")).toBe(true);
    session.finish();
  });
});

describe("SubagentRuntimeHost：heartbeat / Lease 丢失（§15.4）", () => {
  it("Lease 丢失 → onLeaseLost + 停止写状态（无终态写库）", async () => {
    const h = createHarness();
    h.submit({});
    h.scheduler.submit(executeInput());
    const session = await waitForSession(h.factory);
    session.emit({ type: "first-event" });

    // 模拟被其他 boot 接管：改 lease_boot_id
    h.db.prepare("UPDATE subagent_runs SET lease_boot_id = 'boot-other' WHERE run_id = ?").run(RUN_ID);
    await waitUntil(() => h.leaseLostRuns.length > 0, 3000);
    expect(h.leaseLostRuns).toContain(RUN_ID);
    expect(session.aborted).toBe(true);

    // 停止写：后续事件不产生任何状态变化/终态
    await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.terminals).toHaveLength(0);
    const run = h.runs.get(RUN_ID, ownership());
    expect(run?.status).toBe("running"); // 未被终态化（恢复由启动恢复处理）
    session.finish();
  });

  it("正常心跳续租：Lease 保持持有", async () => {
    const h = createHarness();
    h.submit({});
    h.scheduler.submit(executeInput());
    const session = await waitForSession(h.factory);
    session.emit({ type: "first-event" });
    await new Promise((resolve) => setTimeout(resolve, 60)); // 3 个心跳周期
    const run = h.runs.get(RUN_ID, ownership());
    expect(run?.leaseBootId).toBe("boot-1");
    expect(run?.leaseHolderId).toBe("subagent-host");
    expect(h.leaseLostRuns).toHaveLength(0);
    // 正常收敛
    await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    await waitUntil(() => h.terminals.length > 0);
    expect(h.terminals[0]?.status).toBe("succeeded");
    session.finish();
  });
});

describe("SubagentRuntimeHost：快照/启动失败 fail-closed", () => {
  it("startWithSnapshot 冲突（Run 已被接管）→ 不终态化，保持原状态", async () => {
    const h = createHarness();
    h.submit({});
    // 模拟恢复流程已把 Run 置为 starting（CAS 冲突）
    h.db.prepare("UPDATE subagent_runs SET status = 'starting' WHERE run_id = ?").run(RUN_ID);
    h.scheduler.submit(executeInput());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.terminals).toHaveLength(0);
    expect(h.factory.sessions).toHaveLength(0); // 未创建 Session
    const run = h.runs.get(RUN_ID, ownership());
    expect(run?.status).toBe("starting"); // 保持原状（恢复流程兜底）
    expect(h.progressEvents.some((event) => event.text.includes("启动失败"))).toBe(true);
  });

  it("Session 创建失败 → failed/subagent_operation_failed", async () => {
    const h = createHarness();
    h.submit({});
    h.factory.failCreate = new Error("provider unavailable");
    h.scheduler.submit(executeInput());
    await waitUntil(() => h.terminals.length > 0, 3000);
    expect(h.terminals[0]).toMatchObject({ status: "failed", reasonCode: "subagent_operation_failed" });
    const run = h.runs.get(RUN_ID, ownership());
    expect(run?.status).toBe("failed");
    expect(run?.reasonCode).toBe("subagent_operation_failed"); // 安全摘要：不暴露内部细节
  });
});

describe("SubagentScheduler：容量控制", () => {
  it("capacity 满 → 排队；终态后自动启动下一个（FIFO）", async () => {
    let capacityOne: SubagentScheduler;
    const h = createHarness({
      onTerminal: (event) => {
        h.terminals.push({ runId: event.runId, status: event.status, reasonCode: event.reasonCode });
      },
      onRunFinished: () => capacityOne.onRunTerminal(), // 容量释放 → 启动排队 Run
    });
    capacityOne = new SubagentScheduler({ host: h.host, capacity: 1 });
    // 两个 Thread（不同 runId）
    const second = (runId: SubagentRunId) => {
      h.transactions.createThreadWithFirstRun(
        {
          thread: {
            threadId: "sat_thread00002" as SubagentThreadId,
            title: "T4 second",
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
          ownership: ownership("agent-a", "sess-2"),
          firstRun: { runId, triggerMessageId: "sam_trigger00002" as AgentMessageId },
          taskEnvelope: {
            ...taskEnvelope(),
            messageId: "sam_trigger00002" as AgentMessageId,
            contextId: "sat_thread00002" as SubagentThreadId,
            taskId: runId,
            recipient: { kind: "subagent", id: runId },
          },
          now: NOW,
        },
      );
    };
    h.submit({});
    second("sar_run000002" as SubagentRunId);

    const first = capacityOne.submit(executeInput());    expect(first).toEqual({ status: "accepted", queued: false });
    const secondSubmit = capacityOne.submit({ ...executeInput(), runId: "sar_run000002" as SubagentRunId, threadId: "sat_thread00002" as SubagentThreadId, ownership: ownership("agent-a", "sess-2") });
    expect(secondSubmit).toEqual({ status: "accepted", queued: true });
    expect(capacityOne.queuedCount).toBe(1);

    const session1 = await waitForSession(h.factory);
    // 第一个完成 → 容量释放 → 第二个启动
    await session1.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    session1.finish(); // 模型提交结果后结束会话（start resolve → host cleanup → 容量释放）
    await waitUntil(() => h.terminals.length > 0);
    await waitUntil(() => capacityOne.queuedCount === 0);
    expect(h.factory.sessions).toHaveLength(2);
    const session2 = h.factory.sessions[1];
    expect(session2?.startInput).not.toBeNull();
    // 第二个完成
    await session2?.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    session2?.finish();
    await waitUntil(() => h.runs.get("sar_run000002" as SubagentRunId, ownership("agent-a", "sess-2"))?.status === "succeeded");
  });

  it("同一 Run 重复提交拒绝；排队超限 → subagent_runtime_unavailable", () => {
    const h = createHarness();
    h.submit({});
    const scheduler = new SubagentScheduler({ host: h.host, capacity: 1 });
    expect(scheduler.submit(executeInput()).status).toBe("accepted");
    expect(scheduler.submit(executeInput()).status).toBe("rejected"); // 重复
    expect(scheduler.submit(executeInput()).status).toBe("rejected"); // 重复（排队检查同样拒绝）
    // 排队超限：capacity 1 且 host 上 run1 在跑——用不同 runId 填满队列
    const other = (n: number) => ({ ...executeInput(), runId: `sar_queue0000${n}` as SubagentRunId, threadId: `sat_queue0000${n}` as SubagentThreadId });
    for (let i = 0; i < 8; i += 1) {
      expect(scheduler.submit(other(i + 1)).status).toBe("accepted");
    }
    const overflow = scheduler.submit(other(99));
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected") {
      expect(overflow.reasonCode).toBe("subagent_runtime_unavailable");
    }
  });});

async function waitForSession(factory: FauxSessionFactory): Promise<FauxSessionPort> {
  await waitUntil(() => factory.sessions.length > 0);
  return factory.latest();
}
