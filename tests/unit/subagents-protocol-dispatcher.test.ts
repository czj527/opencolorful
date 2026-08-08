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
  ProtocolDispatcher,
  extractSteerInstruction,
  type SubagentRuntimeDispatchPort,
} from "../../src/runtime/subagents/protocol/protocol-dispatcher.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：协议 Dispatcher 测试（plans/phase-14.md §8.2 / §13.4 / §25.2）
//
// 覆盖：
// - store-first：消息先落库（Store），Dispatcher 只做 delivery 状态流转与
//   Runtime 应用；投递失败不删除记录（可重试）；
// - task 消息由 Run 消费记账；steer queue → followUp / interrupt → steer /
//   answer_input → resumeFromInput（§13.4）；
// - steer 到 queued/starting Run → deferred，激活后按 sequence 结算；
// - cancel：active → Host.cancelRun；queued → 直接终态化（§16.4 #5）+
//   Scheduler 移除；终态 Run 迟到消息结算 delivered；
// - 幂等：messageId 重放不重复执行；非法 steer data part 拒绝（§8.3）。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-dispatcher-"));
  temporaryDirectories.push(dir);
  const db = openMetadataDatabase(path.join(dir, "metadata.db"));
  openDatabases.push(db);
  return db;
}

afterEach(() => {
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

class FakeRuntimePort implements SubagentRuntimeDispatchPort {
  readonly delivered: Array<{ runId: SubagentRunId; messageType: "steer" | "cancel"; deliveryMode: string; instruction: string | null }> = [];
  notActive = false;
  readonly resumeCalls: Array<{ runId: SubagentRunId; answerText: string }> = [];
  resumeOk = true;

  deliverParentMessage(
    input: { runId: SubagentRunId; messageType: "steer" | "cancel"; deliveryMode: "queue" | "interrupt" | "immediate" | "mailbox"; instruction: string | null },
    _ownership: SubagentOwnership,
  ): "applied" | "deferred" | "not-active" {
    this.delivered.push(input);
    return this.notActive ? "not-active" : "applied";
  }

  resumeFromInput(runId: SubagentRunId, answerText: string, _ownership: SubagentOwnership): boolean {
    this.resumeCalls.push({ runId, answerText });
    return this.resumeOk;
  }
}

interface Harness {
  readonly db: Database.Database;
  readonly runs: RunStore;
  readonly messages: MessageStore;
  readonly transactions: SubagentTransactions;
  readonly mailboxStore: ParentMailboxStore;
  readonly port: FakeRuntimePort;
  readonly scheduler: { readonly removed: SubagentRunId[]; remove(runId: SubagentRunId): boolean };
  readonly dispatcher: ProtocolDispatcher;
  append(envelope: Omit<AgentMessageEnvelopeV1, "sequence">): AgentMessageId;
  markRunning(): void;
  markWaiting(): void;
  markTerminal(): void;
}

function taskEnvelope(): Omit<AgentMessageEnvelopeV1, "sequence"> {
  return {
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
    metadata: { createdAt: NOW, traceId: "trace-t5", schemaName: "subagent.task" },
  };
}

function steerEnvelope(runId: SubagentRunId, action = "redirect", deliveryMode: "queue" | "interrupt" = "queue"): Omit<AgentMessageEnvelopeV1, "sequence"> {
  return {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId: `sam_steer${Math.random().toString(36).slice(2, 14)}` as AgentMessageId,
    contextId: THREAD_ID,
    taskId: runId,
    sender: { kind: "parent_agent", id: "agent-a" },
    recipient: { kind: "subagent", id: runId },
    messageType: "steer",
    deliveryMode,
    parts: [
      {
        kind: "data",
        schema: "subagent.steer.v1",
        value: { version: 1, targetRunId: runId, action, instruction: "请补充证据", reason: "证据不足", preserveCompletedWork: true, deliveryMode },
      },
    ],
    metadata: { createdAt: NOW, traceId: "trace-t5", schemaName: "subagent.steer" },
  };
}

function cancelEnvelope(runId: SubagentRunId): Omit<AgentMessageEnvelopeV1, "sequence"> {
  return {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId: `sam_cancel${Math.random().toString(36).slice(2, 14)}` as AgentMessageId,
    contextId: THREAD_ID,
    taskId: runId,
    sender: { kind: "parent_agent", id: "agent-a" },
    recipient: { kind: "subagent", id: runId },
    messageType: "cancel",
    deliveryMode: "interrupt",
    parts: [{ kind: "text", text: "停止当前 Run" }],
    metadata: { createdAt: NOW, traceId: "trace-t5", schemaName: "subagent.cancel" },
  };
}

function createHarness(): Harness {
  const db = createDatabase();
  const threadStore = new ThreadStore(db);
  const runs = new RunStore(db, threadStore);
  const messages = new MessageStore(db, threadStore);
  const mailboxStore = new ParentMailboxStore(db);
  const transactions = new SubagentTransactions(db, { threadStore, runStore: runs, messageStore: messages, mailboxStore });
  const port = new FakeRuntimePort();
  const scheduler = { removed: [] as SubagentRunId[], remove(runId: SubagentRunId): boolean { this.removed.push(runId); return true; } };
  const dispatcher = new ProtocolDispatcher({
    runs,
    messages,
    transactions,
    runtime: port,
    scheduler,
    retryBaseDelayMs: 15,
    retryMaxDelayMs: 40,
  });
  transactions.createThreadWithFirstRun({
    thread: {
      threadId: THREAD_ID,
      title: "T5 dispatcher",
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
    taskEnvelope: taskEnvelope(),
    now: NOW,
  });
  return {
    db,
    runs,
    messages,
    transactions,
    mailboxStore,
    port,
    scheduler,
    dispatcher,
    append(envelope) {
      return messages.append({ envelope, ownership: OWNERSHIP, createdAt: NOW }).message.messageId;
    },
    markRunning() {
      runs.transit({ runId: RUN_ID, from: "queued", to: "starting", reasonCode: null, now: NOW }, OWNERSHIP);
      runs.transit({ runId: RUN_ID, from: "starting", to: "running", reasonCode: null, now: NOW }, OWNERSHIP);
    },
    markWaiting() {
      this.markRunning();
      runs.transit({ runId: RUN_ID, from: "running", to: "waiting_for_input", reasonCode: null, now: NOW }, OWNERSHIP);
    },
    markTerminal() {
      this.markRunning();
      runs.transit({ runId: RUN_ID, from: "running", to: "succeeded", reasonCode: null, now: NOW }, OWNERSHIP);
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

describe("ProtocolDispatcher：task 消息（store-first 记账）", () => {
  it("task 消息 dispatch → delivered（Run 存在即视为由 Run 消费）", () => {
    const h = createHarness();
    const messageId = h.append(taskEnvelope());
    const outcome = h.dispatcher.dispatch(messageId, OWNERSHIP);
    expect(outcome.status).toBe("delivered");
    expect(h.messages.get(messageId, OWNERSHIP)?.deliveryStatus).toBe("delivered");
    expect(h.messages.get(messageId, OWNERSHIP)?.consumedAt).not.toBeNull();
  });
});

describe("ProtocolDispatcher：steer 投递（§13.4）", () => {
  it("queue → followUp（Host deliverParentMessage，instruction 来自 SubagentSteerV1 data part）", () => {
    const h = createHarness();
    h.markRunning();
    const messageId = h.append(steerEnvelope(RUN_ID, "redirect", "queue"));
    const outcome = h.dispatcher.dispatch(messageId, OWNERSHIP);
    expect(outcome.status).toBe("delivered");
    expect(h.port.delivered).toHaveLength(1);
    expect(h.port.delivered[0]).toMatchObject({ runId: RUN_ID, messageType: "steer", deliveryMode: "queue", instruction: "请补充证据" });
  });

  it("interrupt → steer", () => {
    const h = createHarness();
    h.markRunning();
    const messageId = h.append(steerEnvelope(RUN_ID, "redirect", "interrupt"));
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("delivered");
    expect(h.port.delivered[0]?.deliveryMode).toBe("interrupt");
  });

  it("answer_input → resumeFromInput（回答内容投递）", () => {
    const h = createHarness();
    h.markWaiting();
    const messageId = h.append(steerEnvelope(RUN_ID, "answer_input", "queue"));
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("delivered");
    expect(h.port.resumeCalls).toEqual([{ runId: RUN_ID, answerText: "请补充证据" }]);
  });

  it("steer 到 queued Run → deferred；激活后重试结算 delivered（不丢失）", async () => {
    const h = createHarness();
    const messageId = h.append(steerEnvelope(RUN_ID, "redirect", "queue"));
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("deferred");
    expect(h.messages.get(messageId, OWNERSHIP)?.deliveryStatus).toBe("delivering");
    h.markRunning();
    await waitUntil(() => h.messages.get(messageId, OWNERSHIP)?.deliveryStatus === "delivered");
    expect(h.port.delivered).toHaveLength(1);
  });

  it("steer data part 校验失败 → failed（不进入 Runtime，§8.3）；消息保留可诊断", () => {
    const h = createHarness();
    h.markRunning();
    const envelope = steerEnvelope(RUN_ID, "redirect", "queue");
    const bad = { ...envelope, parts: [{ kind: "data" as const, schema: "subagent.steer.v1", value: { action: "bogus" } }] };
    const messageId = h.append(bad);
    const outcome = h.dispatcher.dispatch(messageId, OWNERSHIP);
    expect(outcome.status).toBe("failed");
    expect(h.port.delivered).toHaveLength(0);
    expect(h.messages.get(messageId, OWNERSHIP)?.deliveryStatus).toBe("failed");
  });

  it("steer 到终态 Run → delivered（迟到消息无副作用）", () => {
    const h = createHarness();
    h.markTerminal();
    const messageId = h.append(steerEnvelope(RUN_ID, "redirect", "queue"));
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("delivered");
    expect(h.port.delivered).toHaveLength(0);
  });

  it("text-only steer（无 data part）→ 文本按 queue 语义投递", () => {
    const h = createHarness();
    h.markRunning();
    const envelope = steerEnvelope(RUN_ID, "redirect", "queue");
    const textOnly = { ...envelope, parts: [{ kind: "text" as const, text: "改为分析模式" }] };
    const messageId = h.append(textOnly);
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("delivered");
    expect(h.port.delivered[0]?.instruction).toBe("改为分析模式");
  });
});

describe("ProtocolDispatcher：cancel 投递（§13.4 / §16.4 #5）", () => {
  it("cancel 到 running Run → 交给 Host（deliverParentMessage cancel）→ delivered", () => {
    const h = createHarness();
    h.markRunning();
    const messageId = h.append(cancelEnvelope(RUN_ID));
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("delivered");
    expect(h.port.delivered).toEqual([{ runId: RUN_ID, messageType: "cancel", deliveryMode: "interrupt", instruction: null }]);
  });

  it("cancel 到 queued Run → 直接终态化 cancelled + status message + mailbox，并移除 Scheduler 排队项", () => {
    const h = createHarness();
    const messageId = h.append(cancelEnvelope(RUN_ID));
    const outcome = h.dispatcher.dispatch(messageId, OWNERSHIP);
    expect(outcome.status).toBe("delivered");
    expect(h.runs.get(RUN_ID, OWNERSHIP)?.status).toBe("cancelled");
    expect(h.runs.get(RUN_ID, OWNERSHIP)?.reasonCode).toBe("subagent_cancelled_by_parent");
    expect(h.scheduler.removed).toEqual([RUN_ID]);
    // terminal message + mailbox（cancelled 不触发父 Turn，与 Host 终态语义一致）
    const messages = h.messages.listByThread(THREAD_ID, OWNERSHIP);
    expect(messages.some((m) => m.messageType === "status")).toBe(true);
    const mailboxRows = h.mailboxStore.listByRun(RUN_ID, OWNERSHIP);
    expect(mailboxRows.some((row) => row.notificationKind === "cancelled" && row.triggerParentTurn === false)).toBe(true);
  });

  it("cancel 到终态 Run → delivered（迟到结算）", () => {
    const h = createHarness();
    h.markTerminal();
    const messageId = h.append(cancelEnvelope(RUN_ID));
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("delivered");
    expect(h.port.delivered).toHaveLength(0);
  });
});

describe("ProtocolDispatcher：幂等与重放（§25.2）", () => {
  it("delivered 重放 → already-delivered，不重复执行副作用", () => {
    const h = createHarness();
    h.markRunning();
    const messageId = h.append(steerEnvelope(RUN_ID, "redirect", "queue"));
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("delivered");
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("already-delivered");
    expect(h.port.delivered).toHaveLength(1);
  });

  it("store-first：投递失败的消息保留在 Store（可重试，不删除）", () => {
    const h = createHarness();
    h.markRunning();
    const envelope = steerEnvelope(RUN_ID, "redirect", "queue");
    const bad = { ...envelope, parts: [{ kind: "data" as const, schema: "subagent.steer.v1", value: { action: "bogus" } }] };
    const messageId = h.append(bad);
    expect(h.dispatcher.dispatch(messageId, OWNERSHIP).status).toBe("failed");
    expect(h.messages.get(messageId, OWNERSHIP)).not.toBeNull();
  });

  it("retryPending：delivering 遗留（崩溃窗口）在 Run 终态后结算为 delivered", async () => {
    const h = createHarness();
    const messageId = h.append(steerEnvelope(RUN_ID, "redirect", "queue"));
    h.dispatcher.dispatch(messageId, OWNERSHIP); // deferred（queued）
    expect(h.messages.get(messageId, OWNERSHIP)?.deliveryStatus).toBe("delivering");
    h.markTerminal(); // 崩溃恢复后 Run 已是终态
    const { retried } = h.dispatcher.retryPending();
    expect(retried).toBeGreaterThan(0);
    expect(h.messages.get(messageId, OWNERSHIP)?.deliveryStatus).toBe("delivered");
  });
});

describe("extractSteerInstruction（§8.3 data part 校验）", () => {
  it("合法 SubagentSteerV1 → 提取 action/instruction", () => {
    const parsed = extractSteerInstruction(steerEnvelope(RUN_ID, "add_constraint", "interrupt").parts);
    expect(parsed).toEqual({ action: "add_constraint", instruction: "请补充证据", reason: "证据不足" });
  });

  it("未知 schema data part + 文本 → 文本投递", () => {
    const parsed = extractSteerInstruction([{ kind: "text", text: "hello" }, { kind: "data", schema: "subagent.result.v1", value: {} }]);
    expect(parsed?.instruction).toBe("hello");
  });

  it("无任何可解析内容 → null", () => {
    expect(extractSteerInstruction([{ kind: "data", schema: "subagent.result.v1", value: {} }])).toBeNull();
  });
});
