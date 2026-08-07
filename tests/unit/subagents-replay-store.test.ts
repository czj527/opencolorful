import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { SubagentRunStatus, SubagentThreadId } from "../../src/contracts/subagents.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SubagentReplayStore, type SubagentReplayEnvelope } from "../../src/runtime/subagents/transcript/replay-store.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：`subagent:<threadId>` Replay Store 测试（plans/phase-14.md §17.4）
//
// - SQLite 持久 sequence：重启（新 Store 实例同库）严格递增、不重复（§17.4）；
// - 断线重连：getSince(cursor) 只补发 cursor 之后的事件，不重不漏；
// - stale cursor：环形缓冲截断后 getSince 返回 reset:true；重启后缓冲为空、
//   cursor>0 同样 reset（客户端收 reset + snapshot 重建）；
// - 订阅广播：先写后广播，慢订阅者不影响发布。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createDatabase(): { directory: string; db: Database.Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-replay-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  return { directory, db };
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

const THREAD_ID = "sat_thread00001" as SubagentThreadId;
const OTHER_THREAD_ID = "sat_thread00002" as SubagentThreadId;

function messageEvent(sequence: number) {
  return {
    kind: "message" as const,
    message: {
      messageId: `sam_m${sequence}`,
      threadId: THREAD_ID,
      runId: `sar_r${sequence}`,
      sequence,
      envelope: {
        protocol: "opencolorful.agent-message",
        version: 1,
        messageId: `sam_m${sequence}`,
        contextId: THREAD_ID,
        taskId: `sar_r${sequence}`,
        sequence,
        sender: { kind: "subagent", id: `sar_r${sequence}` },
        recipient: { kind: "parent_agent", id: "agent-a" },
        messageType: "progress",
        deliveryMode: "immediate",
        parts: [{ kind: "text", text: `p${sequence}` }],
        metadata: { createdAt: `2026-08-07T10:00:0${sequence % 10}.000Z`, traceId: "trace-x", schemaName: "subagent.progress" },
      },
      messageType: "progress",
      senderKind: "subagent",
      recipientKind: "parent_agent",
      deliveryMode: "immediate",
      deliveryStatus: "queued",
      consumedAt: null,
      createdAt: `2026-08-07T10:00:0${sequence % 10}.000Z`,
    },
  } as const;
}

function runEvent(status: SubagentRunStatus, revision = 1) {
  return {
    kind: "run" as const,
    run: {
      runId: `sar_r1`,
      threadId: THREAD_ID,
      ordinal: 1,
      status,
      triggerMessageId: `sam_t1`,
      snapshotId: null,
      snapshotJson: null,
      limits: {} as never,
      result: null,
      reasonCode: null,
      auditPendingJson: null,
      currentPhase: null,
      currentTool: null,
      iterationCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastActivityAt: null,
      startedAt: null,
      finishedAt: null,
      leaseBootId: null,
      leaseHolderId: null,
      leaseExpiresAt: null,
      revision,
      createdAt: "2026-08-07T10:00:00.000Z",
      updatedAt: "2026-08-07T10:00:00.000Z",
    },
  } as const;
}

describe("SubagentReplayStore：持久 sequence 与重连", () => {
  it("publish 分配严格递增 sequence；getSince 从头重放不重不漏", () => {
    const { db } = createDatabase();
    const store = new SubagentReplayStore(db);
    const e1 = store.publish(THREAD_ID, messageEvent(1));
    const e2 = store.publish(THREAD_ID, messageEvent(2));
    const e3 = store.publish(THREAD_ID, runEvent("succeeded"));
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);

    const fromStart = store.getSince(THREAD_ID, 0);
    expect(fromStart.reset).toBe(false);
    expect(fromStart.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("重启（新实例同库）后 sequence 严格递增不回退（SQLite 持久，§17.4）", () => {
    const { directory, db } = createDatabase();
    const store1 = new SubagentReplayStore(db);
    store1.publish(THREAD_ID, messageEvent(1));
    expect(store1.latestSeq(THREAD_ID)).toBe(1);
    db.close();
    openDatabases.splice(openDatabases.indexOf(db), 1);

    const db2 = openMetadataDatabase(path.join(directory, "metadata.db"));
    openDatabases.push(db2);
    const store2 = new SubagentReplayStore(db2);
    expect(store2.latestSeq(THREAD_ID)).toBe(1);
    const e = store2.publish(THREAD_ID, messageEvent(2));
    expect(e.seq).toBe(2); // 不回退、不重复
    expect(store2.latestSeq(THREAD_ID)).toBe(2);
  });

  it("断线重连：cursor=2 只补发 3 之后的事件，不重复已收消息", () => {
    const { db } = createDatabase();
    const store = new SubagentReplayStore(db);
    store.publish(THREAD_ID, messageEvent(1));
    store.publish(THREAD_ID, messageEvent(2));
    store.publish(THREAD_ID, messageEvent(3));
    const reconnected = store.getSince(THREAD_ID, 2);
    expect(reconnected.reset).toBe(false);
    expect(reconnected.events.map((event) => event.seq)).toEqual([3]);
    // 无新事件时返回空且不 reset
    const idle = store.getSince(THREAD_ID, 3);
    expect(idle.events).toEqual([]);
    expect(idle.reset).toBe(false);
  });

  it("stale cursor：环形缓冲截断（超过容量丢最旧）→ reset:true", () => {
    const { db } = createDatabase();
    const store = new SubagentReplayStore(db, { maxEventsPerThread: 5 });
    for (let index = 1; index <= 10; index += 1) {
      store.publish(THREAD_ID, messageEvent(index));
    }
    // cursor=1 早于缓冲最旧（seq 6）且已截断 → reset
    const stale = store.getSince(THREAD_ID, 1);
    expect(stale.reset).toBe(true);
    expect(stale.events).toEqual([]);
    // cursor=6（窗口内）正常补发
    const ok = store.getSince(THREAD_ID, 6);
    expect(ok.reset).toBe(false);
    expect(ok.events.map((event) => event.seq)).toEqual([7, 8, 9, 10]);
  });

  it("重启后缓冲为空：cursor>0 → reset:true（客户端收 reset + snapshot 重建）", () => {
    const { directory, db } = createDatabase();
    const store1 = new SubagentReplayStore(db);
    store1.publish(THREAD_ID, messageEvent(1));
    db.close();
    openDatabases.splice(openDatabases.indexOf(db), 1);

    const db2 = openMetadataDatabase(path.join(directory, "metadata.db"));
    openDatabases.push(db2);
    const store2 = new SubagentReplayStore(db2);
    const afterRestart = store2.getSince(THREAD_ID, 1);
    expect(afterRestart.reset).toBe(true); // UI 以 snapshot 重建，不重复追加
    expect(store2.getSince(THREAD_ID, 0).reset).toBe(false); // 全新连接无需 reset
  });

  it("Thread 间隔离：事件只属于各自 Thread", () => {
    const { db } = createDatabase();
    const store = new SubagentReplayStore(db);
    store.publish(THREAD_ID, messageEvent(1));
    store.publish(OTHER_THREAD_ID, messageEvent(99));
    const result = store.getSince(THREAD_ID, 0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.threadId).toBe(THREAD_ID);
  });

  it("订阅广播：先写后广播；退订后不再收到", async () => {
    const { db } = createDatabase();
    const store = new SubagentReplayStore(db);
    const received: SubagentReplayEnvelope[] = [];
    const unsubscribe = store.subscribe((envelope) => received.push(envelope));
    store.publish(THREAD_ID, messageEvent(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.map((event) => event.seq)).toEqual([1]);
    unsubscribe();
    store.publish(THREAD_ID, messageEvent(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
  });

  it("reset 清空环形缓冲但保留 SQLite sequence", () => {
    const { db } = createDatabase();
    const store = new SubagentReplayStore(db);
    store.publish(THREAD_ID, messageEvent(1));
    store.reset(THREAD_ID);
    expect(store.getSince(THREAD_ID, 0).reset).toBe(false);
    const e = store.publish(THREAD_ID, messageEvent(2));
    expect(e.seq).toBe(2);
  });
});
