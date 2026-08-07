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
  WorkspaceLeaseStore,
  type SubagentOwnership,
} from "../../src/runtime/subagents/stores/index.js";
import {
  ParentMailboxDeliveryCoordinator,
} from "../../src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.js";
import { SubagentStartupRecovery } from "../../src/runtime/subagents/recovery/startup-recovery.js";
import type {
  ParentContinuationInput,
  ParentContinuationOutcome,
  ParentSessionPort,
  ParentSessionPortEvents,
  ParentSessionStatus,
} from "../../src/runtime/subagents/mailbox/parent-session-port.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：startup orphan recovery 测试（plans/phase-14.md §16.5 / §25.6）
//
// crash window 故障注入：直接以多种活动态（queued/starting/running/
// waiting_for_input/cancelling）构造"崩溃遗留"Run（含旧 bootId 的 Runtime
// Lease），运行恢复器验证：
// - 全部非终态 Run → interrupted + terminal message + mailbox（可唤醒父 Turn）；
// - interrupted 结果可查看、平台不自动 resume（状态保持 interrupted）；
// - closing Thread 无活动 Run → 终态化 closed；
// - 过期 workspace Lease 释放；
// - pending/delivering mailbox 在启动时恢复（delivering 视为可重试，§14.3）。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];
const trackedCoordinators: ParentMailboxDeliveryCoordinator[] = [];

function createDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-recovery-"));
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
})

const OWNERSHIP: SubagentOwnership = { ownerAgentId: "agent-a", parentSessionId: "sess-1" };

/** 注册的父 Session 端口（Faux；恢复后 continuation 触发可验证） */
class FauxParentSessionPort implements ParentSessionPort {
  readonly sessionId = "sess-1";
  readonly ownerAgentId = "agent-a";
  status: ParentSessionStatus = "idle";
  readonly startCalls: Array<{ text: string; operationId: string }> = [];
  private resolveStart: ((outcome: ParentContinuationOutcome) => void) | null = null;
  private events: ParentSessionPortEvents | null = null;

  getStatus(): ParentSessionStatus {
    return this.status;
  }

  startContinuation(input: ParentContinuationInput): Promise<ParentContinuationOutcome> {
    this.startCalls.push(input);
    return new Promise((resolve) => {
      this.resolveStart = resolve;
    });
  }

  finishNext(outcome: ParentContinuationOutcome): void {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    resolve?.(outcome);
  }

  noteUserMessage(): void {
    this.events?.onUserInterrupt();
  }

  noteUserTurnEnd(): void {
    this.events?.onTurnEnd();
  }

  noteUserAbort(): void {
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
  readonly threadStore: ThreadStore;
  readonly transactions: SubagentTransactions;
  readonly leases: WorkspaceLeaseStore;
  readonly coordinator: ParentMailboxDeliveryCoordinator;
  readonly recovery: SubagentStartupRecovery;
  readonly ports: FauxParentSessionPort[];
  /** 创建一个 Thread + 首 Run（queued；崩溃遗留），返回 runId */
  createCrashThread(threadId: SubagentThreadId, runId: SubagentRunId, status: "queued" | "starting" | "running" | "waiting_for_input" | "cancelling"): void;
}

/** 恢复器可控时钟（测试固定为 12:00Z：09:00 过期、11:00 仍有效等断言） */
const RECOVERY_NOW_MS = Date.parse("2026-08-07T12:00:00.000Z");

function createHarness(options: { registerPort?: boolean } = {}): Harness {
  const db = createDatabase();
  const threadStore = new ThreadStore(db);
  const runs = new RunStore(db, threadStore);
  const messages = new MessageStore(db, threadStore);
  const mailboxStore = new ParentMailboxStore(db);
  const transactions = new SubagentTransactions(db, { threadStore, runStore: runs, messageStore: messages, mailboxStore });
  const leases = new WorkspaceLeaseStore(db);
  const coordinator = new ParentMailboxDeliveryCoordinator({
    mailboxStore,
    messageStore: messages,
    runStore: runs,
    threadStore,
    transactions,
    cancelRun: () => true,
    retryBaseDelayMs: 15,
    retryMaxDelayMs: 60,
  });
  trackedCoordinators.push(coordinator);
  const ports: FauxParentSessionPort[] = [];
  if (options.registerPort === true) {
    const port = new FauxParentSessionPort();
    ports.push(port);
    coordinator.registerParentSession(port);
  }
  const recovery = new SubagentStartupRecovery({
    runs,
    threads: threadStore,
    messages,
    transactions,
    workspaceLeases: leases,
    coordinator,
    now: () => RECOVERY_NOW_MS,
  });
  return {
    db,
    runs,
    messages,
    mailboxStore,
    threadStore,
    transactions,
    leases,
    coordinator,
    recovery,
    ports,
    createCrashThread(threadId, runId, status) {
      transactions.createThreadWithFirstRun({
        thread: {
          threadId,
          title: "crash thread",
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
          createdFromTurnId: null,
        },
        ownership: OWNERSHIP,
        firstRun: { runId, triggerMessageId: `sam_trig_${runId}` as AgentMessageId },
        limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
        taskEnvelope: {
          protocol: SUBAGENT_MESSAGE_PROTOCOL,
          version: 1,
          messageId: `sam_trig_${runId}` as AgentMessageId,
          contextId: threadId,
          taskId: runId,
          sender: { kind: "parent_agent", id: "agent-a" },
          recipient: { kind: "subagent", id: runId },
          messageType: "task",
          deliveryMode: "immediate",
          parts: [{ kind: "text", text: "研究并汇报" }],
          metadata: { createdAt: NOW, traceId: "trace-rec", schemaName: "subagent.task" },
        },
        now: NOW,
      });
      if (status === "queued") {
        return;
      }
      // starting：旧 bootId 的 Runtime Lease（§15.4：Lease 绑定 runId+bootId+holderId）
      runs.startWithSnapshot(
        {
          runId,
          snapshotId: `sas_snap_${runId}` as `sas_${string}`,
          snapshotJson: JSON.stringify({ ceilingHash: "hash12345678" }),
          limits: SUBAGENT_RUN_LIMITS_DEFAULTS,
          leaseBootId: "boot-crashed",
          leaseHolderId: "subagent-host",
          leaseExpiresAt: "2026-08-07T09:59:00.000Z", // 已过期
          now: NOW,
        },
        OWNERSHIP,
      );
      if (status === "starting") {
        return;
      }
      runs.transit({ runId, from: "starting", to: "running", reasonCode: null, now: NOW }, OWNERSHIP);
      if (status === "running") {
        return;
      }
      runs.transit({ runId, from: "running", to: "waiting_for_input", reasonCode: null, now: NOW }, OWNERSHIP);
      if (status === "waiting_for_input") {
        return;
      }
      runs.transit({ runId, from: "waiting_for_input", to: "cancelling", reasonCode: null, now: NOW }, OWNERSHIP);
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

describe("startup recovery：crash window 故障注入（§16.5 / §25.6）", () => {
  it("queued/starting/running/waiting/cancelling 全部 interrupted，且平台不自动 resume", () => {
    const h = createHarness();
    h.createCrashThread("sat_thread_crash01" as SubagentThreadId, "sar_run_crash0001" as SubagentRunId, "queued");
    h.createCrashThread("sat_thread_crash02" as SubagentThreadId, "sar_run_crash0002" as SubagentRunId, "starting");
    h.createCrashThread("sat_thread_crash03" as SubagentThreadId, "sar_run_crash0003" as SubagentRunId, "running");
    h.createCrashThread("sat_thread_crash04" as SubagentThreadId, "sar_run_crash0004" as SubagentRunId, "waiting_for_input");
    h.createCrashThread("sat_thread_crash05" as SubagentThreadId, "sar_run_crash0005" as SubagentRunId, "cancelling");
    const report = h.recovery.run();
    expect(report.interruptedRuns).toBe(5);
    expect(report.errors).toHaveLength(0);
    for (const runId of ["sar_run_crash0001", "sar_run_crash0002", "sar_run_crash0003", "sar_run_crash0004", "sar_run_crash0005"]) {
      const run = h.runs.get(runId as SubagentRunId, OWNERSHIP);
      expect(run?.status).toBe("interrupted"); // 结果可查看，不自动 resume
      expect(run?.reasonCode).toBe("subagent_recovery_interrupted");
      expect(run?.leaseBootId).toBeNull(); // 终态清 Lease
      // terminal message + mailbox（interrupted 可唤醒父 Turn，§8.4）
      expect(h.messages.listByRun(runId as SubagentRunId, OWNERSHIP).some((m) => m.messageType === "status")).toBe(true);
      const mailboxRows = h.mailboxStore.listByRun(runId as SubagentRunId, OWNERSHIP);
      expect(mailboxRows.some((row) => row.notificationKind === "interrupted" && row.triggerParentTurn === true)).toBe(true);
    }
  });

  it("已终态 Run 不受恢复影响（不重复写终态）", () => {
    const h = createHarness();
    h.createCrashThread("sat_thread_ok000001" as SubagentThreadId, "sar_run_ok00000001" as SubagentRunId, "running");
    h.runs.transit({ runId: "sar_run_ok00000001" as SubagentRunId, from: "running", to: "succeeded", reasonCode: null, now: NOW }, OWNERSHIP);
    const report = h.recovery.run();
    expect(report.interruptedRuns).toBe(0);
    expect(h.runs.get("sar_run_ok00000001" as SubagentRunId, OWNERSHIP)?.status).toBe("succeeded");
  });

  it("closing Thread 且无活动 Run → 终态化 closed（崩溃遗留不卡死）", () => {
    const h = createHarness();
    h.createCrashThread("sat_thread_cls0001" as SubagentThreadId, "sar_run_cls000001" as SubagentRunId, "running");
    // 模拟崩溃发生在 closeThread 的 beginClosing 之后、markClosed 之前
    h.threadStore.beginClosing("sat_thread_cls0001" as SubagentThreadId, OWNERSHIP, NOW);
    h.runs.transit({ runId: "sar_run_cls000001" as SubagentRunId, from: "running", to: "succeeded", reasonCode: null, now: NOW }, OWNERSHIP);
    const report = h.recovery.run();
    expect(report.finalizedClosingThreads).toBe(1);
    expect(h.threadStore.get("sat_thread_cls0001" as SubagentThreadId, OWNERSHIP)?.status).toBe("closed");
  });

  it("过期 workspace Lease 释放；未过期保留", () => {
    const h = createHarness();
    h.leases.acquire({
      canonicalWorkspace: "ws-expired",
      leaseKind: "subagent_write",
      ownerKind: "subagent",
      ownerId: "sar_run_x",
      bootId: "boot-crashed",
      expiresAt: "2026-08-07T09:00:00.000Z", // < 恢复时钟 12:00Z：过期
      now: NOW,
    });
    h.leases.acquire({
      canonicalWorkspace: "ws-valid",
      leaseKind: "parent_write",
      ownerKind: "parent_agent",
      ownerId: "agent-a",
      bootId: "boot-current",
      expiresAt: "2026-08-07T13:00:00.000Z", // > 恢复时钟 12:00Z：保留
      now: NOW,
    });
    const report = h.recovery.run();
    expect(report.releasedWorkspaceLeases).toBe(1);
    expect(h.leases.get("ws-expired")).toBeNull();
    expect(h.leases.get("ws-valid")).not.toBeNull();
  });
});

describe("startup recovery：mailbox 恢复（§14.3 / §16.5）", () => {
  it("pending terminal mailbox（含 delivering 遗留）在启动时恢复投递", async () => {
    const h = createHarness({ registerPort: true });
    h.createCrashThread("sat_thread_mb00001" as SubagentThreadId, "sar_run_mb0000001" as SubagentRunId, "running");
    const report = h.recovery.run();
    expect(report.interruptedRuns).toBe(1);
    // 恢复器最后 retryPending → 父 idle → continuation 触发（聚合 interrupted 通知）
    await waitUntil(() => h.ports[0]?.startCalls.length === 1);
    expect(h.ports[0]?.startCalls[0]?.text).toContain("被打断");
    h.ports[0]?.finishNext({ status: "triggered" });
    await waitUntil(() => h.mailboxStore.listByThread("sat_thread_mb00001" as SubagentThreadId, OWNERSHIP).every((row) => row.status === "delivered"));
  });
});

describe("startup recovery：不可用语义（§16.5）", () => {
  it("errors 逐项聚合，不中断整体恢复（部分失败不影响其余结算）", () => {
    const h = createHarness();
    h.createCrashThread("sat_thread_a000001" as SubagentThreadId, "sar_run_a00000001" as SubagentRunId, "running");
    // 人为破坏：给 Run 写一个非法状态行（corrupted JSON），恢复该 Run 失败但整体继续
    h.db.prepare("UPDATE subagent_runs SET limits_json = '{not-json' WHERE run_id = ?").run("sar_run_a00000001");
    const report = h.recovery.run();
    expect(report.interruptedRuns).toBe(0);
    expect(report.errors.length).toBeGreaterThan(0);
    // 其余步骤仍执行
    expect(report.mailboxRetried).toBe(true);
  });
});
