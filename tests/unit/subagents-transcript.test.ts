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
  type SubagentCapabilitySummary,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import {
  ArtifactStore,
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentStoreError,
  SubagentTransactions,
  ThreadStore,
  type CreateSubagentThreadInput,
  type SubagentOwnership,
} from "../../src/runtime/subagents/stores/index.js";
import {
  SubagentNotFound,
  SubagentTranscriptView,
  projectMessage,
  type SubagentTranscriptMessage,
} from "../../src/runtime/subagents/transcript/transcript-view.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Thread Transcript 投影测试（plans/phase-14.md §17.1 / §11.3）
//
// - 完整会话投影（thread + runs + 消息 + artifacts + TaskBrief/ContextPacket
//   快照）；
// - 消息分页（afterSequence/limit、truncated、nextSequence）与 SSE cursor 分离；
// - 大输出（多消息、60KB text part）分页读取不截断、不丢消息；
// - §22.1 归属过滤（跨归属抛 subagent_ownership_denied、不存在抛 NotFound）；
// - Thread 关闭后 transcript 只读投影仍可用（§11.3）。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-transcript-"));
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

function ownership(agent = "agent-a", session = "sess-main"): SubagentOwnership {
  return { ownerAgentId: agent, parentSessionId: session };
}

function ceiling(): SubagentCapabilitySummary {
  return {
    ceilingHash: "hash12345678",
    workspaceAccess: "read",
    toolIds: [],
    pluginContributionIds: [],
    skillRefs: [],
    network: "inherit",
    fixedDenials: [],
  };
}

const THREAD_ID = "sat_thread00001" as SubagentThreadId;
const RUN_ID = "sar_run0000001" as SubagentRunId;
const TRIGGER_MESSAGE_ID = "sam_trigger1" as AgentMessageId;

interface Harness {
  readonly db: Database.Database;
  readonly transactions: SubagentTransactions;
  readonly messages: MessageStore;
  readonly runs: RunStore;
  readonly artifacts: ArtifactStore;
  readonly threads: ThreadStore;
  readonly view: SubagentTranscriptView;
}

function createHarness(): Harness {
  const db = createDatabase();
  const threads = new ThreadStore(db);
  const runs = new RunStore(db, threads);
  const messages = new MessageStore(db, threads);
  const artifacts = new ArtifactStore(db, threads);
  const transactions = new SubagentTransactions(db, {
    threadStore: threads,
    runStore: runs,
    messageStore: messages,
    mailboxStore: new ParentMailboxStore(db),
  });
  const view = new SubagentTranscriptView({ threads, runs, messages, artifacts });
  return { db, transactions, messages, runs, artifacts, threads, view };
}

function taskEnvelope(parts: AgentMessageEnvelopeV1["parts"]): Omit<AgentMessageEnvelopeV1, "sequence"> {
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
    parts,
    metadata: { createdAt: NOW, traceId: "trace-parent-turn-1", schemaName: "subagent.task" },
  };
}

function threadInput(threadId: SubagentThreadId = THREAD_ID): CreateSubagentThreadInput {
  return {
    threadId,
    ownerAgentId: "agent-a",
    parentSessionId: "sess-main",
    createdFromTurnId: "turn-parent-1",
    title: "Research task",
    modelProviderId: "faux",
    modelId: "faux-1",
    modelSource: "user_default",
    thinkingLevel: "normal",
    workspaceCwd: "/workspace",
    capabilityCeiling: ceiling(),
    contextPacketHash: "hash12345678",
    createdAt: NOW,
  };
}

function createThreadWithTask(h: Harness, envelope: Omit<AgentMessageEnvelopeV1, "sequence">) {
  return h.transactions.createThreadWithFirstRun({
    thread: threadInput(),
    ownership: ownership(),
    firstRun: { runId: RUN_ID, triggerMessageId: TRIGGER_MESSAGE_ID },
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    taskEnvelope: envelope,
    now: NOW,
  });
}

function resultArgs(): SubagentResultV1 {
  return {
    version: 1,
    disposition: "satisfied",
    summary: "任务完成",
    criteria: [{ criterion: "c1", status: "met", evidenceRefs: ["ref-1"] }],
    artifacts: [],
    unresolvedIssues: [],
    recommendedNextAction: "accept",
  };
}

function envelopeOf(
  h: Harness,
  overrides: Partial<Omit<AgentMessageEnvelopeV1, "sequence">> = {},
): Omit<AgentMessageEnvelopeV1, "sequence"> {
  return {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId: `sam_msg${Math.random().toString(36).slice(2, 10)}` as AgentMessageId,
    contextId: THREAD_ID,
    taskId: RUN_ID,
    sender: { kind: "subagent", id: RUN_ID },
    recipient: { kind: "parent_agent", id: "agent-a" },
    messageType: "progress",
    deliveryMode: "immediate",
    parts: [{ kind: "text", text: "进展" }],
    metadata: { createdAt: NOW, traceId: `trace-${RUN_ID}`, schemaName: "subagent.progress" },
    ...overrides,
  };
}

// ── 用例 ────────────────────────────────────────────────────────

describe("SubagentTranscriptView：完整会话投影", () => {
  it("thread + runs + 消息 + artifacts + TaskBrief/ContextPacket 快照", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([
      { kind: "data", schema: "subagent.task_brief.v1", value: {
        version: 1, title: "调研", objective: "调研 X", successCriteria: ["完成"],
        deliverables: ["报告"], context: [], constraints: ["只读"], nonGoals: [],
        executionMode: "research", reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "references" },
      } },
      { kind: "data", schema: "subagent.context_packet.v1", value: {
        version: 1, userRequest: "调研 X", parentSummary: "", messageRefs: [],
        resources: [], knownFacts: [], unresolvedQuestions: [],
      } },
    ]));
    // 追加一条 progress 消息
    h.messages.append({ envelope: envelopeOf(h), ownership: ownership(), createdAt: NOW });

    const transcript = h.view.getTranscript(THREAD_ID, ownership());
    expect(transcript.thread.title).toBe("Research task");
    expect(transcript.thread.ownerAgentId).toBe("agent-a");
    expect(transcript.runs).toHaveLength(1);
    expect(transcript.runs[0]?.runId).toBe(RUN_ID);
    expect(transcript.messages).toHaveLength(2); // task + progress
    expect(transcript.messages[0]?.messageType).toBe("task");
    expect(transcript.messages[1]?.messageType).toBe("progress");
    expect(transcript.taskBrief?.objective).toBe("调研 X");
    expect(transcript.contextPacket?.userRequest).toBe("调研 X");
    expect(transcript.nextMessageSequence).toBe(2); // cursor = 最后已投递 sequence
    expect(transcript.truncated).toBe(false);
    expect(transcript.artifacts).toEqual([]);
  });

  it("快照缺失时 taskBrief/contextPacket 为 null（简报只存在于 Prompt）", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([{ kind: "text", text: "研究并汇报" }]));
    const transcript = h.view.getTranscript(THREAD_ID, ownership());
    expect(transcript.taskBrief).toBeNull();
    expect(transcript.contextPacket).toBeNull();
  });

  it("损坏的 data part（非 TypeBox 合法）不进入快照", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([
      { kind: "data", schema: "subagent.task_brief.v1", value: { not: "a brief" } },
    ]));
    const transcript = h.view.getTranscript(THREAD_ID, ownership());
    expect(transcript.taskBrief).toBeNull();
  });

  it("projectMessage 投影保留全部 part 类型（text/data/context_ref/artifact_ref）", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([{ kind: "text", text: "start" }]));
    const record = h.messages.append({
      envelope: envelopeOf(h, {
        parts: [
          { kind: "text", text: "hello" },
          { kind: "data", schema: "custom.v1", value: { a: 1 } },
          { kind: "context_ref", ref: { kind: "workspace_file", relativePath: "a/b.md", contentHash: "hash12345678" } },
          { kind: "artifact_ref", ref: { artifactId: "saa_artifact1", name: "out.txt", contentHash: "hash12345678" } },
        ],
      }),
      ownership: ownership(),
      createdAt: NOW,
    }).message;
    const projected = projectMessage(record);
    expect(projected.parts).toHaveLength(4);
    expect(projected.parts[0]).toEqual({ kind: "text", text: "hello" });
    expect(projected.parts[1]).toEqual({ kind: "data", schema: "custom.v1", value: { a: 1 } });
    expect(projected.parts[2]?.kind).toBe("context_ref");
    expect(projected.parts[3]?.kind).toBe("artifact_ref");
    expect(projected.traceId).toBe(`trace-${RUN_ID}`);
  });
});

describe("SubagentTranscriptView：分页与大输出", () => {
  it("多消息按 afterSequence 分页，truncated/nextSequence 正确", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([{ kind: "text", text: "start" }]));
    for (let index = 0; index < 10; index += 1) {
      h.messages.append({ envelope: envelopeOf(h), ownership: ownership(), createdAt: NOW });
    }
    const page1 = h.view.listMessages(THREAD_ID, ownership(), { afterSequence: 0, limit: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page1.truncated).toBe(true);
    expect(page1.items[0]?.sequence).toBe(1);
    expect(page1.items[4]?.sequence).toBe(5);
    expect(page1.nextSequence).toBe(5); // cursor = 本页最后已投递 sequence

    const page2 = h.view.listMessages(THREAD_ID, ownership(), { afterSequence: page1.nextSequence, limit: 10 });
    expect(page2.items).toHaveLength(6); // seq 6..11，不重不漏
    expect(page2.truncated).toBe(false);
    expect(page2.items[0]?.sequence).toBe(6);
    expect(page2.items[5]?.sequence).toBe(11);
  });

  it("大输出（60KB text part + 数百消息）分页读取不丢、不截断正文", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([{ kind: "text", text: "start" }]));
    const bigText = "A".repeat(60 * 1024);
    h.messages.append({
      envelope: envelopeOf(h, { parts: [{ kind: "text", text: bigText }] }),
      ownership: ownership(),
      createdAt: NOW,
    });
    const page = h.view.listMessages(THREAD_ID, ownership(), { afterSequence: 0, limit: 10 });
    const big = page.items.find((message) => message.sequence === 2);
    expect(big).toBeDefined();
    const textPart = big?.parts.find((part) => part.kind === "text");
    expect(textPart?.kind === "text" && textPart.text).toHaveLength(60 * 1024);
  });

  it("终态 result 消息（data part）原样投影", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([{ kind: "text", text: "start" }]));
    // queued → starting → running（状态机合法路径），再收敛 succeeded
    h.runs.transit({ runId: RUN_ID, from: "queued", to: "starting", reasonCode: null, now: NOW }, ownership());
    h.runs.transit({ runId: RUN_ID, from: "starting", to: "running", reasonCode: null, now: NOW }, ownership());
    h.transactions.completeRunWithResult({
      runId: RUN_ID,
      threadId: THREAD_ID,
      ownership: ownership(),
      from: "running",
      to: "succeeded",
      result: resultArgs(),
      reasonCode: null,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      resultEnvelope: envelopeOf(h, {
        messageType: "result",
        deliveryMode: "mailbox",
        parts: [{ kind: "data", schema: "subagent.result.v1", value: resultArgs() }],
      }),
      mailbox: {
        mailboxId: "smb_mailbox00001" as import("../../src/contracts/subagents.js").ParentMailboxId,
        messageId: "sam_result1" as AgentMessageId,
        notificationKind: "completed",
        operationId: `op-${RUN_ID}`,
        triggerParentTurn: true,
      },
      now: NOW,
    });
    const transcript = h.view.getTranscript(THREAD_ID, ownership());
    const resultMessage = transcript.messages.find((message) => message.messageType === "result");
    expect(resultMessage).toBeDefined();
    expect(resultMessage?.parts[0]).toMatchObject({ kind: "data", schema: "subagent.result.v1" });
    expect(transcript.runs[0]?.status).toBe("succeeded");
    expect(transcript.runs[0]?.result?.disposition).toBe("satisfied");
  });
});

describe("SubagentTranscriptView：归属与只读语义", () => {
  it("跨 Agent/Session 归属 → subagent_ownership_denied", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([{ kind: "text", text: "start" }]));
    expect(() => h.view.getTranscript(THREAD_ID, ownership("agent-b", "sess-main"))).toThrow(SubagentStoreError);
    try {
      h.view.getTranscript(THREAD_ID, ownership("agent-b", "sess-main"));
    } catch (error) {
      expect((error as SubagentStoreError).code).toBe("subagent_ownership_denied");
    }
  });

  it("Thread 不存在 → SubagentNotFound", () => {
    const h = createHarness();
    expect(() => h.view.getTranscript("sat_nonexist001" as SubagentThreadId, ownership())).toThrow(SubagentNotFound);
  });

  it("Thread 关闭后 transcript 仍可只读投影（§11.3）", () => {
    const h = createHarness();
    createThreadWithTask(h, taskEnvelope([{ kind: "text", text: "start" }]));
    // queued → cancelled（合法边），使 Thread 无活动 Run 后 closeThread 直接 closed
    h.runs.transit({ runId: RUN_ID, from: "queued", to: "cancelled", reasonCode: "user", now: NOW }, ownership());
    const closed = h.transactions.closeThread({
      threadId: THREAD_ID,
      ownership: ownership(),
      at: NOW,
      closeReason: "user closed",
    });
    expect(closed.closedNow).toBe(true);
    const transcript = h.view.getTranscript(THREAD_ID, ownership());
    expect(transcript.thread.status).toBe("closed");
    expect(transcript.messages.length).toBeGreaterThan(0);
  });
});
