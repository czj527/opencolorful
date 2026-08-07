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
  type SubagentContextPacketV1,
  type SubagentRunId,
  type SubagentTaskBriefV1,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import {
  ArtifactStore,
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
  WorkspaceLeaseStore,
  type SubagentOwnership,
} from "../../src/runtime/subagents/stores/index.js";
import { SubagentRuntimeHost } from "../../src/runtime/subagents/runtime/runtime-host.js";
import { SubagentScheduler } from "../../src/runtime/subagents/runtime/scheduler.js";
import type {
  SubagentSessionEvent,
  SubagentSessionFactory,
  SubagentSessionPort,
  SubagentSessionStartInput,
  SubagentToolInvokeResult,
} from "../../src/runtime/subagents/runtime/types.js";
import { ProtocolDispatcher } from "../../src/runtime/subagents/protocol/protocol-dispatcher.js";
import { ParentMailboxDeliveryCoordinator } from "../../src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.js";
import { SubagentTranscriptView } from "../../src/runtime/subagents/transcript/transcript-view.js";
import { SubagentArtifactFileService } from "../../src/runtime/subagents/transcript/artifact-files.js";
import { SubagentReplayStore } from "../../src/runtime/subagents/transcript/replay-store.js";
import { SubagentToolActivityTracker } from "../../src/runtime/subagents/transcript/tool-summary.js";
import { registerSubagentContext, type SubagentToolServices } from "../../src/pi-sdk/subagent-tools-context.js";
import subagentToolsExtension from "../../src/pi-sdk/subagent-tools.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T6：主 Agent 七个 Core 工具全链测试（plans/phase-14.md §20.1）
//
// 测试模式与 memory-tools 集成测试一致：扩展 default(pi) 注册到 FakePi，
// 经 registerSubagentContext 注入真实 Stores + Faux Session 的
// Host/Scheduler/Dispatcher，再以 executionContext 直接驱动 execute。
// 覆盖：spawn 全链（模型解析→快照→审计→原子创建→排队执行→子会话
// 提交 result）、失败 fail-closed（模型不可用/参数非法）、status/inspect/
// steer（活动投递 + 终态新建 Run + stop 转 cancel）/wait/cancel/close。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-tools-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  return { paths, database, dir };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// ── Faux Session（T4 模式）──────────────────────────────────────

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

  finish(): void {
    if (this.resolveStart !== null) {
      const resolve = this.resolveStart;
      this.resolveStart = null;
      resolve();
    }
  }

  emit(event: SubagentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  invokeTool(name: string, args: unknown): Promise<SubagentToolInvokeResult> {
    return new Promise((resolve) => {
      this.emit({ type: "tool-invoke", toolCallId: `tc-${Math.random().toString(36).slice(2)}`, name, args, resolve });
    });
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
    const session = this.sessions[this.sessions.length - 1];
    if (session === undefined) throw new Error("no session");
    return session;
  }
}

// ── Harness ─────────────────────────────────────────────────────

const SESSION_ID = "sess-main-t6";
const OWNER = "agent-t6";

interface Harness {
  readonly db: Database.Database;
  readonly stores: ReturnType<typeof createStores>;
  readonly factory: FauxSessionFactory;
  readonly host: SubagentRuntimeHost;
  readonly scheduler: SubagentScheduler;
  readonly services: SubagentToolServices;
  readonly tools: Map<string, { execute(...args: unknown[]): Promise<unknown> }>;
  readonly terminals: Array<{ runId: string; status: string }>;
  runIdOf(threadId: SubagentThreadId): SubagentRunId | null;
  runStatus(runId: SubagentRunId): string | null;
}

function createStores(db: Database.Database) {
  const threads = new ThreadStore(db);
  const runs = new RunStore(db, threads);
  const messages = new MessageStore(db, threads);
  const artifacts = new ArtifactStore(db, threads);
  const mailbox = new ParentMailboxStore(db);
  const transactions = new SubagentTransactions(db, { threadStore: threads, runStore: runs, messageStore: messages, mailboxStore: mailbox });
  return { threads, runs, messages, artifacts, mailbox, transactions };
}

function createHarness(options: { modelAvailable?: boolean } = {}): Harness {
  const { database, paths } = createContext();
  const stores = createStores(database);
  const factory = new FauxSessionFactory();
  const terminals: Harness["terminals"] = [];
  let scheduler: SubagentScheduler;
  const host = new SubagentRuntimeHost({
    runs: stores.runs,
    messages: stores.messages,
    transactions: stores.transactions,
    sessionFactory: factory,
    bootId: "boot-t6",
    onTerminal: (event) => terminals.push({ runId: event.runId, status: event.status }),
    onRunFinished: () => scheduler.onRunTerminal(),
  });
  scheduler = new SubagentScheduler({ host });
  const coordinator = new ParentMailboxDeliveryCoordinator({
    mailboxStore: stores.mailbox,
    messageStore: stores.messages,
    runStore: stores.runs,
    threadStore: stores.threads,
    transactions: stores.transactions,
    cancelRun: (input) => host.cancelRun(input.runId, input.ownership, input.reasonCode),
  });
  const dispatcher = new ProtocolDispatcher({
    messages: stores.messages,
    runs: stores.runs,
    transactions: stores.transactions,
    scheduler,
    runtime: {
      deliverParentMessage: (input, ownership) => host.deliverParentMessage(input, ownership),
      resumeFromInput: (runId, answerText, ownership) => host.resumeFromInput(runId, answerText, ownership, new Date().toISOString()),
    },
  });
  const replay = new SubagentReplayStore(database);
  const toolTracker = new SubagentToolActivityTracker();
  const transcriptView = new SubagentTranscriptView({ threads: stores.threads, runs: stores.runs, messages: stores.messages, artifacts: stores.artifacts });
  const artifactFiles = new SubagentArtifactFileService({
    artifacts: stores.artifacts,
    threads: stores.threads,
    paths,
  });
  const projector = { projectRunQueued: () => undefined, projectThreadCreated: () => undefined, projectArtifactIntegrityFailed: () => undefined } as never;

  const modelAvailable = options.modelAvailable ?? true;
  let seq = 0;
  const newId = (prefix: "sat_" | "sar_" | "sam_" | "saa_" | "smb_" | "sas_"): string => {
    seq += 1;
    return `${prefix}${seq.toString().padStart(12, "0")}`;
  };
  const ownership: SubagentOwnership = { ownerAgentId: OWNER, parentSessionId: SESSION_ID };

  const services: SubagentToolServices = {
    preferences: () => ({ subagents: { defaultModel: null } }),
    currentModel: () => ({ providerId: "faux", modelId: "faux-1" }),
    parentSnapshot: () => ({ toolIds: ["read", "write", "bash"], pluginContributions: [], skillEntries: [] }),
    modelResolver: () => modelAvailable,
    toolCatalog: (name) => (name === "read" ? { name: "read", description: "read", parameters: { type: "object" } } : null),
    workspaceCwd: () => paths.home,
    threadDirResolver: (input) => path.join(paths.subagentsBase, input.ownerAgentId, "subagents", input.threadId),
    threads: stores.threads,
    runs: stores.runs,
    messages: stores.messages,
    artifacts: stores.artifacts,
    mailbox: stores.mailbox,
    leases: new WorkspaceLeaseStore(database),
    transactions: stores.transactions,
    dispatcher,
    coordinator,
    scheduler,
    host,
    transcriptView,
    artifactFiles,
    replay,
    toolTracker,
    projector,
    audit: () => ({ kind: "accepted", eventId: "audit-1", rowId: 1 }),
    available: () => true,
    now: () => Date.now(),
    newId,
  };
  const ctx = { ownerAgentId: OWNER, sessionId: SESSION_ID, turnIdSlot: { current: "turn-1" }, traceSlot: { current: undefined }, services };
  registerSubagentContext(SESSION_ID, ctx);

  // 注册工具（FakePi）
  const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
  const fakePi = {
    registerTool(def: { name: string; execute(...args: unknown[]): Promise<unknown> }) {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  subagentToolsExtension(fakePi);

  return {
    db: database,
    stores,
    factory,
    host,
    scheduler,
    services,
    tools,
    terminals,
    runIdOf(threadId) {
      return stores.runs.listByThread(threadId, ownership).at(-1)?.runId ?? null;
    },
    runStatus(runId) {
      return stores.runs.get(runId, ownership)?.status ?? null;
    },
  };
}

async function callTool(h: Harness, name: string, args: unknown): Promise<Record<string, unknown>> {
  const def = h.tools.get(name);
  if (def === undefined) throw new Error(`tool ${name} not registered`);
  const result = (await def.execute("tc-1", args, undefined, undefined, {
    sessionManager: { getSessionId: () => SESSION_ID },
  })) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function brief(): SubagentTaskBriefV1 {
  return {
    version: 1,
    title: "研究任务",
    objective: "研究 Phase 14 契约",
    successCriteria: ["产出契约清单"],
    deliverables: ["契约清单"],
    context: ["已有 T1-T7 契约"],
    constraints: ["不修改契约"],
    nonGoals: [],
    executionMode: "research",
    reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "references" },
  };
}

function packet(): SubagentContextPacketV1 {
  return {
    version: 1,
    userRequest: "研究并汇报",
    parentSummary: "父 Agent 已完成前置工作",
    messageRefs: [],
    resources: [],
    knownFacts: ["平台为 Windows"],
    unresolvedQuestions: [],
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── 用例 ────────────────────────────────────────────────────────

describe("spawn_subagent", () => {
  it("全链：accepted + Thread/Run/task 消息落库 + 子会话执行到 succeeded", async () => {
    const h = createHarness();
    const out = await callTool(h, "spawn_subagent", { brief: brief(), context: packet(), limits: { maxModelIterations: 4 } });
    expect(out.status).toBe("ok");
    expect(typeof out.threadId).toBe("string");
    expect(typeof out.runId).toBe("string");
    expect(out.queued).toBe(false);

    const threadId = out.threadId as SubagentThreadId;
    const runId = out.runId as SubagentRunId;
    // Thread/Run/消息落库
    expect(h.stores.threads.get(threadId, { ownerAgentId: OWNER, parentSessionId: SESSION_ID })?.title).toBe("研究任务");
    expect(h.runStatus(runId)).toBe("running");
    const messages = h.stores.messages.listByThread(threadId, { ownerAgentId: OWNER, parentSessionId: SESSION_ID });
    const task = messages.find((message) => message.envelope.messageType === "task");
    expect(task).toBeDefined();
    // task 消息 data parts（T7 快照约定）
    const dataParts = task?.envelope.parts.filter((part) => part.kind === "data") ?? [];
    expect(dataParts.map((part) => (part.kind === "data" ? part.schema : ""))).toEqual(["subagent.task_brief.v1", "subagent.context_packet.v1"]);

    // 子会话注入工具（内部三工具 + 能力工具）
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    const toolNames = session.startInput?.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain("report_subagent_result");
    expect(toolNames).toContain("read");
    expect(session.startInput?.prompt).toContain("[任务目标]");

    // 子会话提交结果 → succeeded
    const result = await session.invokeTool("report_subagent_result", {
      disposition: "satisfied",
      summary: "完成",
      criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }],
      artifacts: [],
      unresolvedIssues: [],
      recommendedNextAction: "accept",
    });
    expect(result.ok).toBe(true);
    session.finish();
    await waitUntil(() => h.runStatus(runId) === "succeeded");
    expect(h.stores.runs.get(runId, { ownerAgentId: OWNER, parentSessionId: SESSION_ID })?.result?.disposition).toBe("satisfied");
  });

  it("模型不可用 → subagent_model_unavailable，不创建 Thread", async () => {
    const h = createHarness({ modelAvailable: false });
    const out = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    expect(out.status).toBe("error");
    expect(out.code).toBe("subagent_model_unavailable");
    expect(h.stores.threads.listByOwner({ ownerAgentId: OWNER, parentSessionId: SESSION_ID }, 10)).toHaveLength(0);
  });

  it("参数非法（brief 缺必填）→ subagent_invalid_args", async () => {
    const h = createHarness();
    const out = await callTool(h, "spawn_subagent", { brief: { title: "x" }, context: packet() });
    expect(out.status).toBe("error");
    expect(out.code).toBe("subagent_invalid_args");
  });
});

describe("get_subagent_status / inspect_subagent", () => {
  it("按 threadId 查询 + 列表查询", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const threadId = spawned.threadId as SubagentThreadId;
    const single = await callTool(h, "get_subagent_status", { threadId });
    expect(single.status).toBe("ok");
    expect((single.threads as Array<{ threadId: string; currentRun: { status: string } | null }>)[0]?.currentRun?.status).toBe("running");
    const list = await callTool(h, "get_subagent_status", {});
    expect((list.threads as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("inspect 按 include 返回脱敏观察", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const threadId = spawned.threadId as SubagentThreadId;
    const out = await callTool(h, "inspect_subagent", { threadId, include: ["messages", "result"] });
    expect(out.status).toBe("ok");
    expect((out.messages as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(out.result).toBeNull(); // 尚未终态
  });
});

describe("steer_subagent", () => {
  it("活动 Run：steer 消息落库 + dispatcher 投递", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const runId = spawned.runId as SubagentRunId;
    const out = await callTool(h, "steer_subagent", {
      version: 1,
      targetRunId: runId,
      action: "add_constraint",
      instruction: "请补充 Windows 路径测试",
      reason: "目标平台为 Windows",
      preserveCompletedWork: true,
      deliveryMode: "queue",
    });
    expect(out.status).toBe("ok");
    expect(out.newRunId).toBeNull();
    const session = h.factory.latest();
    await waitUntil(() => session.followUpMessages.length === 0 || session.steerMessages.length > 0 || session.followUpMessages.length > 0);
    // queue → followUp 投递
    await waitUntil(() => session.followUpMessages.length > 0);
    expect(session.followUpMessages[0]).toContain("Windows");
  });

  it("终态 Run + open Thread：创建下一 Run", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const firstRunId = spawned.runId as SubagentRunId;
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    await session.invokeTool("report_subagent_result", {
      disposition: "satisfied", summary: "完成", criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }], artifacts: [], unresolvedIssues: [], recommendedNextAction: "accept",
    });
    session.finish();
    await waitUntil(() => h.runStatus(firstRunId) === "succeeded");

    const out = await callTool(h, "steer_subagent", {
      version: 1,
      targetRunId: firstRunId,
      action: "redirect",
      instruction: "改为研究 B 方案",
      reason: "需求变更",
      preserveCompletedWork: true,
      deliveryMode: "queue",
    });
    expect(out.status).toBe("ok");
    expect(out.newRunId).not.toBeNull();
    const newRunId = out.newRunId as SubagentRunId;
    expect(h.runStatus(newRunId)).toBe("running");
    expect(h.stores.runs.get(newRunId, { ownerAgentId: OWNER, parentSessionId: SESSION_ID })?.triggerMessageId).toContain("sam_");
  });

  it("stop 动作 → cancel 路径", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const runId = spawned.runId as SubagentRunId;
    const out = await callTool(h, "steer_subagent", {
      version: 1,
      targetRunId: runId,
      action: "stop",
      instruction: "停止该任务",
      reason: "不再需要",
      preserveCompletedWork: true,
      deliveryMode: "interrupt",
    });
    expect(out.status).toBe("ok");
    await waitUntil(() => h.runStatus(runId) === "cancelled");
  });
});

describe("wait_subagent / cancel_subagent / close_subagent", () => {
  it("wait：目标已终态 → 立即返回", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const threadId = spawned.threadId as SubagentThreadId;
    const runId = spawned.runId as SubagentRunId;
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    await session.invokeTool("report_subagent_result", {
      disposition: "satisfied", summary: "完成", criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }], artifacts: [], unresolvedIssues: [], recommendedNextAction: "accept",
    });
    session.finish();
    await waitUntil(() => h.runStatus(runId) === "succeeded");
    const out = await callTool(h, "wait_subagent", { threadIds: [threadId], timeoutMs: 10000 });
    expect(out.status).toBe("ok");
    const entry = (out.threads as Record<string, { runStatus: string }>)[threadId];
    expect(entry?.runStatus).toBe("succeeded");
  });

  it("cancel：取消消息 + dispatcher → cancelled（幂等）", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const threadId = spawned.threadId as SubagentThreadId;
    const runId = spawned.runId as SubagentRunId;
    const out = await callTool(h, "cancel_subagent", { threadId, reason: "任务不再需要" });
    expect(out.status).toBe("ok");
    await waitUntil(() => h.runStatus(runId) === "cancelled");
    const again = await callTool(h, "cancel_subagent", { threadId, reason: "again" });
    expect(again.alreadyTerminal).toBe(true);
  });

  it("close：无活动 Run 直接 closed（幂等）", async () => {
    const h = createHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const threadId = spawned.threadId as SubagentThreadId;
    const runId = spawned.runId as SubagentRunId;
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    await session.invokeTool("report_subagent_result", {
      disposition: "satisfied", summary: "完成", criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }], artifacts: [], unresolvedIssues: [], recommendedNextAction: "accept",
    });
    session.finish();
    await waitUntil(() => h.runStatus(runId) === "succeeded");
    const out = await callTool(h, "close_subagent", { threadId });
    expect(out.status).toBe("ok");
    expect(out.closedNow).toBe(true);
    const again = await callTool(h, "close_subagent", { threadId });
    expect(again.idempotent).toBe(true);
    // 关闭后仍可观察历史
    const status = await callTool(h, "get_subagent_status", { threadId });
    expect(status.status).toBe("ok");
  });
});
