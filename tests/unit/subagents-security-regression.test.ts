import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T9b：安全回归测试（plans/phase-14.md §25.4-25.7 剩余项）
//
// 覆盖（均为已覆盖清单之外的安全缺口）：
// 1. memory/personality 隔离（§11 / §25.3）：Subagent 工具注册表只有内部
//    三工具+能力工具；主会话记忆工具在 Subagent 上下文调用 fail-closed；
//    systemPrompt 恒为平台规则（SUBAGENT_SYSTEM_PROMPT），不注入父人格/记忆；
// 2. write Lease 与父 Agent 互斥（§18.3 / §25.4）：同进程（同 bootId）不同
//    持有者互斥（T3 service 修复）；write Run 启动获取/终态释放独占 Lease；
//    read Run 不获取；父 permit 占用时 write Run fail-closed 拒绝；父侧
//    sandbox write/edit/bash 执行入口 guard 占用中拒绝；
// 3. cross-agent/session 隔离（§22.1 / §25.7）：另一 ownerAgentId 查询/
//    steer/cancel/close → subagent_ownership_denied（不泄露存在性）；未注册
//    Session 调用工具 fail-closed；
// 4. audit fail-closed（§22.5 / §25.7）：spawn started 审计 rejected/抛错 →
//    拒绝创建（不 fail-open）；cancel/close 在 Recorder 故障时仍停止 Runtime；
// 5. auditPending 补账（§19.3 / §16.5）：投影失败 → run.audit_pending_json
//    追加（上限保护）；启动恢复第 5 步重放补账 + 成功后清空；corrupted 行
//    逐项聚合不阻断；
// 6. nested spawn 拒绝（§13.5 / §25.5）：Subagent 注册表无 spawn 控制工具；
//    模型伪造 spawn_subagent 调用 → subagent_nesting_forbidden / 不被执行。
// ═══════════════════════════════════════════════════════════════

// T9b：spy createPiAgentSession（passthrough 保真）——证明 Subagent 会话
// 构造时 systemPrompt 恒为平台规则、noTools:"all" 且 customTools 只含本 Run 工具
vi.mock("../../src/pi-sdk/agent-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi-sdk/agent-session.js")>();
  return {
    ...actual,
    createPiAgentSession: vi.fn(actual.createPiAgentSession),
  };
});

import {
  SUBAGENT_MESSAGE_PROTOCOL,
  SUBAGENT_RUN_LIMITS_DEFAULTS,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type SubagentContextPacketV1,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentRunStatus,
  type SubagentTaskBriefV1,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { ActivityRecorder } from "../../src/observability/activity-recorder.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
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
import { SubagentRuntimeHost, type ExecuteSubagentRunInput } from "../../src/runtime/subagents/runtime/runtime-host.js";
import { SubagentScheduler } from "../../src/runtime/subagents/runtime/scheduler.js";
import {
  REPORT_SUBAGENT_RESULT_TOOL,
  SUBAGENT_INTERNAL_TOOL_NAMES,
  SUBAGENT_NESTING_FORBIDDEN_TOOLS,
  subagentInternalToolDefs,
} from "../../src/runtime/subagents/runtime/internal-tools.js";
import type {
  SubagentSessionEvent,
  SubagentSessionFactory,
  SubagentSessionPort,
  SubagentSessionStartInput,
  SubagentToolInvokeResult,
} from "../../src/runtime/subagents/runtime/types.js";
import { ProtocolDispatcher } from "../../src/runtime/subagents/protocol/protocol-dispatcher.js";
import { ParentMailboxDeliveryCoordinator } from "../../src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.js";
import { SubagentStartupRecovery } from "../../src/runtime/subagents/recovery/startup-recovery.js";
import { SubagentTranscriptView } from "../../src/runtime/subagents/transcript/transcript-view.js";
import { SubagentArtifactFileService } from "../../src/runtime/subagents/transcript/artifact-files.js";
import { SubagentReplayStore } from "../../src/runtime/subagents/transcript/replay-store.js";
import { SubagentToolActivityTracker } from "../../src/runtime/subagents/transcript/tool-summary.js";
import {
  SubagentObservabilityProjector,
  wireSubagentRuntimeObservability,
} from "../../src/runtime/subagents/observability/subagent-observability-projector.js";
import { WorkspaceMutationLeaseService, PARENT_WRITE_LEASE_DEFAULT_TTL_MS } from "../../src/runtime/subagents/workspace-lease-service.js";
import type { SubagentWorkspaceLeaseRecord } from "../../src/runtime/subagents/stores/workspace-lease-store.js";
import { registerSubagentContext, type SubagentToolServices } from "../../src/pi-sdk/subagent-tools-context.js";
import subagentToolsExtension from "../../src/pi-sdk/subagent-tools.js";
import memoryToolsExtension from "../../src/pi-sdk/memory-tools.js";
import sandboxExtension, { registerSandboxContext, type SandboxContext } from "../../src/pi-sdk/sandbox-extension.js";
import { SUBAGENT_SYSTEM_PROMPT, createPiSubagentSessionFactory } from "../../src/runtime/subagents/runtime/pi-session-adapter.js";
import { createPiAgentSession } from "../../src/pi-sdk/agent-session.js";
import { ToolPolicy } from "../../src/runtime/tool-policy.js";
import { PathGuard } from "../../src/sandbox/path-guard.js";
import type { AuditAcceptResult, AuditRecordInput } from "../../src/observability/audit-recorder.js";
import type { ProducerContext } from "../../src/contracts/observability.js";

const NOW = "2026-08-07T10:00:00.000Z";
const SESSION_ID = "sess-t9b-main";
const OWNER = "agent-t9b";
const WS = path.join("D:\\", "work", "t9b");

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];
const trackedHosts: SubagentRuntimeHost[] = [];
const trackedCoordinators: ParentMailboxDeliveryCoordinator[] = [];

const producer: ProducerContext = {
  component: "unit-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t9b",
  appVersion: "0.0.0-test",
  hostPlatform: "win32",
};

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-sec-"));
  temporaryDirectories.push(dir);
  const database = openMetadataDatabase(path.join(dir, "metadata.db"));
  openDatabases.push(database);
  return { dir, database };
}

afterEach(() => {
  for (const host of trackedHosts.splice(0)) {
    host.dispose();
  }
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
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function ownership(agent = OWNER, session = SESSION_ID): SubagentOwnership {
  return { ownerAgentId: agent, parentSessionId: session };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

// ── 通用 Stores ─────────────────────────────────────────────────

function createStores(db: Database.Database) {
  const threads = new ThreadStore(db);
  const runs = new RunStore(db, threads);
  const messages = new MessageStore(db, threads);
  const artifacts = new ArtifactStore(db, threads);
  const mailbox = new ParentMailboxStore(db);
  const transactions = new SubagentTransactions(db, { threadStore: threads, runStore: runs, messageStore: messages, mailboxStore: mailbox });
  return { threads, runs, messages, artifacts, mailbox, transactions };
}

function createThreadAndFirstRun(
  transactions: SubagentTransactions,
  opts: {
    threadId: SubagentThreadId;
    runId: SubagentRunId;
    ownership: SubagentOwnership;
    workspaceAccess?: "read" | "write";
  },
): void {
  transactions.createThreadWithFirstRun({
    thread: {
      threadId: opts.threadId,
      title: "t9b thread",
      modelProviderId: "faux",
      modelId: "faux-1",
      modelSource: "user_default",
      thinkingLevel: "normal",
      workspaceCwd: WS,
      capabilityCeiling: {
        ceilingHash: "hash12345678",
        workspaceAccess: opts.workspaceAccess ?? "read",
        toolIds: [],
        pluginContributionIds: [],
        skillRefs: [],
        network: "inherit",
        fixedDenials: [],
      },
      contextPacketHash: "hash12345678",
      createdFromTurnId: null,
    },
    ownership: opts.ownership,
    firstRun: { runId: opts.runId, triggerMessageId: `sam_trig_${opts.runId}` as AgentMessageId },
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    taskEnvelope: {
      protocol: SUBAGENT_MESSAGE_PROTOCOL,
      version: 1,
      messageId: `sam_trig_${opts.runId}` as AgentMessageId,
      contextId: opts.threadId,
      taskId: opts.runId,
      sender: { kind: "parent_agent", id: opts.ownership.ownerAgentId },
      recipient: { kind: "subagent", id: opts.runId },
      messageType: "task",
      deliveryMode: "immediate",
      parts: [{ kind: "text", text: "研究并汇报" }],
      metadata: { createdAt: NOW, traceId: "trace-t9b", schemaName: "subagent.task" },
    },
    now: NOW,
  });
}

function executeInput(opts: {
  runId: SubagentRunId;
  threadId: SubagentThreadId;
  ownership: SubagentOwnership;
  workspaceAccess?: "read" | "write";
  prompt?: string;
}): ExecuteSubagentRunInput {
  return {
    runId: opts.runId,
    threadId: opts.threadId,
    ownership: opts.ownership,
    snapshotId: `sas_snap_${opts.runId}` as `sas_${string}`,
    snapshotJson: JSON.stringify({ ceilingHash: "hash12345678", workspaceAccess: opts.workspaceAccess ?? "read", toolIds: [] }),
    prompt: opts.prompt ?? "[任务目标] 测试\n",
    abilityTools: [],
    sessionDir: path.join(WS, "session"),
    workspaceCwd: WS,
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    triggerMessageId: `sam_trig_${opts.runId}` as AgentMessageId,
  };
}

// ── Host Harness（Lease / nesting / auditPending）───────────────

interface HostHarness {
  readonly db: Database.Database;
  readonly stores: ReturnType<typeof createStores>;
  readonly leaseStore: WorkspaceLeaseStore;
  readonly leaseService: WorkspaceMutationLeaseService;
  readonly factory: FauxSessionFactory;
  readonly host: SubagentRuntimeHost;
  readonly scheduler: SubagentScheduler;
  readonly coordinator: ParentMailboxDeliveryCoordinator;
  readonly terminals: Array<{ runId: string; status: string }>;
  runStatus(runId: SubagentRunId): SubagentRunStatus | null;
  wsLease(): SubagentWorkspaceLeaseRecord | null;
}

function createHostHarness(options: {
  workspaceLeases?: boolean;
  projector?: SubagentObservabilityProjector;
} = {}): HostHarness {
  const { database } = createContext();
  const stores = createStores(database);
  const factory = new FauxSessionFactory();
  const terminals: HostHarness["terminals"] = [];
  const leaseStore = new WorkspaceLeaseStore(database);
  const leaseService = new WorkspaceMutationLeaseService(leaseStore);
  let scheduler: SubagentScheduler;
  const baseDeps = {
    runs: stores.runs,
    messages: stores.messages,
    transactions: stores.transactions,
    sessionFactory: factory,
    bootId: "boot-t9b",
    ...(options.workspaceLeases === true ? { workspaceLeases: leaseService } : {}),
    onTerminal: (event: { runId: SubagentRunId; status: string }) => terminals.push({ runId: event.runId, status: event.status }),
    onRunFinished: () => scheduler.onRunTerminal(),
  };
  const host = new SubagentRuntimeHost(
    options.projector !== undefined ? wireSubagentRuntimeObservability(baseDeps, options.projector) : baseDeps,
  );
  trackedHosts.push(host);
  scheduler = new SubagentScheduler({ host });
  const coordinator = new ParentMailboxDeliveryCoordinator({
    mailboxStore: stores.mailbox,
    messageStore: stores.messages,
    runStore: stores.runs,
    threadStore: stores.threads,
    transactions: stores.transactions,
    cancelRun: (input) => host.cancelRun(input.runId, input.ownership, input.reasonCode),
    retryBaseDelayMs: 15,
    retryMaxDelayMs: 60,
  });
  trackedCoordinators.push(coordinator);
  return {
    db: database,
    stores,
    leaseStore,
    leaseService,
    factory,
    host,
    scheduler,
    coordinator,
    terminals,
    runStatus(runId) {
      return stores.runs.get(runId, ownership())?.status ?? null;
    },
    wsLease() {
      return leaseService.get(WS);
    },
  };
}

// ── Core-tools Harness（T6 模式：spawn/status/steer/cancel/close）─

interface ToolHarness {
  readonly db: Database.Database;
  readonly stores: ReturnType<typeof createStores>;
  readonly factory: FauxSessionFactory;
  readonly host: SubagentRuntimeHost;
  readonly scheduler: SubagentScheduler;
  readonly services: SubagentToolServices;
  readonly tools: Map<string, { execute(...args: unknown[]): Promise<unknown> }>;
  readonly auditCalls: Array<{ eventName: string }>;
  readonly activity: ActivityRecorder;
  readonly audit: AuditRecorder;
  /** 运行期切换审计行为（fail-safe 测试：先正常 spawn，再注入 Recorder 故障） */
  setAuditMode(mode: "accepted" | "rejected" | "throw" | "real"): void;
  runIdOf(threadId: SubagentThreadId): SubagentRunId | null;
  runStatus(runId: SubagentRunId): string | null;
}

function createToolHarness(options: {
  auditMode?: "accepted" | "rejected" | "throw" | "real";
} = {}): ToolHarness {
  const { database } = createContext();
  const stores = createStores(database);
  const factory = new FauxSessionFactory();
  let scheduler: SubagentScheduler;
  const host = new SubagentRuntimeHost({
    runs: stores.runs,
    messages: stores.messages,
    transactions: stores.transactions,
    sessionFactory: factory,
    bootId: "boot-t9b",
    onRunFinished: () => scheduler.onRunTerminal(),
  });
  trackedHosts.push(host);
  scheduler = new SubagentScheduler({ host });
  const coordinator = new ParentMailboxDeliveryCoordinator({
    mailboxStore: stores.mailbox,
    messageStore: stores.messages,
    runStore: stores.runs,
    threadStore: stores.threads,
    transactions: stores.transactions,
    cancelRun: (input) => host.cancelRun(input.runId, input.ownership, input.reasonCode),
  });
  trackedCoordinators.push(coordinator);
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
  const artifactFiles = new SubagentArtifactFileService({ artifacts: stores.artifacts, threads: stores.threads, paths: { subagentsBase: path.join(WS, "subagents") } as never });
  const activity = new ActivityRecorder({ database, producer });
  const audit = new AuditRecorder({ database, producer });
  const projector = new SubagentObservabilityProjector({ activity, runs: stores.runs, messages: stores.messages });

  const auditState = { mode: options.auditMode ?? ("accepted" as const) };
  const auditCalls: ToolHarness["auditCalls"] = [];
  const auditFn = (input: AuditRecordInput): AuditAcceptResult => {
    auditCalls.push({ eventName: input.eventName });
    if (auditState.mode === "rejected") {
      return { kind: "rejected", eventName: input.eventName, reason: "recorder unavailable（测试注入）" };
    }
    if (auditState.mode === "throw") {
      throw new Error("recorder down（测试注入）");
    }
    if (auditState.mode === "real") {
      return audit.appendStrict(input);
    }
    return { kind: "accepted", eventId: `audit-${auditCalls.length}`, rowId: auditCalls.length };
  };

  let seq = 0;
  const newId = (prefix: "sat_" | "sar_" | "sam_" | "saa_" | "smb_" | "sas_"): string => {
    seq += 1;
    return `${prefix}${seq.toString().padStart(12, "0")}`;
  };

  const services: SubagentToolServices = {
    preferences: () => ({ subagents: { defaultModel: null } }),
    currentModel: () => ({ providerId: "faux", modelId: "faux-1" }),
    parentSnapshot: () => ({ toolIds: ["read", "write", "bash"], pluginContributions: [], skillEntries: [] }),
    modelResolver: () => true,
    toolCatalog: (name) => (name === "read" ? { name: "read", description: "read", parameters: { type: "object" } } : null),
    workspaceCwd: () => WS,
    threadDirResolver: (input) => path.join(WS, "subagents", input.ownerAgentId, input.threadId),
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
    audit: auditFn,
    available: () => true,
    now: () => Date.now(),
    newId,
  };
  registerSubagentContext(SESSION_ID, {
    ownerAgentId: OWNER,
    sessionId: SESSION_ID,
    turnIdSlot: { current: "turn-1" },
    traceSlot: { current: undefined },
    services,
  });
  // T9b-3：另一个 Agent/Session 上下文（同一 services/数据库，不同归属）
  registerSubagentContext("sess-t9b-b", {
    ownerAgentId: "agent-t9b-b",
    sessionId: "sess-t9b-b",
    turnIdSlot: { current: "turn-b" },
    traceSlot: { current: undefined },
    services,
  });

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
    auditCalls,
    activity,
    audit,
    setAuditMode(mode) {
      auditState.mode = mode;
    },
    runIdOf(threadId) {
      return stores.runs.listByThread(threadId, ownership()).at(-1)?.runId ?? null;
    },
    runStatus(runId) {
      return stores.runs.get(runId, ownership())?.status ?? null;
    },
  };
}

type ToolOutcome =
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "threw"; error: unknown };

/** 归属隔离断言：任何形式（结构化错误 / Store 抛错）都必须是拒绝且不泄露内容 */
function expectOwnershipRejected(outcome: ToolOutcome): void {
  if (outcome.kind === "threw") {
    const error = outcome.error as { code?: unknown } | undefined;
    expect(["subagent_ownership_denied", "subagent_not_found"]).toContain(error?.code);
    return;
  }
  const value = outcome.value;
  expect(value.status).toBe("error");
  expect(["subagent_ownership_denied", "subagent_not_found"]).toContain(value.code);
}

async function callToolAs(h: ToolHarness, sessionId: string, name: string, args: unknown): Promise<ToolOutcome> {
  const def = h.tools.get(name);
  if (def === undefined) throw new Error(`tool ${name} not registered`);
  try {
    const result = (await def.execute("tc-1", args, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
    })) as { content?: Array<{ text?: string }> };
    return { kind: "ok", value: JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown> };
  } catch (error) {
    return { kind: "threw", error };
  }
}

function callTool(h: ToolHarness, name: string, args: unknown): Promise<ToolOutcome> {
  return callToolAs(h, SESSION_ID, name, args);
}

function brief(): SubagentTaskBriefV1 {
  return {
    version: 1,
    title: "安全回归任务",
    objective: "验证隔离边界",
    successCriteria: ["边界成立"],
    deliverables: ["结论"],
    context: ["已有安全基线"],
    constraints: ["不修改平台边界"],
    nonGoals: [],
    executionMode: "research",
    reporting: { progress: "terminal-only", evidenceRequired: false, artifactPreference: "inline" },
  };
}

function packet(): SubagentContextPacketV1 {
  return {
    version: 1,
    userRequest: "验证",
    parentSummary: "父 Agent 摘要",
    messageRefs: [],
    resources: [],
    knownFacts: [],
    unresolvedQuestions: [],
  };
}

function resultArgs(): Record<string, unknown> {
  return {
    disposition: "satisfied",
    summary: "完成",
    criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }],
    artifacts: [],
    unresolvedIssues: [],
    recommendedNextAction: "accept",
  };
}

// ═══════════════════════════════════════════════════════════════
// T9b-1：memory/personality 隔离（§11 / §25.3）
// ═══════════════════════════════════════════════════════════════

describe("T9b-1 memory/personality 隔离", () => {
  it("Subagent 工具注册表只有内部三工具+能力工具（无记忆工具、无 spawn 控制工具）", async () => {
    const h = createToolHarness();
    const out = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    expect(out.kind).toBe("ok");
    const spawned = (out as { kind: "ok"; value: Record<string, unknown> }).value;
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    const toolNames = session.startInput?.tools.map((tool) => tool.name) ?? [];
    expect(toolNames.sort()).toEqual([...SUBAGENT_INTERNAL_TOOL_NAMES, "read"].sort());
    // 无记忆工具（§11.2 #2：不注册 search_memory/记忆 intent/记忆 Agent）
    expect(toolNames).not.toContain("search_memory");
    expect(toolNames).not.toContain("remember");
    expect(toolNames).not.toContain("forget");
    expect(toolNames).not.toContain("pin_memory");
    expect(toolNames).not.toContain("unpin_memory");
    // 无 spawn 控制工具（§13.5：注册表完全没有）
    for (const name of SUBAGENT_NESTING_FORBIDDEN_TOOLS) {
      expect(toolNames).not.toContain(name);
    }
    expect(spawned.status).toBe("ok");
  });

  it("主会话记忆工具在 Subagent 上下文调用 → fail-closed（上下文未注册即拒绝）", async () => {
    // 记忆工具扩展注册进 FakePi（生产同款入口）
    const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
    const fakePi = {
      registerTool(def: { name: string; execute(...args: unknown[]): Promise<unknown> }) {
        tools.set(def.name, def);
      },
    } as unknown as ExtensionAPI;
    memoryToolsExtension(fakePi);
    const search = tools.get("search_memory");
    expect(search).toBeDefined();
    // 主会话已注册记忆上下文（生产 setupMemoryContext 路径），Subagent 会话未注册
    const subagentSessionId = "subagent-sat_x-under-test";
    await expect(
      search!.execute("tc-1", { query: "长期事实" }, new AbortController().signal, undefined, {
        sessionManager: { getSessionId: () => subagentSessionId },
      }),
    ).rejects.toThrow("记忆工具上下文未就绪");
  });

  it("systemPrompt 恒为平台规则：不含父人格/四段记忆注入（adapter 构造路径 spy）", async () => {
    const { dir, database } = createContext();
    const threads = new ThreadStore(database);
    threads.create({
      threadId: "sat_t9b_sysprompt00001" as SubagentThreadId,
      ownerAgentId: OWNER,
      parentSessionId: SESSION_ID,
      createdFromTurnId: "turn-1",
      title: "sysprompt test",
      modelProviderId: "faux",
      modelId: "faux-1",
      modelSource: "user_default",
      thinkingLevel: "normal",
      workspaceCwd: WS,
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
      createdAt: NOW,
    });
    const { faux, runtime } = await createModelRuntime(dir);
    const factory = createPiSubagentSessionFactory({
      threadStore: threads,
      modelRuntime: {
        resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }),
      } as never,
      authPath: path.join(dir, "auth.json"),
      threadDirResolver: (input) => path.join(dir, input.ownerAgentId, "subagents", input.threadId),
    });
    const session = await factory.create({
      threadId: "sat_t9b_sysprompt00001" as SubagentThreadId,
      ownerAgentId: OWNER,
      parentSessionId: SESSION_ID,
      runId: "sar_t9b_sysprompt00001" as SubagentRunId,
      sessionDir: path.join(dir, "session"),
      workspaceCwd: WS,
    });
    faux.setResponses([fauxAssistantMessage("收到")]);
    void session.start({ prompt: "[任务目标] 测试\n", tools: subagentInternalToolDefs() });
    await waitUntil(() => vi.mocked(createPiAgentSession).mock.calls.length > 0);
    const args = vi.mocked(createPiAgentSession).mock.calls[0]?.[0];
    // systemPrompt 恒为平台规则（§11.1：不注入父 identity/base-color/四段记忆）
    expect(args?.systemPrompt).toBe(SUBAGENT_SYSTEM_PROMPT);
    // 注册表：noTools:"all" 只保留本 Run 注入工具（无记忆、无 spawn）
    expect(args?.noTools).toBe("all");
    const customNames = (args?.customTools ?? []).map((tool) => tool.name);
    expect(customNames.sort()).toEqual([...SUBAGENT_INTERNAL_TOOL_NAMES].sort());
    for (const name of ["search_memory", "remember", "spawn_subagent", "get_subagent_status"]) {
      expect(customNames).not.toContain(name);
    }
    // 平台规则内容：有平台规则标记，无四段记忆/人格注入
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("平台规则优先级最高");
    expect(SUBAGENT_SYSTEM_PROMPT).not.toMatch(/today\.md|week\.md|longterm\.md|facts\.md/i);
    expect(SUBAGENT_SYSTEM_PROMPT).not.toMatch(/base-color|底色|人格描述|identity/i);
    session.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════
// T9b-2：write Lease 与父 Agent 互斥（§18.3 / §25.4）
// ═══════════════════════════════════════════════════════════════

describe("T9b-2 write Lease 与父 Agent 互斥", () => {
  it("同进程（同 bootId）不同持有者互斥：子 Run 持有时父 permit 获取 denied（反之亦然）", () => {
    const { database } = createContext();
    const service = new WorkspaceMutationLeaseService(new WorkspaceLeaseStore(database));
    // 子 Run 持有 subagent_write（同 bootId——单进程 Server 内父子同 boot）
    const run = service.acquire(WS, {
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_t9b_run1",
      bootId: "boot-t9b",
      ttlMs: 30 * 60_000,
    });
    expect(run.status).toBe("acquired");
    // 父 Agent 写 Tool 的 operation-scoped short permit：同 bootId 不同持有者 → denied
    const parent = service.acquire(WS, {
      leaseKind: "parent_write",
      ownerKind: "parent_agent",
      ownerId: OWNER,
      bootId: "boot-t9b",
      ttlMs: PARENT_WRITE_LEASE_DEFAULT_TTL_MS,
    });
    expect(parent.status).toBe("denied");
    if (parent.status === "denied") {
      expect(parent.heldBy.ownerId).toBe("sar_t9b_run1");
    }
    // 反向：父持有 → 子 Run 获取 denied（同 bootId）
    service.release(WS, "sar_t9b_run1", "boot-t9b");
    const parentHeld = service.acquire(WS, {
      leaseKind: "parent_write",
      ownerKind: "parent_agent",
      ownerId: OWNER,
      bootId: "boot-t9b",
      ttlMs: PARENT_WRITE_LEASE_DEFAULT_TTL_MS,
    });
    expect(parentHeld.status).toBe("acquired");
    const runAgain = service.acquire(WS, {
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_t9b_run2",
      bootId: "boot-t9b",
      ttlMs: 30 * 60_000,
    });
    expect(runAgain.status).toBe("denied");
    // 同一持有者同 bootId 重新获取（重试语义）仍允许
    const sameOwner = service.acquire(WS, {
      leaseKind: "parent_write",
      ownerKind: "parent_agent",
      ownerId: OWNER,
      bootId: "boot-t9b",
      ttlMs: PARENT_WRITE_LEASE_DEFAULT_TTL_MS,
    });
    expect(sameOwner.status).toBe("acquired");
  });

  it("write Run 启动获取独占 Lease、终态释放；read Run 不获取", async () => {
    const h = createHostHarness({ workspaceLeases: true });
    const threadId = "sat_t9b_lease0001" as SubagentThreadId;
    const runId = "sar_t9b_lease0001" as SubagentRunId;
    createThreadAndFirstRun(h.stores.transactions, { threadId, runId, ownership: ownership(), workspaceAccess: "write" });
    h.host.execute(executeInput({ runId, threadId, ownership: ownership(), workspaceAccess: "write" }));
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    // 启动后 Lease 被子 Run 持有（ownerId = runId）
    expect(h.wsLease()?.ownerId).toBe(runId);
    expect(h.wsLease()?.leaseKind).toBe("subagent_write");
    // 终态 → Lease 释放（cleanup 异步执行，等待释放）
    await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    session.finish();
    await waitUntil(() => h.runStatus(runId) === "succeeded");
    await waitUntil(() => h.wsLease() === null);
  });

  it("read Run 不获取工作区写 Lease", async () => {
    const h = createHostHarness({ workspaceLeases: true });
    const threadId = "sat_t9b_lease0002" as SubagentThreadId;
    const runId = "sar_t9b_lease0002" as SubagentRunId;
    createThreadAndFirstRun(h.stores.transactions, { threadId, runId, ownership: ownership(), workspaceAccess: "read" });
    h.host.execute(executeInput({ runId, threadId, ownership: ownership(), workspaceAccess: "read" }));
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    expect(h.wsLease()).toBeNull();
    await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    session.finish();
    await waitUntil(() => h.runStatus(runId) === "succeeded");
  });

  it("父 Agent 写 permit 占用中 → write Run 启动 fail-closed（failed，不并发写）", async () => {
    const h = createHostHarness({ workspaceLeases: true });
    // 父 Agent 写 Tool 正在执行（operation-scoped short permit 持有中，同 bootId）
    const parent = h.leaseService.acquire(WS, {
      leaseKind: "parent_write",
      ownerKind: "parent_agent",
      ownerId: OWNER,
      bootId: "boot-t9b",
      ttlMs: PARENT_WRITE_LEASE_DEFAULT_TTL_MS,
    });
    expect(parent.status).toBe("acquired");
    const threadId = "sat_t9b_lease0003" as SubagentThreadId;
    const runId = "sar_t9b_lease0003" as SubagentRunId;
    createThreadAndFirstRun(h.stores.transactions, { threadId, runId, ownership: ownership(), workspaceAccess: "write" });
    h.host.execute(executeInput({ runId, threadId, ownership: ownership(), workspaceAccess: "write" }));
    await waitUntil(() => h.runStatus(runId) === "failed");
    expect(h.stores.runs.get(runId, ownership())?.reasonCode).toBe("subagent_operation_failed");
    // 父 permit 未被子 Run 抢占
    expect(h.wsLease()?.ownerId).toBe(OWNER);
    // 父写操作完成后释放 → 新 write Run 可启动
    h.leaseService.release(WS, OWNER, "boot-t9b");
    expect(h.wsLease()).toBeNull();
  });

  it("父会话 sandbox write/edit 工具执行入口：Lease 被占用 → fail-closed 拒绝；空闲 → 执行并释放 permit", async () => {
    const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
    const api = {
      registerTool(def: { name: string; execute(...args: unknown[]): Promise<unknown> }) {
        tools.set(def.name, def);
      },
    };
    sandboxExtension(api as never);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-sec-sandbox-"));
    temporaryDirectories.push(workspace);
    const policy = new ToolPolicy();
    policy.setPathGuard(
      new PathGuard({
        rules: [{ path: workspace + path.sep, level: "FULL", reason: "test workspace" }],
        defaultLevel: "BLOCKED",
        allowExternalReads: false,
      }),
    );
    const executionContext = { sessionManager: { getSessionId: () => "sess-sandbox-t9b" } };
    // 占用中：guard denied → 拒绝执行（fail-closed）
    const deniedContext: SandboxContext = {
      toolPolicy: policy,
      sessionCwd: workspace,
      allowBash: false,
      workspaceLeaseGuard: () => ({ allowed: false, reason: "subagent write run 持有独占 Lease" }),
    };
    const unregisterDenied = registerSandboxContext("sess-sandbox-t9b", deniedContext);
    try {
      await expect(
        tools.get("write")!.execute("tc-1", { path: "a.txt", content: "x" }, new AbortController().signal, undefined, executionContext),
      ).rejects.toThrow("写 Lease 被占用");
    } finally {
      unregisterDenied();
    }
    // 空闲：guard 获取 permit → 原工具执行 → finally 释放
    const release = vi.fn(() => undefined);
    const allowedContext: SandboxContext = {
      toolPolicy: policy,
      sessionCwd: workspace,
      allowBash: false,
      workspaceLeaseGuard: () => ({ allowed: true, release }),
    };
    const unregisterAllowed = registerSandboxContext("sess-sandbox-t9b", allowedContext);
    try {
      await tools.get("write")!.execute("tc-1", { path: "a.txt", content: "写入内容" }, new AbortController().signal, undefined, executionContext);
      expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf8")).toBe("写入内容");
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      unregisterAllowed();
    }
    // 无 guard（未注入）：行为不变
    const plainContext: SandboxContext = { toolPolicy: policy, sessionCwd: workspace, allowBash: false };
    const unregisterPlain = registerSandboxContext("sess-sandbox-t9b", plainContext);
    try {
      await tools.get("write")!.execute("tc-1", { path: "b.txt", content: "第二次写入" }, new AbortController().signal, undefined, executionContext);
      expect(fs.readFileSync(path.join(workspace, "b.txt"), "utf8")).toBe("第二次写入");
    } finally {
      unregisterPlain();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// T9b-3：cross-agent/session 隔离（§22.1 / §25.7）
// ═══════════════════════════════════════════════════════════════

describe("T9b-3 cross-agent/session 隔离", () => {
  it("另一 ownerAgentId 查询/steer/cancel/close → 归属错误（subagent_ownership_denied / not_found 不泄露存在性）", async () => {
    const h = createToolHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    expect(spawned.kind).toBe("ok");
    const { threadId, runId } = (spawned as { kind: "ok"; value: Record<string, unknown> }).value;

    // Agent B 用 agent-b/sess-b 上下文操作 Agent A 的 Thread——一律拒绝，
    // 且错误不外泄对象内容（归属错误 or 不存在，都是非成功返回）
    const status = await callToolAs(h, "sess-t9b-b", "get_subagent_status", { threadId });
    expectOwnershipRejected(status);

    const steer = await callToolAs(h, "sess-t9b-b", "steer_subagent", {
      version: 1,
      targetRunId: runId,
      action: "add_constraint",
      instruction: "越权纠偏",
      reason: "越权",
      preserveCompletedWork: true,
      deliveryMode: "queue",
    });
    expectOwnershipRejected(steer);

    const cancel = await callToolAs(h, "sess-t9b-b", "cancel_subagent", { threadId, reason: "越权取消" });
    expectOwnershipRejected(cancel);

    const close = await callToolAs(h, "sess-t9b-b", "close_subagent", { threadId });
    expectOwnershipRejected(close);

    // 被拒后 Thread 状态未被触碰（Run 仍 running，Thread 仍 open）
    expect(h.runStatus(runId as SubagentRunId)).toBe("running");
    expect(h.stores.threads.get(threadId as SubagentThreadId, ownership())?.status).toBe("open");
  });

  it("spawn 上下文外（未注册 Session）调用工具 → fail-closed 拒绝", async () => {
    const h = createToolHarness();
    const spawn = await callToolAs(h, "sess-unknown", "spawn_subagent", { brief: brief(), context: packet() });
    expect(spawn.kind).toBe("threw");
    const status = await callToolAs(h, "sess-unknown", "get_subagent_status", {});
    expect(status.kind).toBe("threw");
    expect(h.stores.threads.listByOwner(ownership(), 10)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// T9b-4：audit fail-closed（§22.5 / §25.7）
// ═══════════════════════════════════════════════════════════════

describe("T9b-4 audit fail-closed", () => {
  it("spawn started 审计 rejected → 拒绝创建（fail-closed，不 fail-open）", async () => {
    const h = createToolHarness({ auditMode: "rejected" });
    const out = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    expect(out.kind).toBe("ok");
    const value = (out as { kind: "ok"; value: Record<string, unknown> }).value;
    expect(value.status).toBe("error");
    expect(value.code).toBe("subagent_operation_failed");
    expect(h.stores.threads.listByOwner(ownership(), 10)).toHaveLength(0);
    expect(h.auditCalls[0]?.eventName).toBe("audit.subagent.spawn_started");
  });

  it("spawn started 审计抛错（Recorder 故障）→ 拒绝创建", async () => {
    const h = createToolHarness({ auditMode: "throw" });
    const out = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    expect(out.kind).toBe("ok");
    const value = (out as { kind: "ok"; value: Record<string, unknown> }).value;
    expect(value.status).toBe("error");
    expect(value.code).toBe("subagent_operation_failed");
    expect(h.stores.threads.listByOwner(ownership(), 10)).toHaveLength(0);
  });

  it("spawn 正常路径写目录事件（audit.subagent.spawn_started/completed 真实落库）", async () => {
    const h = createToolHarness({ auditMode: "real" });
    const out = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    expect(out.kind).toBe("ok");
    const value = (out as { kind: "ok"; value: Record<string, unknown> }).value;
    expect(value.status).toBe("ok");
    const rows = h.db.prepare("SELECT event_name FROM audit_events WHERE event_name LIKE 'audit.subagent.spawn_%'").all() as Array<{ event_name: string }>;
    const names = rows.map((row) => row.event_name).sort();
    expect(names).toContain("audit.subagent.spawn_started");
    expect(names).toContain("audit.subagent.spawn_completed");
  });

  it("cancel/close 在 Recorder 故障（审计抛错）时仍停止 Runtime（fail-safe-to-stop）", async () => {
    // 先正常 spawn（started 审计 accepted），随后注入 Recorder 故障
    const h = createToolHarness();
    const spawned = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    const { threadId } = (spawned as { kind: "ok"; value: Record<string, unknown> }).value;
    const runId = h.runIdOf(threadId as SubagentThreadId);
    expect(runId).not.toBeNull();
    h.setAuditMode("throw");
    // cancel：Recorder 故障不影响取消路径（先停止执行，审计证据可后补）
    const cancel = await callTool(h, "cancel_subagent", { threadId, reason: "不需要了" });
    expect(cancel.kind).toBe("ok");
    await waitUntil(() => h.runStatus(runId as SubagentRunId) === "cancelled");
    // close：Recorder 故障不影响关闭（含活动 Run 先取消）
    const h2 = createToolHarness();
    const spawned2 = await callTool(h2, "spawn_subagent", { brief: brief(), context: packet() });
    const threadId2 = (spawned2 as { kind: "ok"; value: Record<string, unknown> }).value.threadId as SubagentThreadId;
    h2.setAuditMode("throw");
    const close = await callTool(h2, "close_subagent", { threadId: threadId2 });
    expect(close.kind).toBe("ok");
    const closeValue = (close as { kind: "ok"; value: Record<string, unknown> }).value;
    expect(closeValue.threadStatus).toBe("closed");
    expect(h2.stores.threads.get(threadId2, ownership())?.status).toBe("closed");
    // 已关闭 Thread 不可再创建新 Run（结构化 error 或抛错都是拒绝；不新增 Run）
    const spawned2Value = (spawned2 as { kind: "ok"; value: Record<string, unknown> }).value;
    const runsBefore = h2.stores.runs.listByThread(threadId2, ownership()).length;
    const steer = await callTool(h2, "steer_subagent", {
      version: 1,
      targetRunId: spawned2Value.runId,
      action: "redirect",
      instruction: "再跑一轮",
      reason: "补充",
      preserveCompletedWork: true,
      deliveryMode: "queue",
    });
    if (steer.kind === "ok") {
      expect((steer as { kind: "ok"; value: Record<string, unknown> }).value.status).toBe("error");
    }
    expect(h2.stores.runs.listByThread(threadId2, ownership()).length).toBe(runsBefore);
  });
});

// ═══════════════════════════════════════════════════════════════
// T9b-5：auditPending 补账（§19.3 / §16.5 / §25.7 尾）
// ═══════════════════════════════════════════════════════════════

describe("T9b-5 auditPending 补账", () => {
  /** 投影失败回调：组合根同款接线（追加到 run.audit_pending_json） */
  function onProjectionFailure(runs: RunStore): NonNullable<ConstructorParameters<typeof SubagentObservabilityProjector>[0]["onProjectionFailure"]> {
    return (input) => {
      if (input.runId === null || input.ownership === null) {
        return;
      }
      runs.appendAuditPending(input.runId, input.ownership, input.record);
    };
  }

  it("Recorder 故障：终态仍落库（Runtime 不被投影拖垮），证据入 audit_pending_json", async () => {
    // 故障 Recorder：append 一律抛错
    const brokenActivity = { append: () => { throw new Error("recorder down"); } } as unknown as ActivityRecorder;
    const { database } = createContext();
    const stores = createStores(database);
    const projector = new SubagentObservabilityProjector({
      activity: brokenActivity,
      runs: stores.runs,
      messages: stores.messages,
      onProjectionFailure: onProjectionFailure(stores.runs),
    });
    // 组合根同款 Host 接线
    let scheduler: SubagentScheduler;
    const factory = new FauxSessionFactory();
    const host = new SubagentRuntimeHost(
      wireSubagentRuntimeObservability(
        {
          runs: stores.runs,
          messages: stores.messages,
          transactions: stores.transactions,
          sessionFactory: factory,
          bootId: "boot-t9b",
          onRunFinished: () => scheduler.onRunTerminal(),
        },
        projector,
      ),
    );
    trackedHosts.push(host);
    scheduler = new SubagentScheduler({ host });
    const threadId = "sat_t9b_pend0001" as SubagentThreadId;
    const runId = "sar_t9b_pend0001" as SubagentRunId;
    createThreadAndFirstRun(stores.transactions, { threadId, runId, ownership: ownership() });
    // spawn 路径登记归属（生产由 spawn 工具 projectThreadCreated/projectRunQueued 完成）
    projector.registerOwnership(threadId, ownership());
    host.execute(executeInput({ runId, threadId, ownership: ownership() }));
    const session = factory.latest();
    await waitUntil(() => session.startInput !== null);
    await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    session.finish();
    // 领域终态成功（Recorder 故障不阻断 Runtime 停止）
    await waitUntil(() => stores.runs.get(runId, ownership())?.status === "succeeded");
    const run = stores.runs.get(runId, ownership());
    expect(run).not.toBeNull();
    // 投影证据缓冲到 audit_pending_json（含终态事件）
    const pending = run?.auditPendingJson;
    expect(pending).not.toBeNull();
    const entries = JSON.parse(pending ?? "[]") as Array<{ eventName?: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((entry) => entry.eventName === "subagent.run.completed")).toBe(true);
  });

  it("auditPending 追加上限保护：超 32 条丢最旧", () => {
    const { database } = createContext();
    const stores = createStores(database);
    const threadId = "sat_t9b_pend0002" as SubagentThreadId;
    const runId = "sar_t9b_pend0002" as SubagentRunId;
    createThreadAndFirstRun(stores.transactions, { threadId, runId, ownership: ownership() });
    for (let i = 0; i < 40; i += 1) {
      stores.runs.appendAuditPending(runId, ownership(), { eventName: `event-${i}`, payload: { summaryCode: "x" } });
    }
    const entries = JSON.parse(stores.runs.get(runId, ownership())?.auditPendingJson ?? "[]") as Array<{ eventName: string }>;
    expect(entries).toHaveLength(32);
    expect(entries[0]?.eventName).toBe("event-8"); // 0..7 被丢弃
    expect(entries[31]?.eventName).toBe("event-39");
  });

  it("恢复器第 5 步：重放补账 + 成功后清空；corrupted 行逐项聚合不阻断", () => {
    const { database } = createContext();
    const stores = createStores(database);
    const threadIdA = "sat_t9b_pend0003" as SubagentThreadId;
    const runIdA = "sar_t9b_pend0003" as SubagentRunId;
    const threadIdB = "sat_t9b_pend0004" as SubagentThreadId;
    const runIdB = "sar_t9b_pend0004" as SubagentRunId;
    createThreadAndFirstRun(stores.transactions, { threadId: threadIdA, runId: runIdA, ownership: ownership() });
    createThreadAndFirstRun(stores.transactions, { threadId: threadIdB, runId: runIdB, ownership: ownership() });
    // 有效 pending（完整 ActivityRecordInput 形状）
    const record = {
      eventName: "subagent.run.completed",
      payload: { summaryCode: "subagent_run_completed" },
      actor: { kind: "subagent", id: runIdA },
      executor: { kind: "subagent", id: runIdA },
      scope: { ownerAgentId: OWNER, sessionId: SESSION_ID, subagentThreadId: threadIdA, subagentRunId: runIdA },
      status: "completed",
      operationId: `subagent-run-${runIdA}`,
    };
    stores.runs.appendAuditPending(runIdA, ownership(), record);
    // corrupted pending（runIdB）：恢复器必须逐项聚合不阻断
    stores.runs.updateAuditPending(runIdB, ownership(), "{corrupted-json");

    const activity = new ActivityRecorder({ database, producer });
    const coordinator = new ParentMailboxDeliveryCoordinator({
      mailboxStore: stores.mailbox,
      messageStore: stores.messages,
      runStore: stores.runs,
      threadStore: stores.threads,
      transactions: stores.transactions,
      cancelRun: () => true,
      retryBaseDelayMs: 15,
      retryMaxDelayMs: 60,
    });
    trackedCoordinators.push(coordinator);
    const recovery = new SubagentStartupRecovery({
      runs: stores.runs,
      threads: stores.threads,
      messages: stores.messages,
      transactions: stores.transactions,
      workspaceLeases: new WorkspaceLeaseStore(database),
      coordinator,
      activity,
      now: () => Date.now(),
    });
    const report = recovery.run();
    // corrupted 聚合进 errors，不阻断整体
    expect(report.errors.some((error) => error.includes("corrupted"))).toBe(true);
    // 有效 pending 重放成功并清空
    expect(report.auditPendingReplayed).toBe(1);
    expect(stores.runs.get(runIdA, ownership())?.auditPendingJson).toBeNull();
    // corrupted 行保留（待人工诊断）
    expect(stores.runs.get(runIdB, ownership())?.auditPendingJson).toBe("{corrupted-json");
    // 重放后的 activity 行可见（补账生效）
    const rows = database.prepare("SELECT event_name FROM activity_events WHERE event_name = 'subagent.run.completed'").all() as Array<{ event_name: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// T9b-6：nested spawn 拒绝（§13.5 / §25.5）
// ═══════════════════════════════════════════════════════════════

describe("T9b-6 nested spawn 拒绝", () => {
  it("Subagent 工具注册表无 spawn_subagent（内部三工具恒注册，无父控制工具）", async () => {
    const h = createToolHarness();
    const out = await callTool(h, "spawn_subagent", { brief: brief(), context: packet() });
    expect(out.kind).toBe("ok");
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    const names = session.startInput?.tools.map((tool) => tool.name) ?? [];
    expect(names).not.toContain("spawn_subagent");
    expect(names).not.toContain("cancel_subagent");
  });

  it("模型伪造 spawn_subagent 调用 → host 分发返回 subagent_nesting_forbidden（Run 不创建新 Thread）", async () => {
    const h = createHostHarness();
    const threadId = "sat_t9b_nest0001" as SubagentThreadId;
    const runId = "sar_t9b_nest0001" as SubagentRunId;
    createThreadAndFirstRun(h.stores.transactions, { threadId, runId, ownership: ownership() });
    h.host.execute(executeInput({ runId, threadId, ownership: ownership() }));
    const session = h.factory.latest();
    await waitUntil(() => session.startInput !== null);
    // 模型伪造 spawn 调用（工具名不在注册表，分发必须确定性拒绝）
    const outcome = await session.invokeTool("spawn_subagent", { brief: brief(), context: packet() });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("subagent_nesting_forbidden");
    // 未产生任何新 Thread/Run（不泄漏嵌套能力）
    expect(h.stores.threads.listByOwner(ownership(), 10)).toHaveLength(1);
    expect(h.stores.runs.listByThread(threadId, ownership())).toHaveLength(1);
    // Run 正常收敛（拒绝不影响自身 Run 收尾）
    await session.invokeTool(REPORT_SUBAGENT_RESULT_TOOL, resultArgs());
    session.finish();
    await waitUntil(() => h.runStatus(runId) === "succeeded");
  });

  it("真实 Faux Provider：模型伪造 spawn_subagent 调用被拒（不执行、不创建）", async () => {
    const { dir, database } = createContext();
    const threads = new ThreadStore(database);
    threads.create({
      threadId: "sat_t9b_nest0002" as SubagentThreadId,
      ownerAgentId: OWNER,
      parentSessionId: SESSION_ID,
      createdFromTurnId: "turn-1",
      title: "nest test",
      modelProviderId: "faux",
      modelId: "faux-1",
      modelSource: "user_default",
      thinkingLevel: "normal",
      workspaceCwd: WS,
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
      createdAt: NOW,
    });
    const { faux, runtime } = await createModelRuntime(dir);
    const events: SubagentSessionEvent[] = [];
    const factory = createPiSubagentSessionFactory({
      threadStore: threads,
      modelRuntime: {
        resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }),
      } as never,
      authPath: path.join(dir, "auth.json"),
      threadDirResolver: (input) => path.join(dir, input.ownerAgentId, "subagents", input.threadId),
    });
    const session = await factory.create({
      threadId: "sat_t9b_nest0002" as SubagentThreadId,
      ownerAgentId: OWNER,
      parentSessionId: SESSION_ID,
      runId: "sar_t9b_nest0002" as SubagentRunId,
      sessionDir: path.join(dir, "session"),
      workspaceCwd: WS,
    });
    session.onEvent((event) => events.push(event));
    // 模型第一轮伪造 spawn_subagent 调用（注册表中不存在该工具）
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("spawn_subagent", { brief: brief(), context: packet() })]),
      fauxAssistantMessage("无法创建子代理，提交结果"),
    ]);
    void session.start({ prompt: "[任务目标] 测试\n", tools: subagentInternalToolDefs() });
    // 等待会话收敛（terminal 或 error；模型伪造调用被拒后继续/结束）
    const deadline = Date.now() + 10000;
    while (!events.some((event) => event.type === "terminal" || event.type === "error") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 伪造调用出现在模型工具流，但平台从不执行它（无 tool-invoke 分发）
    expect(events.some((event) => event.type === "tool-call" && event.name === "spawn_subagent")).toBe(true);
    expect(events.some((event) => event.type === "tool-invoke" && event.name === "spawn_subagent")).toBe(false);
    // 未创建任何新 Thread（ThreadStore 只有测试预置的 1 个）
    expect(threads.listByOwner(ownership(), 10)).toHaveLength(1);
    session.dispose();
  });
});

// ── 共享 helpers ────────────────────────────────────────────────

async function createModelRuntime(dir: string) {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({ authPath: dir, modelsPath: null, allowModelNetwork: false });
  runtime.registerProvider("faux", {
    name: "Faux",
    baseUrl: "http://localhost:0",
    api: faux.provider as never,
    streamSimple: faux.provider.stream as never,
    models: [{ id: "faux-1", name: "Faux Model", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
  });
  await runtime.setRuntimeApiKey("faux", "dummy-key");
  return { faux, runtime };
}
