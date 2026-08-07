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
  type SubagentArtifactId,
  type SubagentCapabilitySummary,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentRunStatus,
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
  WorkspaceLeaseStore,
  type AcquireWorkspaceLeaseInput,
  type CompleteRunWithResultInput,
  type CreateParentMailboxInput,
  type CreateSubagentArtifactInput,
  type CreateSubagentRunInput,
  type CreateSubagentThreadInput,
  type ParentMailboxRecord,
  type SubagentMessageRecord,
  type SubagentOwnership,
  type SubagentRunRecord,
  type SubagentThreadRecord,
  type SubagentWorkspaceLeaseKind,
  type SubagentWorkspaceLeaseOwnerKind,
} from "../../src/runtime/subagents/stores/index.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T2：Subagent Stores 测试（plans/phase-14.md §25.1 / §25.2）
//
// - 六表 CRUD 与归属过滤（§22.1）；
// - message sequence 并发分配严格递增、重启不重复（§8.2 / §16.4 #2）；
// - 同 Thread 并发建 Run 只有一个成功（§7.2）；
// - 状态机非法转换抛稳定错误；terminal 重复写幂等（§7.2）；
// - terminal + result + mailbox 中途异常整体回滚（§16.4 #4 / §22.3）；
// - Lease 获取/续租/过期/释放（§15.4 / §18.3）。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createDatabase(directory?: string): Database.Database {
  const dir = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-stores-"));
  temporaryDirectories.push(dir);
  const db = openMetadataDatabase(path.join(dir, "metadata.db"));
  openDatabases.push(db);
  return db;
}

function createStores(db: Database.Database) {
  const threadStore = new ThreadStore(db);
  const runStore = new RunStore(db, threadStore);
  const messageStore = new MessageStore(db, threadStore);
  const artifactStore = new ArtifactStore(db, threadStore);
  const mailboxStore = new ParentMailboxStore(db);
  const leaseStore = new WorkspaceLeaseStore(db);
  const transactions = new SubagentTransactions(db, { threadStore, runStore, messageStore, mailboxStore });
  return { db, threadStore, runStore, messageStore, artifactStore, mailboxStore, leaseStore, transactions };
}

type Stores = ReturnType<typeof createStores>;

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

// ── fixtures ────────────────────────────────────────────────────

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

function threadInput(threadId: SubagentThreadId, own: SubagentOwnership): CreateSubagentThreadInput {
  return {
    threadId,
    ownerAgentId: own.ownerAgentId,
    parentSessionId: own.parentSessionId,
    createdFromTurnId: "turn-parent-1",
    title: "Research task",
    modelProviderId: "faux",
    modelId: "faux-model",
    modelSource: "parent_inherited",
    thinkingLevel: "medium",
    workspaceCwd: "C:/work/demo",
    capabilityCeiling: ceiling(),
    contextPacketHash: "packet-hash-12345678",
    createdAt: NOW,
  };
}

function runInput(runId: SubagentRunId, threadId: SubagentThreadId, triggerMessageId: AgentMessageId): CreateSubagentRunInput {
  return {
    runId,
    threadId,
    triggerMessageId,
    limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
    createdAt: NOW,
  };
}

function envelope(input: {
  messageId: AgentMessageId;
  threadId: SubagentThreadId;
  runId: SubagentRunId;
  messageType?: "task" | "progress" | "steer" | "input_required" | "result" | "error" | "cancel" | "status";
  senderKind?: "parent_agent" | "subagent" | "system";
  recipientKind?: "parent_agent" | "subagent";
  deliveryMode?: "immediate" | "queue" | "interrupt" | "mailbox";
  text?: string;
}): Omit<AgentMessageEnvelopeV1, "sequence"> {
  return {
    protocol: SUBAGENT_MESSAGE_PROTOCOL,
    version: 1,
    messageId: input.messageId,
    contextId: input.threadId,
    taskId: input.runId,
    sender: {
      kind: input.senderKind ?? "parent_agent",
      id: input.senderKind === "parent_agent" ? "agent-a" : input.senderKind === "system" ? "platform" : "sub-agent-1",
    },
    recipient: { kind: input.recipientKind ?? "subagent", id: input.threadId },
    messageType: input.messageType ?? "task",
    deliveryMode: input.deliveryMode ?? "immediate",
    parts: [{ kind: "text", text: input.text ?? "hello subagent" }],
    metadata: { createdAt: NOW, traceId: "trace-1", schemaName: "test" },
  };
}

function result(overrides?: Partial<SubagentResultV1>): SubagentResultV1 {
  return {
    version: 1,
    disposition: "satisfied",
    summary: "task done",
    criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }],
    artifacts: [],
    unresolvedIssues: [],
    recommendedNextAction: "accept",
    ...overrides,
  };
}

/** 组合事务创建 Thread + first Run + task message */
function createThreadWithRun(
  s: Stores,
  options?: { threadId?: SubagentThreadId; runId?: SubagentRunId; messageId?: AgentMessageId; own?: SubagentOwnership },
) {
  const threadId = options?.threadId ?? "sat_test000001";
  const runId = options?.runId ?? "sar_test0000001";
  const messageId = options?.messageId ?? "sam_test0000001";
  const own = options?.own ?? ownership();
  const out = s.transactions.createThreadWithFirstRun({
    thread: {
      threadId,
      title: "t",
      modelProviderId: "faux",
      modelId: "m",
      modelSource: "parent_inherited",
      thinkingLevel: "medium",
      workspaceCwd: "C:/w",
      capabilityCeiling: ceiling(),
      contextPacketHash: "hash12345678",
      createdFromTurnId: null,
    },
    ownership: own,
    firstRun: { runId, triggerMessageId: messageId },
    taskEnvelope: envelope({ messageId, threadId, runId }),
    now: NOW,
  });
  return { thread: out.thread, run: out.run, message: out.message, threadId, runId, own };
}

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SubagentStoreError);
    expect((error as SubagentStoreError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code} to be thrown`);
}

/** 将 Run 推到 running 态（queued → starting → running） */
function runToRunning(s: Stores, runId: SubagentRunId, own: SubagentOwnership): void {
  s.runStore.transit({ runId, from: "queued", to: "starting", reasonCode: null, now: NOW }, own);
  s.runStore.transit({ runId, from: "starting", to: "running", reasonCode: null, now: NOW }, own);
}

/** 构造属于给定 thread/run 的 Mailbox 入队输入（默认 completed/trigger=true） */
function mailboxInputFor(
  threadId: SubagentThreadId,
  runId: SubagentRunId,
  overrides?: Partial<CreateParentMailboxInput>,
): CreateParentMailboxInput {
  return {
    mailboxId: "smb_box00000001",
    ownerAgentId: "agent-a",
    parentSessionId: "sess-main",
    threadId,
    runId,
    messageId: "sam_test0000002",
    notificationKind: "completed",
    triggerParentTurn: true,
    operationId: "op-1",
    createdAt: NOW,
    ...overrides,
  };
}

// ═══════════════ ThreadStore ═══════════════

describe("ThreadStore", () => {
  it("create / get 往返：字段完整（含 capability ceiling JSON 与 created_from_turn_id）", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const thread = s.threadStore.create(threadInput("sat_test000001", own));
    expect(thread.threadId).toBe("sat_test000001");
    expect(thread.status).toBe("open");
    expect(thread.ownerAgentId).toBe("agent-a");
    expect(thread.parentSessionId).toBe("sess-main");
    expect(thread.createdFromTurnId).toBe("turn-parent-1");
    expect(thread.capabilityCeiling).toEqual(ceiling());
    expect(thread.nextMessageSequence).toBe(1);
    expect(thread.nextRunOrdinal).toBe(1);
    expect(thread.closedAt).toBeNull();

    const got = s.threadStore.get("sat_test000001", own);
    expect(got).toEqual(thread);
    expect(s.threadStore.get("sat_missing00001", own)).toBeNull();
  });

  it("归属过滤：其他 Agent / 其他 Session 查询抛 subagent_ownership_denied", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    s.threadStore.create(threadInput("sat_test000001", own));
    expectErrorCode(() => s.threadStore.get("sat_test000001", ownership("agent-b", "sess-main")), "subagent_ownership_denied");
    expectErrorCode(() => s.threadStore.get("sat_test000001", ownership("agent-a", "sess-other")), "subagent_ownership_denied");
  });

  it("listByOwner 按 owner/session 过滤并按 updated_at 倒序", () => {
    const s = createStores(createDatabase());
    s.threadStore.create(threadInput("sat_test000001", ownership("agent-a", "sess-main")));
    s.threadStore.create(threadInput("sat_test000002", ownership("agent-a", "sess-main")));
    s.threadStore.create(threadInput("sat_test000003", ownership("agent-b", "sess-main")));
    s.threadStore.create(threadInput("sat_test000004", ownership("agent-a", "sess-other")));
    expect(s.threadStore.listByOwner(ownership("agent-a", "sess-main"))).toHaveLength(2);
    expect(s.threadStore.listByOwner(ownership("agent-b", "sess-main"))).toHaveLength(1);
    expect(s.threadStore.listByOwner(ownership("agent-a", "sess-other"))).toHaveLength(1);
  });

  it("status 转换 open → closing → closed；非法转换抛 subagent_thread_state_conflict", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const threadId: SubagentThreadId = "sat_test000001";
    s.threadStore.create(threadInput(threadId, own));

    // open 直接 markClosed → 冲突
    expectErrorCode(() => s.threadStore.markClosed(threadId, own, NOW, null), "subagent_thread_state_conflict");

    const closing = s.threadStore.beginClosing(threadId, own, NOW);
    expect(closing.status).toBe("closing");
    // closing 再 beginClosing → 冲突
    expectErrorCode(() => s.threadStore.beginClosing(threadId, own, NOW), "subagent_thread_state_conflict");

    const closed = s.threadStore.markClosed(threadId, own, NOW, "done");
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBe(NOW);
    expect(closed.closeReason).toBe("done");
    // closed 再 markClosed → 冲突
    expectErrorCode(() => s.threadStore.markClosed(threadId, own, NOW, null), "subagent_thread_state_conflict");
  });

  it("touchActivity 推进 last_activity_at / updated_at", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const threadId: SubagentThreadId = "sat_test000001";
    s.threadStore.create(threadInput(threadId, own));
    s.threadStore.touchActivity(threadId, own, "2026-08-07T11:00:00.000Z");
    const thread = s.threadStore.get(threadId, own);
    expect(thread?.lastActivityAt).toBe("2026-08-07T11:00:00.000Z");
    expect(thread?.updatedAt).toBe("2026-08-07T11:00:00.000Z");
  });

  it("allocateMessageSequence 严格递增从 1 开始；closed Thread 拒绝分配", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const threadId: SubagentThreadId = "sat_test000001";
    s.threadStore.create(threadInput(threadId, own));
    expect(s.threadStore.allocateMessageSequence(threadId, own)).toBe(1);
    expect(s.threadStore.allocateMessageSequence(threadId, own)).toBe(2);
    expect(s.threadStore.allocateMessageSequence(threadId, own)).toBe(3);
    s.threadStore.beginClosing(threadId, own, NOW);
    s.threadStore.markClosed(threadId, own, NOW, null);
    expectErrorCode(() => s.threadStore.allocateMessageSequence(threadId, own), "subagent_thread_state_conflict");
  });

  it("allocateRunOrdinal 严格递增；closing/closed Thread 拒绝新 Run 序号", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const threadId: SubagentThreadId = "sat_test000001";
    s.threadStore.create(threadInput(threadId, own));
    expect(s.threadStore.allocateRunOrdinal(threadId, own)).toBe(1);
    expect(s.threadStore.allocateRunOrdinal(threadId, own)).toBe(2);
    s.threadStore.beginClosing(threadId, own, NOW);
    expectErrorCode(() => s.threadStore.allocateRunOrdinal(threadId, own), "subagent_thread_state_conflict");
  });
});

// ═══════════════ RunStore ═══════════════

describe("RunStore", () => {
  it("create：ordinal 分配；同 Thread 同时最多一个非终态 Run；终态后可建下一 Run", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const run = s.runStore.get(runId, own);
    expect(run?.status).toBe("queued");
    expect(run?.ordinal).toBe(1);
    expect(run?.limits).toEqual(SUBAGENT_RUN_LIMITS_DEFAULTS);

    // 活动 Run 存在 → 第二个 create 冲突
    expectErrorCode(() => s.runStore.create(runInput("sar_test0000002", threadId, "sam_test0000002"), own), "subagent_run_state_conflict");

    // 终态后允许下一 Run（ordinal 2）
    runToRunning(s, runId, own);
    s.runStore.completeRun(
      { runId, from: "running", to: "failed", result: null, reasonCode: "boom", usage: null, now: NOW },
      own,
    );
    const second = s.runStore.create(runInput("sar_test0000002", threadId, "sam_test0000002"), own);
    expect(second.ordinal).toBe(2);
  });

  it("并发建 Run：Promise.all 多路 create 只有一个成功，其余 subagent_run_state_conflict", async () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const threadId: SubagentThreadId = "sat_test000001";
    s.threadStore.create(threadInput(threadId, own)); // 只建 Thread，不建首 Run
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        try {
          s.runStore.create(
            runInput(`sar_concur${String(i).padStart(3, "0")}x` as SubagentRunId, threadId, `sam_concur${String(i).padStart(3, "0")}x` as AgentMessageId),
            own,
          );
          return "ok" as const;
        } catch (error) {
          return (error as SubagentStoreError).code;
        }
      }),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "subagent_run_state_conflict")).toHaveLength(7);
    expect(s.runStore.listByThread(threadId, own)).toHaveLength(1);
  });

  it("closed Thread 上不允许新建 Run", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId } = createThreadWithRun(s);
    s.threadStore.beginClosing(threadId, own, NOW);
    expectErrorCode(() => s.runStore.create(runInput("sar_test0000002", threadId, "sam_test0000002"), own), "subagent_thread_state_conflict");
  });

  it("归属过滤：其他 Agent 查询 Run 抛 subagent_ownership_denied", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    expectErrorCode(() => s.runStore.get(runId, ownership("agent-b", "sess-main")), "subagent_ownership_denied");
    expectErrorCode(
      () => s.runStore.transit({ runId, from: "queued", to: "starting", reasonCode: null, now: NOW }, ownership("agent-a", "sess-other")),
      "subagent_ownership_denied",
    );
  });

  it("transit 合法主路径：queued → starting → running → waiting_for_input → running → succeeded", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    const steps: Array<[SubagentRunStatus, SubagentRunStatus]> = [
      ["queued", "starting"],
      ["starting", "running"],
      ["running", "waiting_for_input"],
      ["waiting_for_input", "running"],
      ["running", "succeeded"],
    ];
    for (const [from, to] of steps) {
      const { run, idempotent } = s.runStore.transit({ runId, from, to, reasonCode: null, now: NOW }, own);
      expect(run.status).toBe(to);
      expect(idempotent).toBe(false);
    }
    const done = s.runStore.get(runId, own);
    expect(done?.finishedAt).toBe(NOW);
    expect(done?.revision).toBe(6);
    expect(done?.leaseBootId).toBeNull();
  });

  it("非法转换（含 from 不匹配、终态再转换）抛 subagent_run_state_conflict", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    // 状态机表外转换
    expectErrorCode(() => s.runStore.transit({ runId, from: "running", to: "queued", reasonCode: null, now: NOW }, own), "subagent_run_state_conflict");
    expectErrorCode(() => s.runStore.transit({ runId, from: "running", to: "starting", reasonCode: null, now: NOW }, own), "subagent_run_state_conflict");
    // from 不匹配当前状态
    expectErrorCode(() => s.runStore.transit({ runId, from: "queued", to: "succeeded", reasonCode: null, now: NOW }, own), "subagent_run_state_conflict");
    // 终态后不能再转换
    s.runStore.completeRun({ runId, from: "running", to: "succeeded", result: result(), reasonCode: null, usage: null, now: NOW }, own);
    expectErrorCode(() => s.runStore.transit({ runId, from: "succeeded", to: "failed", reasonCode: null, now: NOW }, own), "subagent_run_state_conflict");
  });

  it("completeRun：succeeded 必须携带 result；result 只允许 succeeded/failed；future version 拒绝", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    expectErrorCode(
      () => s.runStore.completeRun({ runId, from: "running", to: "succeeded", result: null, reasonCode: null, usage: null, now: NOW }, own),
      "subagent_result_not_reported",
    );
    // result 只允许 succeeded/failed：timed_out 是 running 的合法终态，携带 result → 拒绝
    expectErrorCode(
      () => s.runStore.completeRun({ runId, from: "running", to: "timed_out", result: result(), reasonCode: null, usage: null, now: NOW }, own),
      "subagent_operation_failed",
    );
    const badResult = { ...result(), version: 2 } as unknown as SubagentResultV1;
    expectErrorCode(
      () => s.runStore.completeRun({ runId, from: "running", to: "succeeded", result: badResult, reasonCode: null, usage: null, now: NOW }, own),
      "subagent_operation_failed",
    );
    // 非终态 to 拒绝
    expectErrorCode(
      () => s.runStore.completeRun({ runId, from: "running", to: "starting", result: null, reasonCode: null, usage: null, now: NOW }, own),
      "subagent_run_state_conflict",
    );
  });

  it("terminal 重复写幂等：已终态返回已有记录，不重复副作用", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    const first = s.runStore.completeRun(
      { runId, from: "running", to: "succeeded", result: result(), reasonCode: null, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, now: NOW },
      own,
    );
    const second = s.runStore.completeRun(
      { runId, from: "running", to: "succeeded", result: result(), reasonCode: null, usage: null, now: NOW },
      own,
    );
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.run).toEqual(first.run);
    expect(second.run.result?.summary).toBe("task done");
    expect(second.run.totalTokens).toBe(15);
    expect(second.run.finishedAt).toBe(NOW);
    // 终态写入清 Lease
    expect(second.run.leaseBootId).toBeNull();
  });

  it("startWithSnapshot：queued → starting + snapshot + Lease 单事务；非法 limits 拒绝", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    const badLimits = { ...SUBAGENT_RUN_LIMITS_DEFAULTS, maxTotalTokens: 50 };
    expectErrorCode(
      () =>
        s.runStore.startWithSnapshot(
          { runId, snapshotId: "sas_snap0000001", snapshotJson: "{}", limits: badLimits, leaseBootId: "boot-1", leaseHolderId: "host-1", leaseExpiresAt: "2026-08-07T10:00:45.000Z", now: NOW },
          own,
        ),
      "subagent_operation_failed",
    );
    const started = s.runStore.startWithSnapshot(
      { runId, snapshotId: "sas_snap0000001", snapshotJson: "{}", limits: SUBAGENT_RUN_LIMITS_DEFAULTS, leaseBootId: "boot-1", leaseHolderId: "host-1", leaseExpiresAt: "2026-08-07T10:00:45.000Z", now: NOW },
      own,
    );
    expect(started.status).toBe("starting");
    expect(started.snapshotId).toBe("sas_snap0000001");
    expect(started.leaseBootId).toBe("boot-1");
    expect(started.leaseHolderId).toBe("host-1");
    expect(started.startedAt).toBe(NOW);
    // 非 queued 不可再次 start
    expectErrorCode(
      () =>
        s.runStore.startWithSnapshot(
          { runId, snapshotId: "sas_snap0000002", snapshotJson: "{}", limits: SUBAGENT_RUN_LIMITS_DEFAULTS, leaseBootId: "boot-2", leaseHolderId: "host-2", leaseExpiresAt: "2026-08-07T10:00:45.000Z", now: NOW },
          own,
        ),
      "subagent_run_state_conflict",
    );
  });

  it("Runtime Lease：仅持有者可续租/释放；过期后续租失败（Lease 丢失）", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    s.runStore.startWithSnapshot(
      { runId, snapshotId: "sas_snap0000001", snapshotJson: "{}", limits: SUBAGENT_RUN_LIMITS_DEFAULTS, leaseBootId: "boot-1", leaseHolderId: "host-1", leaseExpiresAt: "2026-08-07T10:00:45.000Z", now: NOW },
      own,
    );
    // 持有者续租成功
    expect(
      s.runStore.renewLease({ runId, bootId: "boot-1", holderId: "host-1", expiresAt: "2026-08-07T10:01:45.000Z", now: "2026-08-07T10:00:30.000Z" }, own),
    ).toBe(true);
    // 非持有者续租失败
    expect(
      s.runStore.renewLease({ runId, bootId: "boot-2", holderId: "host-2", expiresAt: "2026-08-07T10:01:45.000Z", now: "2026-08-07T10:00:30.000Z" }, own),
    ).toBe(false);
    // 过期后续租失败（Lease 丢失 → Host 必须 abort）：now 超过当前 expires_at
    expect(
      s.runStore.renewLease({ runId, bootId: "boot-1", holderId: "host-1", expiresAt: "2026-08-07T10:02:45.000Z", now: "2026-08-07T10:02:00.000Z" }, own),
    ).toBe(false);
    // 非持有者释放失败；持有者释放成功
    expect(s.runStore.releaseLease({ runId, bootId: "boot-9", holderId: "host-9", now: NOW }, own)).toBe(false);
    expect(s.runStore.releaseLease({ runId, bootId: "boot-1", holderId: "host-1", now: NOW }, own)).toBe(true);
    const after = s.runStore.get(runId, own);
    expect(after?.leaseBootId).toBeNull();
    expect(after?.leaseExpiresAt).toBeNull();
  });

  it("updateProgress 更新用量/阶段/Tool；缺失字段保留原值", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { runId } = createThreadWithRun(s);
    s.runStore.updateProgress(
      { runId, now: NOW, iterationCount: 3, toolCallCount: 2, inputTokens: 100, outputTokens: 50, totalTokens: 150, currentPhase: "research", currentTool: "read_file", lastActivityAt: NOW },
      own,
    );
    const updated = s.runStore.updateProgress(
      { runId, now: NOW, iterationCount: null, toolCallCount: null, inputTokens: 200, outputTokens: null, totalTokens: null, currentPhase: null, currentTool: "search", lastActivityAt: NOW },
      own,
    );
    expect(updated?.iterationCount).toBe(3); // null 保留原值
    expect(updated?.inputTokens).toBe(200);
    expect(updated?.toolCallCount).toBe(2);
    expect(updated?.currentTool).toBe("search");
    expect(updated?.currentPhase).toBe("research");
  });
});

// ═══════════════ MessageStore ═══════════════

describe("MessageStore", () => {
  it("append：sequence 由 Thread 行分配，从 1 严格递增；Envelope 往返一致", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const m1 = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    const m2 = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000003", threadId, runId, messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    expect(m1.message.sequence).toBe(2);
    expect(m2.message.sequence).toBe(3);
    expect(m1.message.envelope.messageId).toBe("sam_test0000002");
    expect(m1.message.envelope.parts).toEqual([{ kind: "text", text: "hello subagent" }]);
    expect(m1.message.deliveryStatus).toBe("queued");
    expect(m2.message.sequence).toBe(m1.message.sequence + 1);
  });

  it("sequence 并发分配严格递增、无重复（Promise.all 30 路 append）", async () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const records = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        s.messageStore.append({
          envelope: envelope({
            messageId: `sam_bulk${String(i).padStart(3, "0")}xx` as AgentMessageId,
            threadId,
            runId,
            messageType: "progress",
            senderKind: "subagent",
            text: `m${i}`,
          }),
          ownership: own,
          createdAt: NOW,
        }),
      ),
    );
    const sequences = records.map((r) => r.message.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 30 }, (_, i) => i + 2)); // 1 是首条 task message
    expect(new Set(sequences).size).toBe(30);
    // 全程严格单调（无 gap、无重复）
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }
  });

  it("重启不重复：关闭重开数据库后 sequence 继续递增", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-stores-"));
    const dbPath = path.join(directory, "metadata.db");
    let db = createDatabase(directory);
    let s = createStores(db);
    const own = ownership();
    createThreadWithRun(s);
    s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000002", threadId: "sat_test000001", runId: "sar_test0000001", messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    db.close();

    db = openMetadataDatabase(dbPath);
    openDatabases.push(db);
    s = createStores(db);
    const after = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000003", threadId: "sat_test000001", runId: "sar_test0000001", messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    expect(after.message.sequence).toBe(3);
    // 原消息仍在（持久化）
    expect(s.messageStore.listByThread("sat_test000001", own)).toHaveLength(3);
  });

  it("非法 Envelope 拒绝：future version / 缺必填 / 超长", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const base = envelope({ messageId: "sam_test0000002", threadId, runId });
    expectErrorCode(
      () => s.messageStore.append({ envelope: { ...base, version: 2 } as unknown as Omit<AgentMessageEnvelopeV1, "sequence">, ownership: own, createdAt: NOW }),
      "subagent_operation_failed",
    );
    const noParts = { ...base, parts: [] } as unknown as Omit<AgentMessageEnvelopeV1, "sequence">;
    expectErrorCode(() => s.messageStore.append({ envelope: noParts, ownership: own, createdAt: NOW }), "subagent_operation_failed");
    const longText = { ...base, parts: [{ kind: "text", text: "x".repeat(70_000) }] } as unknown as Omit<AgentMessageEnvelopeV1, "sequence">;
    expectErrorCode(() => s.messageStore.append({ envelope: longText, ownership: own, createdAt: NOW }), "subagent_operation_failed");
  });

  it("消息权限（§8.3）：sender × messageType 不匹配拒绝", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    expectErrorCode(
      () =>
        s.messageStore.append({
          envelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "task", senderKind: "subagent" }),
          ownership: own,
          createdAt: NOW,
        }),
      "subagent_operation_failed",
    );
    expectErrorCode(
      () =>
        s.messageStore.append({
          envelope: envelope({ messageId: "sam_test0000003", threadId, runId, messageType: "result", senderKind: "system" }),
          ownership: own,
          createdAt: NOW,
        }),
      "subagent_operation_failed",
    );
    expectErrorCode(
      () =>
        s.messageStore.append({
          envelope: envelope({ messageId: "sam_test0000004", threadId, runId, messageType: "status", senderKind: "parent_agent" }),
          ownership: own,
          createdAt: NOW,
        }),
      "subagent_operation_failed",
    );
  });

  it("context/task 引用校验（§22.1）：contextId 必须等于 thread；taskId 必须存在且属于该 thread", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    expectErrorCode(
      () =>
        s.messageStore.append({
          envelope: envelope({ messageId: "sam_test0000002", threadId: "sat_other000001", runId, messageType: "progress", senderKind: "subagent" }),
          ownership: own,
          createdAt: NOW,
        }),
      "subagent_not_found",
    );
    expectErrorCode(
      () =>
        s.messageStore.append({
          envelope: envelope({ messageId: "sam_test0000003", threadId, runId: "sar_other000001", messageType: "progress", senderKind: "subagent" }),
          ownership: own,
          createdAt: NOW,
        }),
      "subagent_not_found",
    );
    // taskId 属于其他 thread → fail-closed（operation_failed）
    const other = createThreadWithRun(s, { threadId: "sat_test000002", runId: "sar_test0000002", messageId: "sam_test0000002" });
    expectErrorCode(
      () =>
        s.messageStore.append({
          envelope: envelope({ messageId: "sam_test0000005", threadId, runId: other.runId, messageType: "progress", senderKind: "subagent" }),
          ownership: own,
          createdAt: NOW,
        }),
      "subagent_operation_failed",
    );
  });

  it("messageId 幂等：重复写返回原记录，不消耗新 sequence", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const first = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "progress", senderKind: "subagent", text: "v1" }),
      ownership: own,
      createdAt: NOW,
    });
    const replay = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "progress", senderKind: "subagent", text: "v2-different" }),
      ownership: own,
      createdAt: NOW,
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.message).toEqual(first.message);
    expect(replay.message.envelope.parts).toEqual([{ kind: "text", text: "v1" }]);
    // 下一次 append 的 sequence 未跳号
    const next = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000003", threadId, runId, messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    expect(next.message.sequence).toBe(3);
  });

  it("closed Thread 拒绝新消息", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    s.threadStore.beginClosing(threadId, own, NOW);
    s.threadStore.markClosed(threadId, own, NOW, null);
    expectErrorCode(
      () =>
        s.messageStore.append({
          envelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "progress", senderKind: "subagent" }),
          ownership: own,
          createdAt: NOW,
        }),
      "subagent_thread_state_conflict",
    );
  });

  it("delivery_status 流转 queued → delivering → delivered（含 consumed_at）；幂等", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const { message } = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    expect(s.messageStore.markDelivering(message.messageId, own)).toBe(true);
    expect(s.messageStore.markDelivering(message.messageId, own)).toBe(true); // 幂等
    expect(s.messageStore.markDelivered(message.messageId, own, "2026-08-07T10:05:00.000Z")).toBe(true);
    expect(s.messageStore.markDelivered(message.messageId, own, null)).toBe(true); // 已 delivered 幂等
    const record = s.messageStore.get(message.messageId, own);
    expect(record?.deliveryStatus).toBe("delivered");
    expect(record?.consumedAt).toBe("2026-08-07T10:05:00.000Z");
  });

  it("delivery_status failed 流转；已 delivered 不再降级", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const a = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    const b = s.messageStore.append({
      envelope: envelope({ messageId: "sam_test0000003", threadId, runId, messageType: "progress", senderKind: "subagent" }),
      ownership: own,
      createdAt: NOW,
    });
    expect(s.messageStore.markDeliveryFailed(a.message.messageId, own)).toBe(true);
    expect(s.messageStore.markDeliveryFailed(a.message.messageId, own)).toBe(true); // 幂等
    expect(s.messageStore.get(a.message.messageId, own)?.deliveryStatus).toBe("failed");
    // delivered 后 markDeliveryFailed 返回 false
    s.messageStore.markDelivered(b.message.messageId, own, null);
    expect(s.messageStore.markDeliveryFailed(b.message.messageId, own)).toBe(false);
    expect(s.messageStore.get(b.message.messageId, own)?.deliveryStatus).toBe("delivered");
  });

  it("listByThread afterSequence / limit；listByRun 过滤", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    for (let i = 2; i <= 6; i += 1) {
      s.messageStore.append({
        envelope: envelope({ messageId: `sam_test00000${i}` as AgentMessageId, threadId, runId, messageType: "progress", senderKind: "subagent", text: `m${i}` }),
        ownership: own,
        createdAt: NOW,
      });
    }
    const all = s.messageStore.listByThread(threadId, own);
    expect(all).toHaveLength(6);
    expect(all[0]?.sequence).toBe(1);
    expect(all[5]?.sequence).toBe(6);
    const after = s.messageStore.listByThread(threadId, own, { afterSequence: 3, limit: 2 });
    expect(after.map((m) => m.sequence)).toEqual([4, 5]);
    expect(s.messageStore.listByRun(runId, own)).toHaveLength(6);
  });
});

// ═══════════════ ArtifactStore ═══════════════

describe("ArtifactStore", () => {
  const ARTIFACT_ID: SubagentArtifactId = "saa_art00000001";

  function artifactInput(artifactId: SubagentArtifactId, threadId: SubagentThreadId, runId: SubagentRunId): CreateSubagentArtifactInput {
    return {
      artifactId,
      threadId,
      runId,
      kind: "file",
      name: "report.md",
      mimeType: "text/markdown",
      contentHash: "sha256-abcdefgh12345678",
      sizeBytes: 1024,
      resourceKind: "subagent_artifact",
      resourceId: artifactId,
      canonicalPath: "C:/work/demo/artifacts/report.md",
      visibility: "parent",
      createdAt: NOW,
    };
  }

  it("create / get / list / update / delete + 归属过滤", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const artifact = s.artifactStore.create(artifactInput(ARTIFACT_ID, threadId, runId), own);
    expect(artifact.name).toBe("report.md");
    expect(s.artifactStore.get(ARTIFACT_ID, own)?.contentHash).toBe("sha256-abcdefgh12345678");
    expect(s.artifactStore.listByThread(threadId, own)).toHaveLength(1);
    expect(s.artifactStore.listByRun(runId, own)).toHaveLength(1);
    // 归属过滤
    expectErrorCode(() => s.artifactStore.get(ARTIFACT_ID, ownership("agent-b", "sess-main")), "subagent_ownership_denied");
    // 幂等 create 返回原记录
    const replay = s.artifactStore.create({ ...artifactInput(ARTIFACT_ID, threadId, runId), name: "different-name.md" }, own);
    expect(replay.artifactId).toBe(ARTIFACT_ID);
    expect(replay.name).toBe("report.md");
    // update / delete
    expect(s.artifactStore.updateMetadata(ARTIFACT_ID, own, { visibility: "user", sizeBytes: 2048 })).toBe(true);
    expect(s.artifactStore.get(ARTIFACT_ID, own)?.visibility).toBe("user");
    expect(s.artifactStore.delete(ARTIFACT_ID, own)).toBe(true);
    expect(s.artifactStore.get(ARTIFACT_ID, own)).toBeNull();
  });

  it("run/thread 引用校验：run 不存在或不属于 thread 拒绝", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    expectErrorCode(
      () => s.artifactStore.create({ ...artifactInput("saa_art00000003", threadId, "sar_missing00001"), runId: "sar_missing00001" }, own),
      "subagent_not_found",
    );
    // run 属于其他 thread → fail-closed
    const other = createThreadWithRun(s, { threadId: "sat_test000002", runId: "sar_test0000002", messageId: "sam_test0000002" });
    expectErrorCode(
      () => s.artifactStore.create({ ...artifactInput("saa_art00000004", threadId, other.runId) }, own),
      "subagent_operation_failed",
    );
  });
});

// ═══════════════ ParentMailboxStore ═══════════════

describe("ParentMailboxStore", () => {
  function mailboxInput(overrides?: Partial<CreateParentMailboxInput>): CreateParentMailboxInput {
    return {
      mailboxId: "smb_box00000001",
      ownerAgentId: "agent-a",
      parentSessionId: "sess-main",
      threadId: "sat_test000001",
      runId: "sar_test0000001",
      messageId: "sam_test0000002",
      notificationKind: "completed",
      triggerParentTurn: true,
      operationId: "op-1",
      createdAt: NOW,
      ...overrides,
    };
  }

  it("enqueue 幂等：UNIQUE(message_id) 重复入队返回原记录", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const input = mailboxInput({ mailboxId: "smb_box00000001", threadId, runId, messageId: "sam_test0000002", operationId: "op-1" });
    const first = s.mailboxStore.enqueue(input);
    expect(first.status).toBe("queued");
    expect(first.attemptCount).toBe(0);
    const replay = s.mailboxStore.enqueue({ ...input, operationId: "op-1-different" });
    expect(replay).toEqual(first);
    expect(s.mailboxStore.listByThread(threadId, own)).toHaveLength(1);
  });

  it("triggerParentTurn 只允许触发类通知（started 不唤醒父 Turn）", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    expectErrorCode(
      () =>
        s.mailboxStore.enqueue(
          mailboxInput({ mailboxId: "smb_box00000001", threadId, runId, messageId: "sam_test0000002", notificationKind: "started", triggerParentTurn: true, operationId: "op-1" }),
        ),
      "subagent_operation_failed",
    );
    // started + trigger=false → 允许（状态查询用）
    const started = s.mailboxStore.enqueue(
      mailboxInput({ mailboxId: "smb_box00000002", threadId, runId, messageId: "sam_test0000003", notificationKind: "started", triggerParentTurn: false, operationId: "op-2" }),
    );
    expect(started.triggerParentTurn).toBe(false);
    expect(started.status).toBe("queued");
  });

  it("status 流转：queued → delivering(attempt+1) → delivered；failed → requeue → delivered", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const box1: ParentMailboxId = "smb_box00000001";
    const box2: ParentMailboxId = "smb_box00000002";
    s.mailboxStore.enqueue(mailboxInput({ mailboxId: box1, threadId, runId, messageId: "sam_test0000002", operationId: "op-1" }));
    expect(s.mailboxStore.markDelivering(box1, own)).toBe(true);
    expect(s.mailboxStore.markDelivering(box1, own)).toBe(true); // 幂等
    expect(s.mailboxStore.markDelivered(box1, own, "2026-08-07T10:06:00.000Z")).toBe(true);
    expect(s.mailboxStore.markDelivered(box1, own, "2026-08-07T10:06:00.000Z")).toBe(true);
    const delivered = s.mailboxStore.get(box1, own);
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.attemptCount).toBe(1);
    expect(delivered?.deliveredAt).toBe("2026-08-07T10:06:00.000Z");
    // 已 delivered 不可 suppressed
    expect(s.mailboxStore.markSuppressed(box1, own, NOW)).toBe(false);

    // failed → requeue → delivered
    s.mailboxStore.enqueue(mailboxInput({ mailboxId: box2, threadId, runId, messageId: "sam_test0000003", operationId: "op-2" }));
    expect(s.mailboxStore.markFailed(box2, own, "delivery_timeout", "2026-08-07T10:10:00.000Z")).toBe(true);
    expect(s.mailboxStore.get(box2, own)?.lastErrorCode).toBe("delivery_timeout");
    expect(s.mailboxStore.requeue(box2, own)).toBe(true);
    expect(s.mailboxStore.get(box2, own)?.status).toBe("queued");
    expect(s.mailboxStore.markDelivered(box2, own, NOW)).toBe(true);
  });

  it("suppressed：queued/failed → suppressed；listPending 只含 queued+delivering；归属过滤", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    const box1: ParentMailboxId = "smb_box00000001";
    const box2: ParentMailboxId = "smb_box00000002";
    s.mailboxStore.enqueue(mailboxInput({ mailboxId: box1, threadId, runId, messageId: "sam_test0000002", operationId: "op-1" }));
    s.mailboxStore.enqueue(
      mailboxInput({ mailboxId: box2, threadId, runId, messageId: "sam_test0000003", notificationKind: "input_required", operationId: "op-2" }),
    );
    expect(s.mailboxStore.listPending("sess-main", own)).toHaveLength(2);
    expect(s.mailboxStore.markSuppressed(box1, own, NOW)).toBe(true);
    expect(s.mailboxStore.get(box1, own)?.status).toBe("suppressed");
    expect(s.mailboxStore.get(box1, own)?.suppressedAt).toBe(NOW);
    expect(s.mailboxStore.listPending("sess-main", own)).toHaveLength(1);
    // 归属过滤：get 抛 ownership_denied；mark 亦抛 ownership_denied（行存在但归属不匹配）
    expectErrorCode(() => s.mailboxStore.get(box2, ownership("agent-b", "sess-main")), "subagent_ownership_denied");
    expectErrorCode(() => s.mailboxStore.markDelivered(box2, ownership("agent-b", "sess-main"), NOW), "subagent_ownership_denied");
  });

  it("insert 严格插入：UNIQUE(operation_id) 冲突抛 subagent_operation_failed", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    s.mailboxStore.insert(mailboxInput({ mailboxId: "smb_box00000001", threadId, runId, messageId: "sam_test0000002", operationId: "op-1" }));
    expectErrorCode(
      () => s.mailboxStore.insert(mailboxInput({ mailboxId: "smb_box00000002", threadId, runId, messageId: "sam_test0000003", operationId: "op-1" })),
      "subagent_operation_failed",
    );
  });
});

// ═══════════════ WorkspaceLeaseStore ═══════════════

describe("WorkspaceLeaseStore", () => {
  const WS = "W:/workspaces/demo";
  function acquireInput(bootId: string, ownerId: string, expiresAt: string, now = "2026-08-07T10:00:00.000Z"): AcquireWorkspaceLeaseInput {
    return {
      canonicalWorkspace: WS,
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId,
      bootId,
      expiresAt,
      now,
    };
  }

  it("获取/续租/释放：compare-and-set on canonical_workspace + expires_at", () => {
    const s = createStores(createDatabase());
    expect(s.leaseStore.acquire(acquireInput("boot-1", "sar_run1", "2026-08-07T10:30:00.000Z"))).toBe(true);
    // 其他执行者未过期持有 → 拒绝
    expect(s.leaseStore.acquire(acquireInput("boot-2", "sar_run2", "2026-08-07T10:30:00.000Z"))).toBe(false);
    expect(s.leaseStore.get(WS)?.bootId).toBe("boot-1");
    // 同 bootId 重新获取 → 接管成功
    expect(s.leaseStore.acquire(acquireInput("boot-1", "sar_run1", "2026-08-07T10:31:00.000Z"))).toBe(true);
    // 持有者续租
    expect(s.leaseStore.renew({ canonicalWorkspace: WS, bootId: "boot-1", ownerId: "sar_run1", expiresAt: "2026-08-07T10:35:00.000Z", now: "2026-08-07T10:02:00.000Z" })).toBe(true);
    // 非持有者续租失败
    expect(s.leaseStore.renew({ canonicalWorkspace: WS, bootId: "boot-9", ownerId: "sar_run9", expiresAt: "2026-08-07T10:35:00.000Z", now: "2026-08-07T10:02:00.000Z" })).toBe(false);
    // 非持有者释放失败；持有者释放成功
    expect(s.leaseStore.release({ canonicalWorkspace: WS, bootId: "boot-9", ownerId: "sar_run9" })).toBe(false);
    expect(s.leaseStore.release({ canonicalWorkspace: WS, bootId: "boot-1", ownerId: "sar_run1" })).toBe(true);
    expect(s.leaseStore.get(WS)).toBeNull();
  });

  it("过期接管：expires_at <= now 时其他执行者可以获取；过期后原持有者续租失败", () => {
    const s = createStores(createDatabase());
    expect(s.leaseStore.acquire(acquireInput("boot-1", "sar_run1", "2026-08-07T09:00:00.000Z"))).toBe(true); // 已过期
    expect(s.leaseStore.acquire(acquireInput("boot-2", "sar_run2", "2026-08-07T10:30:00.000Z"))).toBe(true);
    expect(s.leaseStore.get(WS)?.bootId).toBe("boot-2");
    expect(s.leaseStore.renew({ canonicalWorkspace: WS, bootId: "boot-1", ownerId: "sar_run1", expiresAt: "2026-08-07T10:30:00.000Z", now: "2026-08-07T10:00:00.000Z" })).toBe(false);
  });

  it("listActive / deleteExpired：过期行清理", () => {
    const s = createStores(createDatabase());
    s.leaseStore.acquire(acquireInput("boot-1", "sar_run1", "2026-08-07T09:00:00.000Z")); // 过期
    s.leaseStore.acquire({ ...acquireInput("boot-2", "sar_run2", "2026-08-07T11:00:00.000Z"), canonicalWorkspace: "W:/workspaces/b" });
    expect(s.leaseStore.listActive("2026-08-07T10:00:00.000Z")).toHaveLength(1);
    expect(s.leaseStore.deleteExpired("2026-08-07T10:00:00.000Z")).toBe(1);
    expect(s.leaseStore.get(WS)).toBeNull();
    expect(s.leaseStore.get("W:/workspaces/b")).not.toBeNull();
  });

  it("非法 leaseKind / ownerKind 拒绝", () => {
    const s = createStores(createDatabase());
    expectErrorCode(
      () => s.leaseStore.acquire({ ...acquireInput("boot-1", "x", "2026-08-07T10:30:00.000Z"), leaseKind: "bogus" as SubagentWorkspaceLeaseKind }),
      "subagent_operation_failed",
    );
    expectErrorCode(
      () => s.leaseStore.acquire({ ...acquireInput("boot-1", "x", "2026-08-07T10:30:00.000Z"), ownerKind: "bogus" as SubagentWorkspaceLeaseOwnerKind }),
      "subagent_operation_failed",
    );
  });
});

// ═══════════════ 关键事务（§16.4） ═══════════════

describe("SubagentTransactions", () => {
  it("createThreadWithFirstRun：Thread + first Run + 首条 task message 单事务落地", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { thread, run, message } = createThreadWithRun(s);
    expect(thread.status).toBe("open");
    expect(run.status).toBe("queued");
    expect(run.ordinal).toBe(1);
    expect(message.messageType).toBe("task");
    expect(message.sequence).toBe(1);
    expect(message.envelope.contextId).toBe(thread.threadId);
    expect(s.messageStore.listByThread(thread.threadId, own)).toHaveLength(1);
    expect(s.runStore.listByThread(thread.threadId, own)).toHaveLength(1);
  });

  it("completeRunWithResult：terminal + result + result message + mailbox 原子写入", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    const out = s.transactions.completeRunWithResult({
      runId,
      threadId,
      ownership: own,
      from: "running",
      to: "succeeded",
      result: result(),
      reasonCode: null,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      resultEnvelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "result", senderKind: "subagent" }),
      mailbox: {
        mailboxId: "smb_box00000001",
        messageId: "sam_test0000002",
        notificationKind: "completed",
        operationId: "op-complete-1",
        triggerParentTurn: true,
      },
      now: "2026-08-07T10:20:00.000Z",
    });
    expect(out.idempotent).toBe(false);
    expect(out.run.status).toBe("succeeded");
    expect(out.run.result?.disposition).toBe("satisfied");
    expect(out.run.totalTokens).toBe(30);
    expect(out.run.finishedAt).toBe("2026-08-07T10:20:00.000Z");
    expect(out.message?.messageType).toBe("result");
    expect(out.message?.sequence).toBe(2);
    expect(out.mailbox?.status).toBe("queued");
    expect(out.mailbox?.triggerParentTurn).toBe(true);
    expect(s.mailboxStore.getByMessageId("sam_test0000002", own)?.notificationKind).toBe("completed");
  });

  it("completeRunWithResult 幂等重放：不写新消息/新 mailbox 行", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    const input: CompleteRunWithResultInput = {
      runId,
      threadId,
      ownership: own,
      from: "running",
      to: "succeeded",
      result: result(),
      reasonCode: null,
      usage: null,
      resultEnvelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "result", senderKind: "subagent" }),
      mailbox: {
        mailboxId: "smb_box00000001",
        messageId: "sam_test0000002",
        notificationKind: "completed",
        operationId: "op-complete-1",
        triggerParentTurn: true,
      },
      now: "2026-08-07T10:20:00.000Z",
    };
    const first = s.transactions.completeRunWithResult(input);
    const replay = s.transactions.completeRunWithResult(input);
    expect(replay.idempotent).toBe(true);
    expect(replay.message).toBeNull();
    expect(replay.mailbox).toBeNull();
    expect(replay.run).toEqual(first.run);
    expect(s.messageStore.listByThread(threadId, own)).toHaveLength(2); // task + result，未重复
    expect(s.mailboxStore.listByThread(threadId, own)).toHaveLength(1);
  });

  it("中途异常整体回滚：mailbox operationId 冲突 → Run 保持原状态、无新消息", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    // 先占用 op-complete-1（run1 终态后仍保留该 mailbox 行）
    s.mailboxStore.enqueue(mailboxInputFor(threadId, runId, { operationId: "op-complete-1" }));
    s.runStore.completeRun({ runId, from: "running", to: "failed", result: null, reasonCode: "x", usage: null, now: NOW }, own);
    // 新 Run（run1 已终态 → 允许创建）
    const second = s.runStore.create(runInput("sar_test0000002", threadId, "sam_test0000003"), own);
    runToRunning(s, second.runId, own);
    expectErrorCode(
      () =>
        s.transactions.completeRunWithResult({
          runId: second.runId,
          threadId,
          ownership: own,
          from: "running",
          to: "succeeded",
          result: result(),
          reasonCode: null,
          usage: null,
          resultEnvelope: envelope({ messageId: "sam_test0000003", threadId, runId: second.runId, messageType: "result", senderKind: "subagent" }),
          mailbox: {
            mailboxId: "smb_box00000002",
            messageId: "sam_test0000003",
            notificationKind: "completed",
            operationId: "op-complete-1", // 与已有行冲突 → 整体回滚
            triggerParentTurn: true,
          },
          now: "2026-08-07T10:20:00.000Z",
        }),
      "subagent_operation_failed",
    );
    // 整体回滚断言：run2 仍 running、无 result；消息/邮箱行数不变
    const run2 = s.runStore.get(second.runId, own);
    expect(run2?.status).toBe("running");
    expect(run2?.result).toBeNull();
    expect(s.messageStore.listByThread(threadId, own)).toHaveLength(1); // 只有首条 task message
    expect(s.mailboxStore.listByThread(threadId, own)).toHaveLength(1);
  });

  it("中途异常整体回滚：非法 Envelope（权限不匹配）→ Run 保持原状态", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    expectErrorCode(
      () =>
        s.transactions.completeRunWithResult({
          runId,
          threadId,
          ownership: own,
          from: "running",
          to: "succeeded",
          result: result(),
          reasonCode: null,
          usage: null,
          // system 不能发 result → append 校验失败 → 整体回滚
          resultEnvelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "result", senderKind: "system" }),
          mailbox: {
            mailboxId: "smb_box00000001",
            messageId: "sam_test0000002",
            notificationKind: "completed",
            operationId: "op-complete-1",
            triggerParentTurn: true,
          },
          now: "2026-08-07T10:20:00.000Z",
        }),
      "subagent_operation_failed",
    );
    expect(s.runStore.get(runId, own)?.status).toBe("running");
    expect(s.runStore.get(runId, own)?.result).toBeNull();
    expect(s.messageStore.listByThread(threadId, own)).toHaveLength(1);
    expect(s.mailboxStore.listByThread(threadId, own)).toHaveLength(0);
  });

  it("completeRunWithResult 支持无 result 终态（cancelled/timed_out/interrupted/budget_exhausted）", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    // 取消路径：running → cancelling → cancelled（冻结状态机表，无 running → cancelled 直跳）
    s.runStore.transit({ runId, from: "running", to: "cancelling", reasonCode: null, now: NOW }, own);
    const out = s.transactions.completeRunWithResult({
      runId,
      threadId,
      ownership: own,
      from: "cancelling",
      to: "cancelled",
      result: null,
      reasonCode: "parent_cancelled",
      usage: null,
      resultEnvelope: envelope({ messageId: "sam_test0000002", threadId, runId, messageType: "cancel", senderKind: "parent_agent", deliveryMode: "mailbox" }),
      mailbox: {
        mailboxId: "smb_box00000001",
        messageId: "sam_test0000002",
        notificationKind: "cancelled",
        operationId: "op-cancel-1",
        triggerParentTurn: true,
      },
      now: "2026-08-07T10:20:00.000Z",
    });
    expect(out.run.status).toBe("cancelled");
    expect(out.run.reasonCode).toBe("parent_cancelled");
    expect(out.run.result).toBeNull();
    expect(out.mailbox?.notificationKind).toBe("cancelled");
  });

  it("closeThread：有活动 Run 仅 closing；取消后 closed；已 closed 幂等", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    // 有活动 Run → 仅进入 closing
    const closing = s.transactions.closeThread({ threadId, ownership: own, at: NOW, closeReason: "parent archived", suppressMailboxIds: [] });
    expect(closing.closedNow).toBe(false);
    expect(closing.thread.status).toBe("closing");
    // 取消 Run 后 close 完成（running → cancelling → cancelled）
    runToRunning(s, runId, own);
    s.runStore.transit({ runId, from: "running", to: "cancelling", reasonCode: null, now: NOW }, own);
    s.runStore.completeRun({ runId, from: "cancelling", to: "cancelled", result: null, reasonCode: "close", usage: null, now: NOW }, own);

    const done = s.transactions.closeThread({
      threadId,
      ownership: own,
      at: "2026-08-07T10:30:00.000Z",
      closeReason: "parent archived",
      suppressMailboxIds: [],
    });
    expect(done.closedNow).toBe(true);
    expect(done.thread.status).toBe("closed");
    expect(done.thread.closedAt).toBe("2026-08-07T10:30:00.000Z");
    // 幂等
    const replay = s.transactions.closeThread({ threadId, ownership: own, at: NOW, closeReason: null, suppressMailboxIds: [] });
    expect(replay.closedNow).toBe(false);
    expect(replay.thread.status).toBe("closed");
  });

  it("closeThread：suppressMailboxIds 与 closed 同事务", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { threadId, runId } = createThreadWithRun(s);
    runToRunning(s, runId, own);
    s.runStore.completeRun({ runId, from: "running", to: "failed", result: null, reasonCode: "x", usage: null, now: NOW }, own);
    const mailbox = s.mailboxStore.enqueue(mailboxInputFor(threadId, runId, { operationId: "op-1" }));
    const out = s.transactions.closeThread({
      threadId,
      ownership: own,
      at: NOW,
      closeReason: "parent archived",
      suppressMailboxIds: [mailbox.mailboxId],
    });
    expect(out.suppressed).toBe(1);
    expect(out.thread.status).toBe("closed");
    expect(s.mailboxStore.get(mailbox.mailboxId, own)?.status).toBe("suppressed");
  });
});

// ═══════════════ 附加：类型出口冒烟 ═══════════════

describe("类型出口（index.ts）", () => {
  it("store 记录类型可直接使用", () => {
    const s = createStores(createDatabase());
    const own = ownership();
    const { thread, run, message } = createThreadWithRun(s);
    const t: SubagentThreadRecord = thread;
    const r: SubagentRunRecord = run;
    const m: SubagentMessageRecord = message;
    const mb: ParentMailboxRecord | null = s.mailboxStore.getByMessageId(message.messageId, own);
    expect([t.status, r.status, m.messageType, mb?.status]).toEqual(["open", "queued", "task", undefined]);
  });
});
