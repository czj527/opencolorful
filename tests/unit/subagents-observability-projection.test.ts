import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { ProducerContext } from "../../src/contracts/observability.js";
import {
  SUBAGENT_MESSAGE_PROTOCOL,
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentSnapshotId,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ActivityRecorder } from "../../src/observability/activity-recorder.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { ObservabilityQuery } from "../../src/observability/observability-query.js";
import {
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
  type SubagentOwnership,
} from "../../src/runtime/subagents/stores/index.js";
import { REPORT_SUBAGENT_RESULT_TOOL } from "../../src/runtime/subagents/runtime/internal-tools.js";
import { SubagentRuntimeHost, type ExecuteSubagentRunInput, type SubagentRuntimeHostDeps } from "../../src/runtime/subagents/runtime/runtime-host.js";
import type {
  SubagentSessionEvent,
  SubagentSessionFactory,
  SubagentSessionPort,
  SubagentSessionStartInput,
  SubagentToolInvokeResult,
} from "../../src/runtime/subagents/runtime/types.js";
import {
  SubagentObservabilityProjector,
  wireSubagentRuntimeObservability,
} from "../../src/runtime/subagents/observability/subagent-observability-projector.js";
import { SubagentReplayStore } from "../../src/runtime/subagents/transcript/replay-store.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Activity/Audit/Trace 自动埋点测试（plans/phase-14.md §19）
//
// - 目录事件名冻结：投影只使用 subagent-events.ts 已注册事件（Recorder 拒绝
//   未注册事件，天然验证）；
// - run.progress 限频（同一 Run ≥30s 一条，§19.2）；
// - 终态映射：succeeded→completed、timed_out/budget_exhausted→failed+reasonCode；
// - scope 列持久：activity_events.subagent_thread_id/subagent_run_id 可过滤
//   （/logs?subagent= 基础，§19.5）；
// - auditMirror：thread.created/run.completed 同事务写 audit_events；
// - Trace：run 生命周期共享确定性 spanId（§19.4）；
// - 端到端：wireSubagentRuntimeObservability + RuntimeHost + FauxSession 全链
//   （onMessage/onTerminal 投影）。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];
const trackedHosts: SubagentRuntimeHost[] = [];

const producer: ProducerContext = {
  component: "unit-test",
  processType: "server",
  processId: "1",
  bootId: "boot-test",
  appVersion: "0.0.0-test",
  hostPlatform: "win32",
};

function createDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-obs-"));
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

function ownership(agent = "agent-a", session = "sess-main"): SubagentOwnership {
  return { ownerAgentId: agent, parentSessionId: session };
}

const THREAD_ID = "sat_thread00001" as SubagentThreadId;
const RUN_ID = "sar_run0000001" as SubagentRunId;
const TRIGGER_MESSAGE_ID = "sam_trigger1" as AgentMessageId;

interface Harness {
  readonly db: Database.Database;
  readonly recorder: ActivityRecorder;
  readonly audit: AuditRecorder;
  readonly query: ObservabilityQuery;
  readonly projector: SubagentObservabilityProjector;
  readonly replay: SubagentReplayStore;
  readonly transactions: SubagentTransactions;
  readonly runs: RunStore;
  readonly messages: MessageStore;
}

function createHarness(progressMinIntervalMs = 30_000): Harness {
  const db = createDatabase();
  const threads = new ThreadStore(db);
  const runs = new RunStore(db, threads);
  const messages = new MessageStore(db, threads);
  const transactions = new SubagentTransactions(db, {
    threadStore: threads,
    runStore: runs,
    messageStore: messages,
    mailboxStore: new ParentMailboxStore(db),
  });
  const recorder = new ActivityRecorder({ database: db, producer });
  const audit = new AuditRecorder({ database: db, producer });
  const replay = new SubagentReplayStore(db);
  const projector = new SubagentObservabilityProjector({
    activity: recorder,
    replay,
    runs,
    progressMinIntervalMs,
    now: () => new Date(NOW),
  });
  return { db, recorder, audit, query: new ObservabilityQuery(db), projector, replay, transactions, runs, messages };
}

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
    metadata: { createdAt: NOW, traceId: "trace-parent-1", schemaName: "subagent.task" },
  };
}

function createThread(h: Harness) {
  return h.transactions.createThreadWithFirstRun({
    thread: {
      threadId: THREAD_ID,
      title: "obs test",
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
      createdFromTurnId: "turn-parent-1",
    },
    ownership: ownership(),
    firstRun: { runId: RUN_ID, triggerMessageId: TRIGGER_MESSAGE_ID },
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    taskEnvelope: taskEnvelope(),
    now: NOW,
  });
}

function envelopeOf(h: Harness, overrides: Partial<Omit<AgentMessageEnvelopeV1, "sequence">> = {}): Omit<AgentMessageEnvelopeV1, "sequence"> {
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
    parts: [{ kind: "text", text: "进展文本" }],
    metadata: { createdAt: NOW, traceId: "trace-parent-1", schemaName: "subagent.progress" },
    ...overrides,
  };
}

function resultArgs(): SubagentResultV1 {
  return {
    version: 1,
    disposition: "satisfied",
    summary: "任务完成",
    criteria: [
      { criterion: "c1", status: "met", evidenceRefs: [] },
      { criterion: "c2", status: "unmet", evidenceRefs: [] },
    ],
    artifacts: [],
    unresolvedIssues: [],
    recommendedNextAction: "accept",
  };
}

// ── 用例 ────────────────────────────────────────────────────────

describe("SubagentObservabilityProjector：生命周期埋点", () => {
  it("thread.created + run.queued/started 投影；scope 列持久可过滤（§19.5）", () => {
    const h = createHarness();
    const created = createThread(h);
    h.projector.projectThreadCreated(created.thread, ownership());
    h.projector.projectRunQueued(created.run, ownership());
    const run = h.runs.get(RUN_ID, ownership())!;
    h.projector.projectRunStarted(run, ownership());

    const rows = h.query.queryActivities({ subagentThreadId: THREAD_ID }, null, 50).items;
    const eventNames = rows.map((row) => row.eventName).sort();
    expect(eventNames).toContain("subagent.thread.created");
    expect(eventNames).toContain("subagent.run.queued");
    expect(eventNames).toContain("subagent.run.started");
    for (const row of rows) {
      expect(row.subagentThreadId).toBe(THREAD_ID);
    }
    const startedRow = rows.find((row) => row.eventName === "subagent.run.started");
    expect(startedRow?.subagentRunId).toBe(RUN_ID);
    expect(startedRow?.ownerAgentId).toBe("agent-a");
    expect(startedRow?.status).toBe("started");

    // auditMirror：thread.created → audit.subagent.spawn_completed 同事务落库
    const auditRows = h.query.queryAudit({ subagentThreadId: THREAD_ID }, null, 50).items;
    expect(auditRows.some((row) => row.eventName === "audit.subagent.spawn_completed")).toBe(true);
    for (const row of auditRows) {
      expect(row.subagentThreadId).toBe(THREAD_ID);
    }
  });

  it("终态映射：succeeded→subagent.run.completed(completed)；timed_out→failed+reasonCode", () => {
    const h = createHarness();
    const created = createThread(h);
    h.projector.projectThreadCreated(created.thread, ownership());
    h.projector.projectRunStarted(created.run, ownership());
    h.projector.projectRunTerminal(RUN_ID, THREAD_ID, "succeeded", null, resultArgs());

    const completed = h.query.queryActivities({ eventName: "subagent.run.completed" }, null, 10).items;
    expect(completed[0]?.status).toBe("completed");
    expect(completed[0]?.subagentRunId).toBe(RUN_ID);
    const payload = JSON.parse(completed[0]?.payloadJson ?? "{}") as { metrics?: Record<string, unknown> };
    expect(payload.metrics).toMatchObject({ disposition: "satisfied", criteriaMet: 1, criteriaTotal: 2, artifactCount: 0, recommendedNextAction: "accept" });

    // timed_out：独立 Thread/Run（同 operationId 唯一终态约束）
    const thread2 = "sat_thread00002" as SubagentThreadId;
    const run2 = "sar_run0000002" as SubagentRunId;
    h.transactions.createThreadWithFirstRun({
      thread: {
        threadId: thread2,
        title: "obs timeout",
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
        createdFromTurnId: "turn-parent-2",
      },
      ownership: ownership(),
      firstRun: { runId: run2, triggerMessageId: "sam_trigger2" as AgentMessageId },
      limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
      taskEnvelope: {
        protocol: SUBAGENT_MESSAGE_PROTOCOL,
        version: 1,
        messageId: "sam_trigger2" as AgentMessageId,
        contextId: thread2,
        taskId: run2,
        sender: { kind: "parent_agent", id: "agent-a" },
        recipient: { kind: "subagent", id: run2 },
        messageType: "task",
        deliveryMode: "immediate",
        parts: [{ kind: "text", text: "t2" }],
        metadata: { createdAt: NOW, traceId: "trace-parent-2", schemaName: "subagent.task" },
      },
      now: NOW,
    });
    h.projector.registerOwnership(thread2, ownership());
    h.projector.projectRunTerminal(run2, thread2, "timed_out", "subagent_timeout_total", null);
    const timedOut = h.query.queryActivities({ eventName: "subagent.run.timed_out" }, null, 10).items;
    expect(timedOut[0]?.status).toBe("failed");
    const attributes = JSON.parse(timedOut[0]?.payloadJson ?? "{}") as { attributes?: Record<string, unknown> };
    expect(attributes.attributes).toMatchObject({ reasonCode: "subagent_timeout_total" });
    expect(timedOut[0]?.subagentRunId).toBe(run2);
  });

  it("run.progress 限频：同一 Run 30s 内只写一条（§19.2）；Tool delta 不落 durable", () => {
    const h = createHarness(30_000);
    createThread(h);
    const m1 = h.messages.append({ envelope: envelopeOf(h), ownership: ownership(), createdAt: NOW }).message;
    const m2 = h.messages.append({ envelope: envelopeOf(h), ownership: ownership(), createdAt: NOW }).message;
    h.projector.projectMessage(m1);
    h.projector.projectMessage(m2); // 30s 内第二条 → 限频跳过
    const progressRows = h.query.queryActivities({ eventName: "subagent.run.progress" }, null, 10).items;
    expect(progressRows).toHaveLength(1);

    // message.queued 每条都写（routine，payload 只含摘要）
    const queuedRows = h.query.queryActivities({ eventName: "subagent.message.queued" }, null, 10).items;
    expect(queuedRows).toHaveLength(2);

    // Tool delta 不落 Activity 表（§17.2），只进 replay
    h.projector.projectToolActivity({
      toolCallId: "tc-1",
      threadId: THREAD_ID,
      runId: RUN_ID,
      toolName: "read_file",
      status: "completed",
      startedAt: NOW,
      inputSummary: "path=./a.txt",
    });
    expect(h.query.queryActivities({ eventName: "subagent.artifact.created" }, null, 10).items).toHaveLength(0);
    const toolEvents = h.replay.getSince(THREAD_ID, 0).events.filter((event) => event.event.kind === "tool");
    expect(toolEvents).toHaveLength(1);
  });

  it("onMessage 投影 progress 消息：message.queued + run.progress + replay 广播", () => {
    const h = createHarness(0);
    createThread(h);
    const record = h.messages.append({ envelope: envelopeOf(h), ownership: ownership(), createdAt: NOW }).message;
    h.projector.onMessage({ runId: RUN_ID, message: record });
    const progressRows = h.query.queryActivities({ eventName: "subagent.run.progress" }, null, 10).items;
    expect(progressRows).toHaveLength(1);
    const replay = h.replay.getSince(THREAD_ID, 0);
    expect(replay.events.some((event) => event.event.kind === "message")).toBe(true);
    // trace 传播：run 事件使用 task 消息的 traceId
    const queued = h.query.queryActivities({ eventName: "subagent.message.queued" }, null, 10).items;
    expect(queued[0]?.traceId).toBe("trace-parent-1");
  });

  it("onLeaseLost → subagent.runtime.lease_lost", () => {
    const h = createHarness();
    createThread(h);
    h.projector.registerOwnership(THREAD_ID, ownership());
    h.projector.onLeaseLost({ runId: RUN_ID });
    const rows = h.query.queryActivities({ eventName: "subagent.runtime.lease_lost" }, null, 10).items;
    expect(rows).toHaveLength(1);
  });

  it("artifact.created / integrity_failed 投影", () => {
    const h = createHarness();
    createThread(h);
    h.projector.registerOwnership(THREAD_ID, ownership());
    h.projector.projectArtifactCreated({
      artifactId: "saa_artifact1" as never,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "a.txt",
      mimeType: "text/plain",
      contentHash: "hash12345678",
      sizeBytes: 10,
      resourceKind: "subagent_artifact",
      resourceId: "saa_artifact1",
      canonicalPath: null,
      visibility: "parent",
      createdAt: NOW,
    }, ownership());
    h.projector.projectArtifactIntegrityFailed({
      artifactId: "saa_artifact1",
      threadId: THREAD_ID,
      runId: RUN_ID,
      expectedHash: "hash12345678",
      reason: "contentHash mismatch",
    });
    const created = h.query.queryActivities({ eventName: "subagent.artifact.created" }, null, 10).items;
    expect(created).toHaveLength(1);
    expect(created[0]?.targetKind).toBe("subagent_artifact");
    const failed = h.query.queryActivities({ eventName: "subagent.artifact.integrity_failed" }, null, 10).items;
    expect(failed).toHaveLength(1);
  });

  it("投影 best-effort：Recorder 拒绝未注册事件不抛给调用方", () => {
    const h = createHarness();
    createThread(h);
    // 直接驱动 activity() 私有路径不可行——用未注册事件名验证 tryRecord 不抛
    const recorder = h.recorder;
    const result = recorder.append({
      eventName: "subagent.events.not_registered",
      payload: { summaryCode: "x" },
      actor: { kind: "system", id: "test" },
      executor: { kind: "service", id: "test" },
    });
    expect(result.kind).toBe("rejected");
  });
});

// ── 端到端：wireSubagentRuntimeObservability + RuntimeHost ─────

class FauxSessionPort implements SubagentSessionPort {
  readonly sessionId: string;
  readonly listeners = new Set<(event: SubagentSessionEvent) => void>();
  private resolveStart: (() => void) | null = null;
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  start(_input: SubagentSessionStartInput): Promise<void> {
    return new Promise((resolve) => {
      this.resolveStart = resolve;
    });
  }
  followUp(): void {}
  steer(): void {}
  abort(): void {}
  dispose(): void {}
  onEvent(listener: (event: SubagentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: SubagentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  invokeTool(name: string, args: unknown): Promise<SubagentToolInvokeResult> {
    return new Promise((resolve) => {
      this.emit({ type: "tool-invoke", toolCallId: `tc-${Math.random().toString(36).slice(2)}`, name, args, resolve });
    });
  }
  finish(): void {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    resolve?.();
  }
}

class FauxSessionFactory implements SubagentSessionFactory {
  readonly sessions: FauxSessionPort[] = [];
  create(): Promise<SubagentSessionPort> {
    const session = new FauxSessionPort(`faux-${this.sessions.length + 1}`);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
  latest(): FauxSessionPort {
    return this.sessions[this.sessions.length - 1]!;
  }
}

function createHostHarness(progressMinIntervalMs = 30_000) {
  const db = createDatabase();
  const threads = new ThreadStore(db);
  const runs = new RunStore(db, threads);
  const messages = new MessageStore(db, threads);
  const transactions = new SubagentTransactions(db, {
    threadStore: threads,
    runStore: runs,
    messageStore: messages,
    mailboxStore: new ParentMailboxStore(db),
  });
  const recorder = new ActivityRecorder({ database: db, producer });
  const replay = new SubagentReplayStore(db);
  const projector = new SubagentObservabilityProjector({
    activity: recorder,
    replay,
    runs,
    messages,
    progressMinIntervalMs,
    now: () => new Date(NOW),
  });
  const factory = new FauxSessionFactory();
  const baseDeps: SubagentRuntimeHostDeps = {
    runs,
    messages,
    transactions,
    sessionFactory: factory,
    bootId: "boot-1",
    heartbeatIntervalMs: 50,
    runtimeLeaseTtlMs: 120,
  };
  const host = new SubagentRuntimeHost(wireSubagentRuntimeObservability(baseDeps, projector));
  trackedHosts.push(host);
  const created = transactions.createThreadWithFirstRun({
    thread: {
      threadId: THREAD_ID,
      title: "e2e obs",
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
      createdFromTurnId: "turn-parent-1",
    },
    ownership: ownership(),
    firstRun: { runId: RUN_ID, triggerMessageId: TRIGGER_MESSAGE_ID },
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    taskEnvelope: taskEnvelope(),
    now: NOW,
  });
  projector.projectThreadCreated(created.thread, ownership());
  projector.projectRunQueued(created.run, ownership());
  return { db, host, factory, runs, messages, transactions, projector, replay, query: new ObservabilityQuery(db), created };
}

function executeInput(): ExecuteSubagentRunInput {
  return {
    runId: RUN_ID,
    threadId: THREAD_ID,
    ownership: ownership(),
    snapshotId: "sas_snap000001" as SubagentSnapshotId,
    snapshotJson: JSON.stringify({ ceilingHash: "hash12345678" }),
    prompt: "[任务简报] 研究并汇报",
    abilityTools: [],
    sessionDir: "/tmp/sessions",
    workspaceCwd: "/tmp",
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    thinkingLevel: "normal",
    triggerMessageId: TRIGGER_MESSAGE_ID,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("wireSubagentRuntimeObservability：host 回调端到端", () => {
  it("progress 消息 + report_subagent_result → message.queued + run.completed + replay 事件", async () => {
    const h = createHostHarness(0);
    expect(h.host.execute(executeInput())).toEqual({ status: "started" });
    const session = await waitUntil(() => h.factory.sessions.length > 0, 2000).then(() => h.factory.latest());
    const progress = await session.invokeTool("report_subagent_progress", { text: "已冻结契约", phase: "contracts" });
    expect(progress.ok).toBe(true);
    const result = await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, {
      disposition: "satisfied",
      summary: "完成",
      criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }],
      artifacts: [],
      unresolvedIssues: [],
      recommendedNextAction: "accept",
    });
    expect(result.ok).toBe(true);
    session.finish();
    await waitUntil(() => h.query.queryActivities({ eventName: "subagent.run.completed" }, null, 10).items.length > 0);

    const completed = h.query.queryActivities({ eventName: "subagent.run.completed" }, null, 10).items;
    expect(completed[0]?.subagentThreadId).toBe(THREAD_ID);
    expect(completed[0]?.subagentRunId).toBe(RUN_ID);
    expect(completed[0]?.status).toBe("completed");
    const progressRows = h.query.queryActivities({ eventName: "subagent.run.progress" }, null, 10).items;
    expect(progressRows.length).toBeGreaterThanOrEqual(1);
    const messageRows = h.query.queryActivities({ eventName: "subagent.message.queued" }, null, 50).items;
    expect(messageRows.length).toBeGreaterThanOrEqual(2); // progress + result
    // replay：消息与终态 run 事件都广播到面板流
    const replayEvents = h.replay.getSince(THREAD_ID, 0).events;
    expect(replayEvents.some((event) => event.event.kind === "message")).toBe(true);
    expect(replayEvents.some((event) => event.event.kind === "run" && event.event.run.status === "succeeded")).toBe(true);
    // trace：host 追加消息自盖 trace（T4 appendProtocolMessage 用 trace-<runId>），
    // 终态事件继承该 run trace（§19.4；父 Turn trace 由 T6 spawn 路径传入）
    expect(completed[0]?.traceId).toBe(`trace-${RUN_ID}`);
  });

  it("显式 spawn trace 优先：projectRunStarted(trace) 后消息/终态事件不覆盖（first-seen-wins）", () => {
    const h = createHarness();
    const created = createThread(h);
    h.projector.projectRunStarted(created.run, ownership(), { traceId: "spawn-trace-1", spanId: "span-spawn" });
    // 消息携带不同 trace（如 host 占位 trace），不覆盖 spawn trace
    const record = h.messages.append({ envelope: envelopeOf(h), ownership: ownership(), createdAt: NOW }).message;
    h.projector.projectMessage(record);
    h.projector.projectRunTerminal(RUN_ID, THREAD_ID, "succeeded", null, resultArgs());
    const completed = h.query.queryActivities({ eventName: "subagent.run.completed" }, null, 10).items;
    expect(completed[0]?.traceId).toBe("spawn-trace-1");
    const queued = h.query.queryActivities({ eventName: "subagent.message.queued" }, null, 10).items;
    expect(queued[0]?.traceId).toBe("spawn-trace-1");
  });
});
