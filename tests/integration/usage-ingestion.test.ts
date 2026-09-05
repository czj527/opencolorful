import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { AssistantMessage, Model as PiModel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  SUBAGENT_MESSAGE_PROTOCOL,
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  type AgentMessageId,
  type ParentMailboxId,
  type SubagentCapabilitySummary,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import type { PlatformEventEnvelope } from "../../src/contracts/events.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { UsageRecorder, runUtilityCallWithUsage } from "../../src/runtime/usage-recorder.js";
import { createSubagentUsageIngestion } from "../../src/runtime/subagents/runtime/usage-ingestion.js";
import {
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
} from "../../src/runtime/subagents/stores/index.js";
import type { SubagentOwnership } from "../../src/runtime/subagents/stores/types.js";
import { completeUtilityText, isAbortLikeError, UtilityTextCallError } from "../../src/pi-sdk/complete-text.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { UsageStore } from "../../src/storage/usage-store.js";

// ═══════════════════════════════════════════════════════════════
// 波次 A8a 集成测试：三类模型调用（utility / 子代理 / 主会话）统一落
// usage_records（v14）。全部隔离 OPENCOLORFUL_HOME + scripted stub，不真网。
// ═══════════════════════════════════════════════════════════════

interface UsageRow {
  source: string;
  role: string;
  status: string;
  agent_id: string | null;
  session_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  call_id: string | null;
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  started_at: string | null;
  finished_at: string | null;
}

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext(): { home: string; database: Database.Database; usageStore: UsageStore } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-usage-ingestion-"));
  process.env.OPENCOLORFUL_HOME = home;
  temporaryDirectories.push(home);
  void getRuntimePaths({ OPENCOLORFUL_HOME: home });
  const database = openMetadataDatabase(path.join(home, "metadata.db"));
  openDatabases.push(database);
  return { home, database, usageStore: new UsageStore(database) };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // ignore
    }
  }
  delete process.env.OPENCOLORFUL_HOME;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function usageRows(database: Database.Database): UsageRow[] {
  return database
    .prepare(
      "SELECT source, role, status, agent_id, session_id, thread_id, run_id, call_id, provider, model," +
        " input, output, cache_read, cache_write, total_tokens, started_at, finished_at FROM usage_records ORDER BY id",
    )
    .all() as UsageRow[];
}

// ── utility：scripted completeUtilityText + runUtilityCallWithUsage ──

interface ScriptedMessageOverrides {
  readonly stopReason?: "stop" | "length" | "error" | "aborted" | "toolUse";
  readonly errorMessage?: string;
  readonly text?: string;
  readonly usage?: AssistantMessage["usage"] | null;
}

function scriptedAssistantMessage(overrides: ScriptedMessageOverrides = {}): AssistantMessage {
  const base: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: overrides.text ?? "工具调用结果" }],
    api: "faux" as AssistantMessage["api"],
    provider: "faux" as AssistantMessage["provider"],
    model: "faux-1",
    usage: {
      input: 12,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 22,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: overrides.stopReason ?? "stop",
    ...(overrides.errorMessage !== undefined ? { errorMessage: overrides.errorMessage } : {}),
    timestamp: Date.now(),
  };
  if (overrides.usage === null) {
    // 模拟运行时完全未提供账目（类型上 AssistantMessage.usage 必填，运行时可能缺省）
    return { ...base, usage: undefined } as unknown as AssistantMessage;
  }
  if (overrides.usage !== undefined) {
    return { ...base, usage: overrides.usage };
  }
  return base;
}

function scriptedRuntime(message: AssistantMessage | Error): ModelRuntime {
  return {
    completeSimple: async () => {
      if (message instanceof Error) throw message;
      return message;
    },
  } as unknown as ModelRuntime;
}

const SCRIPTED_MODEL = { id: "faux-1", name: "Faux" } as unknown as Parameters<typeof completeUtilityText>[0]["model"];

describe("A8a utility usage ingestion", () => {
  it("completeUtilityText returns text + usage on scripted success", async () => {
    const completion = await completeUtilityText({
      runtime: scriptedRuntime(scriptedAssistantMessage()),
      model: SCRIPTED_MODEL,
      prompt: "汇总",
    });
    expect(completion.text).toBe("工具调用结果");
    expect(completion.usage).not.toBeNull();
    expect(completion.usage?.totalTokens).toBe(22);
  });

  it("completeUtilityText usage is null when runtime provides no account (不伪造 0)", async () => {
    const completion = await completeUtilityText({
      runtime: scriptedRuntime(scriptedAssistantMessage({ usage: null })),
      model: SCRIPTED_MODEL,
      prompt: "汇总",
    });
    expect(completion.text).toBe("工具调用结果");
    expect(completion.usage).toBeNull();
  });

  it("stopReason=error still throws but carries available usage on the Error", async () => {
    const promise = completeUtilityText({
      runtime: scriptedRuntime(
        scriptedAssistantMessage({ stopReason: "error", errorMessage: "配额不足" }),
      ),
      model: SCRIPTED_MODEL,
      prompt: "汇总",
    });
    await expect(promise).rejects.toBeInstanceOf(UtilityTextCallError);
    try {
      await completeUtilityText({
        runtime: scriptedRuntime(scriptedAssistantMessage({ stopReason: "error", errorMessage: "配额不足" })),
        model: SCRIPTED_MODEL,
        prompt: "汇总",
      });
      expect.unreachable("expected throw");
    } catch (error) {
      expect((error as UtilityTextCallError).usage?.totalTokens).toBe(22);
      expect(isAbortLikeError(error)).toBe(false);
    }
  });

  it("abort-like errors are recognizable as cancellation", async () => {
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const promise = completeUtilityText({
      runtime: scriptedRuntime(abortError),
      model: SCRIPTED_MODEL,
      prompt: "汇总",
    });
    await expect(promise).rejects.toThrow();
    try {
      await completeUtilityText({
        runtime: scriptedRuntime(abortError),
        model: SCRIPTED_MODEL,
        prompt: "汇总",
      });
      expect.unreachable("expected throw");
    } catch (error) {
      expect(isAbortLikeError(error)).toBe(true);
    }
  });

  it("runUtilityCallWithUsage lands one row per call status: completed/failed/cancelled", async () => {
    const { database, usageStore } = createContext();
    const ok = await runUtilityCallWithUsage(
      usageStore,
      { agentId: "agent-1", sessionId: "sess-1", provider: "faux", model: "faux-1", role: "secondary" },
      async () => ({ text: "完成", usage: { input: 12, output: 7, cacheRead: 2, cacheWrite: 1, totalTokens: 22 } }),
    );
    expect(ok).toBe("完成");

    await expect(
      runUtilityCallWithUsage(
        usageStore,
        { agentId: "agent-1", sessionId: null, provider: "faux", model: "faux-1", role: "secondary" },
        async () => {
          throw new UtilityTextCallError("LLM 调用失败: stopReason=error", {
            input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
          });
        },
      ),
    ).rejects.toThrow();

    await expect(
      runUtilityCallWithUsage(
        usageStore,
        { agentId: null, sessionId: null, provider: "faux", model: "faux-1", role: "secondary" },
        async () => {
          throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        },
      ),
    ).rejects.toThrow();

    const rows = usageRows(database);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      source: "utility", role: "secondary", status: "completed",
      agent_id: "agent-1", session_id: "sess-1",
      provider: "faux", model: "faux-1",
      input: 12, output: 7, cache_read: 2, cache_write: 1, total_tokens: 22,
    });
    expect(rows[0]?.call_id).not.toBeNull();
    expect(rows[0]?.started_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      source: "utility", status: "failed", total_tokens: 3,
    });
    expect(rows[2]).toMatchObject({
      source: "utility", status: "cancelled", agent_id: null, input: 0, total_tokens: 0,
    });
    // 全局 utility 调用（无会话归属）session_id=null
    expect(rows[1]?.session_id).toBeNull();

    const summary = usageStore.summaryFiltered({ days: 30, source: "utility" });
    expect(summary.byStatus.map((entry) => entry.status).sort()).toEqual(["cancelled", "completed", "failed"]);
  });
});

// ── subagent：Run 终态 → usage_records 摄取 ─────────────────────

const OWNER = "agent-a";
const SESSION_ID = "sess-main";

function ownership(): SubagentOwnership {
  return { ownerAgentId: OWNER, parentSessionId: SESSION_ID };
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

let idSeq = 0;

function envelope(input: {
  messageId: AgentMessageId;
  threadId: SubagentThreadId;
  runId: SubagentRunId;
  messageType?: "task" | "result" | "status";
}): Omit<Parameters<MessageStore["append"]>[0]["envelope"], "sequence"> {
  const senderKind = input.messageType === "task" ? "parent_agent" : input.messageType === "status" ? "system" : "subagent";
  return {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId: input.messageId,
    contextId: input.threadId,
    taskId: input.runId,
    sender: { kind: senderKind, id: senderKind === "parent_agent" ? OWNER : senderKind === "system" ? "subagent-system" : input.runId },
    recipient: { kind: input.messageType === "task" ? "subagent" : "parent_agent", id: input.messageType === "task" ? input.threadId : OWNER },
    messageType: input.messageType ?? "task",
    deliveryMode: input.messageType === "result" || input.messageType === "status" ? "mailbox" : "immediate",
    parts: [{ kind: "text", text: input.messageType === "task" ? "任务简报" : "已结束" }],
    metadata: { createdAt: "2026-09-04T10:00:00.000Z", traceId: "trace-1", schemaName: "test" },
  };
}

interface SubagentHarness {
  readonly database: Database.Database;
  readonly usageStore: UsageStore;
  readonly threads: ThreadStore;
  readonly runs: RunStore;
  readonly transactions: SubagentTransactions;
  createThreadWithRun(): { threadId: SubagentThreadId; runId: SubagentRunId };
  runToRunning(runId: SubagentRunId): void;
}

function createHarness(): SubagentHarness {
  const { database, usageStore } = createContext();
  const threads = new ThreadStore(database);
  const runs = new RunStore(database, threads);
  runs.setTerminalUsageIngestion(createSubagentUsageIngestion({ usageStore, database }));
  const messages = new MessageStore(database, threads);
  const mailbox = new ParentMailboxStore(database);
  const transactions = new SubagentTransactions(database, { threadStore: threads, runStore: runs, messageStore: messages, mailboxStore: mailbox });
  const own = ownership();

  return {
    database,
    usageStore,
    threads,
    runs,
    transactions,
    createThreadWithRun() {
      idSeq += 1;
      const threadId = `sat_ingest${String(idSeq).padStart(8, "0")}` as SubagentThreadId;
      const runId = `sar_ingest${String(idSeq).padStart(8, "0")}` as SubagentRunId;
      const messageId = `sam_ingest${String(idSeq).padStart(8, "0")}` as AgentMessageId;
      transactions.createThreadWithFirstRun({
        thread: {
          threadId,
          title: "研究任务",
          modelProviderId: "faux",
          modelId: "faux-model",
          modelSource: "parent_inherited",
          thinkingLevel: "medium",
          workspaceCwd: "C:/work/demo",
          capabilityCeiling: ceiling(),
          contextPacketHash: "packet-hash-12345678",
          createdFromTurnId: null,
        },
        ownership: own,
        firstRun: { runId, triggerMessageId: messageId },
        limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
        taskEnvelope: envelope({ messageId, threadId, runId, messageType: "task" }),
        now: "2026-09-04T10:00:00.000Z",
      });
      return { threadId, runId };
    },
    runToRunning(runId: SubagentRunId) {
      runs.transit({ runId, from: "queued", to: "starting", reasonCode: null, now: "2026-09-04T10:00:01.000Z" }, own);
      runs.transit({ runId, from: "starting", to: "running", reasonCode: null, now: "2026-09-04T10:00:02.000Z" }, own);
    },
  };
}

describe("A8a subagent terminal usage ingestion", () => {
  it("succeeded run lands a completed subagent row with thread model and usage", () => {
    const harness = createHarness();
    const { threadId, runId } = harness.createThreadWithRun();
    harness.runToRunning(runId);

    harness.runs.completeRun(
      {
        runId,
        from: "running",
        to: "succeeded",
        result: {
          version: 1,
          disposition: "satisfied",
          summary: "完成",
          criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }],
          artifacts: [],
          unresolvedIssues: [],
          recommendedNextAction: "accept",
        },
        reasonCode: null,
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        now: "2026-09-04T10:01:00.000Z",
      },
      ownership(),
    );

    const rows = usageRows(harness.database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "subagent",
      role: "secondary",
      status: "completed",
      agent_id: OWNER,
      session_id: SESSION_ID,
      thread_id: threadId,
      run_id: runId,
      provider: "faux",
      model: "faux-model",
      input: 100,
      output: 40,
      cache_read: 0,
      cache_write: 0,
      total_tokens: 140,
    });
    expect(rows[0]?.started_at).toBeNull(); // started_at 仅由 startWithSnapshot 写入；本用例经 transit 快进，无该事实
    expect(rows[0]?.finished_at).toBe("2026-09-04T10:01:00.000Z");
  });

  it("terminal status mapping: failed→failed, timed_out→timeout, interrupted→interrupted", () => {
    const harness = createHarness();
    const failed = harness.createThreadWithRun();
    harness.runToRunning(failed.runId);
    harness.runs.completeRun(
      { runId: failed.runId, from: "running", to: "failed", result: null, reasonCode: "subagent_operation_failed", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 }, now: "2026-09-04T10:01:00.000Z" },
      ownership(),
    );

    const timedOut = harness.createThreadWithRun();
    harness.runToRunning(timedOut.runId);
    harness.runs.completeRun(
      { runId: timedOut.runId, from: "running", to: "timed_out", result: null, reasonCode: "subagent_timeout_total", usage: null, now: "2026-09-04T10:02:00.000Z" },
      ownership(),
    );

    // interrupted 经生产同款事务路径（completeRunWithResult）
    const interrupted = harness.createThreadWithRun();
    harness.runToRunning(interrupted.runId);
    const messageId = `sam_term${String(idSeq += 1).padStart(8, "0")}` as AgentMessageId;
    const mailboxId = `smb_term${String(idSeq).padStart(8, "0")}` as ParentMailboxId;
    harness.transactions.completeRunWithResult({
      runId: interrupted.runId,
      threadId: interrupted.threadId,
      ownership: ownership(),
      from: "running",
      to: "interrupted",
      result: null,
      reasonCode: "subagent_recovery_interrupted",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      resultEnvelope: envelope({ messageId, threadId: interrupted.threadId, runId: interrupted.runId, messageType: "status" }),
      mailbox: {
        mailboxId,
        messageId,
        notificationKind: "interrupted",
        operationId: `subagent-terminal-${interrupted.runId}`,
        triggerParentTurn: false,
      },
      now: "2026-09-04T10:03:00.000Z",
    });

    const rows = usageRows(harness.database);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ status: "failed", total_tokens: 6 });
    // usage=null → 0（无账目）
    expect(rows[1]).toMatchObject({ status: "timeout", input: 0, output: 0, total_tokens: 0 });
    expect(rows[2]).toMatchObject({ status: "interrupted", total_tokens: 2 });
  });

  it("is idempotent across terminal replay (dedupe run:<runId>)", () => {
    const harness = createHarness();
    const { runId } = harness.createThreadWithRun();
    harness.runToRunning(runId);
    const input = {
      runId,
      from: "running" as const,
      to: "succeeded" as const,
      result: {
        version: 1 as const,
        disposition: "satisfied" as const,
        summary: "完成",
        criteria: [{ criterion: "c1", status: "met" as const, evidenceRefs: [] }],
        artifacts: [],
        unresolvedIssues: [],
        recommendedNextAction: "accept" as const,
      },
      reasonCode: null,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      now: "2026-09-04T10:01:00.000Z",
    };
    harness.runs.completeRun(input, ownership());
    const replay = harness.runs.completeRun(input, ownership());
    expect(replay.idempotent).toBe(true);
    expect(usageRows(harness.database)).toHaveLength(1);
  });

  it("ingestion failure never breaks the run terminal transition", () => {
    const { database } = createContext();
    const threads = new ThreadStore(database);
    const runs = new RunStore(database, threads);
    runs.setTerminalUsageIngestion(() => {
      throw new Error("摄取器崩溃");
    });
    const messages = new MessageStore(database, threads);
    const mailbox = new ParentMailboxStore(database);
    const transactions = new SubagentTransactions(database, { threadStore: threads, runStore: runs, messageStore: messages, mailboxStore: mailbox });
    const own = ownership();
    idSeq += 1;
    const threadId = `sat_boom${String(idSeq).padStart(8, "0")}` as SubagentThreadId;
    const runId = `sar_boom${String(idSeq).padStart(8, "0")}` as SubagentRunId;
    const messageId = `sam_boom${String(idSeq).padStart(8, "0")}` as AgentMessageId;
    transactions.createThreadWithFirstRun({
      thread: {
        threadId, title: "t", modelProviderId: "faux", modelId: "m", modelSource: "parent_inherited",
        thinkingLevel: "medium", workspaceCwd: "C:/w", capabilityCeiling: ceiling(),
        contextPacketHash: "hash12345678", createdFromTurnId: null,
      },
      ownership: own,
      firstRun: { runId, triggerMessageId: messageId },
      taskEnvelope: envelope({ messageId, threadId, runId, messageType: "task" }),
      now: "2026-09-04T10:00:00.000Z",
    });
    runs.transit({ runId, from: "queued", to: "starting", reasonCode: null, now: "2026-09-04T10:00:01.000Z" }, own);
    runs.transit({ runId, from: "starting", to: "running", reasonCode: null, now: "2026-09-04T10:00:02.000Z" }, own);

    const outcome = runs.completeRun(
      { runId, from: "running", to: "failed", result: null, reasonCode: "boom", usage: null, now: "2026-09-04T10:01:00.000Z" },
      own,
    );
    expect(outcome.idempotent).toBe(false);
    const run = runs.get(runId, own);
    expect(run?.status).toBe("failed");
  });
});

// ── 主会话：UsageRecorder 经真实 EventReplayStore 订阅端到端 ────

describe("A8a main session usage ingestion (end-to-end via replay store)", () => {
  it("records completed and failed rows through a real replay subscription", () => {
    const { database, usageStore } = createContext();
    const replayStore = new EventReplayStore();
    const recorder = new UsageRecorder(replayStore, usageStore, () => ({ providerId: "faux", modelId: "faux-1" }), () => "agent-e2e");

    const completed: PlatformEventEnvelope = {
      protocolVersion: 1,
      eventId: "evt-e2e-1",
      sessionId: "sess-e2e",
      streamId: "stream-e2e-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "turn.completed",
      payload: {
        turnId: "turn-e2e-1",
        usage: { input: 9, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
      },
    };
    const failed: PlatformEventEnvelope = {
      protocolVersion: 1,
      eventId: "evt-e2e-2",
      sessionId: "sess-e2e",
      streamId: "stream-e2e-2",
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "turn.failed",
      payload: {
        errorMessage: "模型调用失败",
        turnId: "turn-e2e-2",
        usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
      },
    };
    replayStore.publish(completed);
    replayStore.publish(failed);

    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const rows = usageRows(database);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ source: "main", status: "completed", agent_id: "agent-e2e", total_tokens: 12 });
        expect(rows[1]).toMatchObject({ source: "main", status: "failed", agent_id: "agent-e2e", total_tokens: 5 });
        recorder.dispose();
        resolve();
      });
    });
  });
});
