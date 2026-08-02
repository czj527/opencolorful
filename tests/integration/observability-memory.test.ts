import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { MemoryProposalStore } from "../../src/storage/memory/proposal-store.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import { defaultMemoryAgentSettings, type MemoryMutationProposal } from "../../src/contracts/memory.js";
import { MemoryPolicy } from "../../src/runtime/memory/memory-policy.js";
import { ProposalApplication } from "../../src/runtime/memory/proposal-application.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { MemoryAgentResolver } from "../../src/runtime/memory/resolver.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";
import type { ProducerContext } from "../../src/contracts/observability.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T5：记忆链路 Activity/Audit 证据
// 完成条件：记忆审批与强度修改拥有同 trace 的 Activity/Audit 证据；
// 记忆正文不入日志（只记 id/强度数字）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

const producer: ProducerContext = {
  component: "unit-test",
  processType: "server",
  processId: "1",
  bootId: "boot-test",
  appVersion: "0.0.0-test",
  hostPlatform: "win32",
};

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t5-memory-obs-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  instrument.init(new ObservabilityContext({
    database,
    producer,
    logsRoot: path.join(paths.logs, "runtime", "server"),
    spoolRoot: path.join(paths.logs, "emergency"),
  }));
  return { dir, paths, database };
}

function makeApplier(database: Database.Database) {
  const factStore = new MemoryFactStore(database);
  const eventStore = new MemoryEventStore(database);
  const journalStore = new MemoryJournalStore(database);
  const recallStore = new MemoryRecallStore(database);
  const batchStore = new MemoryBatchStore(database);
  const watermarkStore = new MemoryWatermarkStore(database);
  const proposalStore = new MemoryProposalStore(database);
  const policy = new MemoryPolicy({
    factStore,
    recallStore,
    journalStore,
    batchStore,
    eventStore,
    settingsResolver: () => defaultMemoryAgentSettings(),
  });
  database.prepare(`
    INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
    VALUES ('a1', 's1', ?, 'fact', '0', 'q', 'facts', 'memory_recall', '2026-07-30T10:00:00.000Z')
  `).run(crypto.randomUUID());
  const application = new ProposalApplication({
    database,
    proposalStore,
    factStore,
    eventStore,
    journalStore,
    batchStore,
    watermarkStore,
    policy,
    audit: new AuditRecorder({ database, producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" } }),
  });
  return { database, factStore, proposalStore, application };
}

function proposal(overrides: Partial<MemoryMutationProposal> = {}): MemoryMutationProposal {
  return {
    id: crypto.randomUUID(),
    agentId: "a1",
    runId: "run-1",
    type: "create_fact",
    targetType: "fact",
    payload: { fact: "审批落地事实" },
    evidenceRefs: ["session:s1"],
    reason: "测试审批",
    confidence: 0.9,
    status: "pending",
    createdAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function allActivity(database: Database.Database): Array<Record<string, unknown>> {
  return database.prepare("SELECT * FROM activity_events ORDER BY id").all() as Array<Record<string, unknown>>;
}

afterEach(() => {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T5 记忆审批与强度修改证据", () => {
  it("审批通过 + 强度修改：Activity 与 Audit 同 trace，正文不入日志", () => {
    const { database } = createContext();
    const { factStore, application } = makeApplier(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "待提强事实（正文绝不落日志）", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    const good = proposal({ type: "create_fact", payload: { fact: "新事实正文（绝不落日志）" } });
    const strength = proposal({
      type: "strength_change", targetId: String(fact.id),
      payload: { retentionStrength: 60 }, previousState: { retentionStrength: 50 },
    });

    // 模拟 resolver 后台域：新根 trace 贯穿 applyRun 全部事件
    instrument.runAsBackground({ operationId: "mem-agent-a1-1" }, () => {
      application.applyRun({ agentId: "a1", runId: "run-1", proposals: [good, strength] });
    });

    const rows = allActivity(database);
    const names = rows.map((row) => String(row["event_name"]));
    expect(names).toContain("memory.proposal.approved");
    expect(names).toContain("memory.strength.changed");
    // 同 trace（后台根 trace 贯穿）
    const approved = rows.find((row) => row["event_name"] === "memory.proposal.approved")!;
    const strengthRow = rows.find((row) => row["event_name"] === "memory.strength.changed")!;
    expect(approved["trace_id"]).toBe(strengthRow["trace_id"]);
    expect(String(approved["trace_id"])).not.toBe("no-trace");
    // 强度修改只记 id/数字
    const strengthPayload = JSON.parse(String(strengthRow["payload_json"])) as { summaryCode: string; attributes: { factId: string; from: number; to: number } };
    expect(strengthPayload.attributes).toMatchObject({ factId: String(fact.id), from: 50, to: 60 });
    // 严格审计（评审 P0 第三轮：与事实修改同事务 fail-closed）+ activity auditMirror 各一份
    const mirrors = database.prepare("SELECT action FROM audit_events ORDER BY id").all() as Array<{ action: string }>;
    expect(mirrors.map((row) => row.action).sort()).toEqual([
      "audit.memory.proposal_approved",
      "audit.memory.proposal_approved",
      "audit.memory.strength_changed",
      "memory.proposal.approved",
      "memory.proposal.approved",
      "memory.strength.changed",
    ]);
    // 记忆正文绝不在任何 activity/audit 行中
    const serialized = JSON.stringify([...rows, ...database.prepare("SELECT * FROM audit_events").all()]);
    expect(serialized).not.toContain("待提强事实");
    expect(serialized).not.toContain("新事实正文");
  });

  it("策略拒绝 → memory.proposal.rejected + audit 镜像；版本冲突归 conflicted（无镜像）", () => {
    const { database } = createContext();
    const { factStore, application } = makeApplier(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "冲突事实", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.9, retentionStrength: 50,
    });
    const conflicted = proposal({
      type: "strength_change", targetId: String(fact.id),
      payload: { retentionStrength: 60 }, previousState: { retentionStrength: 999 }, // 版本冲突
    });
    const plainRejected = proposal({
      type: "forget", targetType: "event", targetId: "ev_x", reason: "",
      payload: {},
    });
    application.applyRun({ agentId: "a1", runId: "run-1", proposals: [conflicted, plainRejected] });

    const rows = allActivity(database);
    const conflictedRow = rows.find((row) => row["event_name"] === "memory.proposal.conflicted");
    expect(conflictedRow).toBeDefined();
    const conflictedPayload = JSON.parse(String(conflictedRow!["payload_json"])) as { attributes: { reason: string } };
    expect(conflictedPayload.attributes.reason).toContain("版本冲突");
    const rejectedRow = rows.find((row) => row["event_name"] === "memory.proposal.rejected");
    expect(rejectedRow).toBeDefined();
    // 普通拒绝有 audit 镜像（conflicted 目录无镜像，属常规拒绝变体）
    const mirrors = database.prepare("SELECT action FROM audit_events").all() as Array<{ action: string }>;
    expect(mirrors.map((row) => row.action)).toEqual(["audit.memory.proposal_rejected"]);
    // 无正文
    expect(JSON.stringify(rows)).not.toContain("冲突事实");
  });

  it("forget → memory.fact.forgotten + audit 镜像（只记 id）", () => {
    const { database } = createContext();
    const { factStore, application } = makeApplier(database);
    const fact = factStore.createFact({
      agentId: "a1", fact: "待遗忘事实（绝不落日志）", tags: [], source: "agent_approved",
      sourceRefs: ["session:s1"], confidence: 0.8, retentionStrength: 40,
    });
    const forget = proposal({
      type: "forget", targetId: String(fact.id), reason: "已失效",
      payload: {},
    });
    application.applyRun({ agentId: "a1", runId: "run-1", proposals: [forget] });

    const rows = allActivity(database);
    const forgotten = rows.find((row) => row["event_name"] === "memory.fact.forgotten");
    expect(forgotten).toBeDefined();
    const payload = JSON.parse(String(forgotten!["payload_json"])) as { attributes: { factId: string } };
    expect(payload.attributes.factId).toBe(String(fact.id));
    const mirrors = database.prepare("SELECT action FROM audit_events").all() as Array<{ action: string }>;
    expect(mirrors.map((row) => row.action)).toContain("audit.memory.fact_forgotten");
    expect(JSON.stringify(rows)).not.toContain("待遗忘事实");
  });
});

describe("T5 MemoryAgentResolver 整理 run", () => {
  it("script 模式：memory.agent.started/completed 同 trace、同 runId operation", async () => {
    const { paths } = createContext();
    const database = openDatabases[openDatabases.length - 1]!;
    const agentsDir = path.join(paths.home, "agents");
    fs.mkdirSync(path.join(agentsDir, "a1", "sessions"), { recursive: true });
    const factStore = new MemoryFactStore(database);
    const resolver = new MemoryAgentResolver({
      batchStore: new MemoryBatchStore(database),
      journalStore: new MemoryJournalStore(database),
      factStore,
      eventStore: new MemoryEventStore(database),
      recallStore: new MemoryRecallStore(database),
      proposalStore: new MemoryProposalStore(database),
      watermarkStore: new MemoryWatermarkStore(database),
      summaryStore: new SessionSummaryStore(database),
      application: new ProposalApplication({
        database,
        proposalStore: new MemoryProposalStore(database),
        factStore,
        eventStore: new MemoryEventStore(database),
        journalStore: new MemoryJournalStore(database),
        batchStore: new MemoryBatchStore(database),
        watermarkStore: new MemoryWatermarkStore(database),
        audit: new AuditRecorder({ database, producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot-test", appVersion: "0.0.0-test", hostPlatform: "win32" } }),
        policy: new MemoryPolicy({
          factStore,
          recallStore: new MemoryRecallStore(database),
          journalStore: new MemoryJournalStore(database),
          batchStore: new MemoryBatchStore(database),
          eventStore: new MemoryEventStore(database),
          settingsResolver: () => defaultMemoryAgentSettings(),
        }),
      }),
      settingsResolver: () => defaultMemoryAgentSettings(),
      completeText: async () => { throw new Error("script 模式不应调用 LLM"); },
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      agentsDir,
      publish: () => {},
    });

    const outcome = await resolver.runMaintenance("a1");
    expect(outcome.status).toBe("completed");

    const rows = allActivity(database);
    const started = rows.find((row) => row["event_name"] === "memory.agent.started")!;
    const completed = rows.find((row) => row["event_name"] === "memory.agent.completed")!;
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    // 同 trace + 同 operationId（runId）
    expect(started["trace_id"]).toBe(completed["trace_id"]);
    expect(String(started["trace_id"])).not.toBe("no-trace");
    expect(started["operation_id"]).toBe(completed["operation_id"]);
    expect(String(started["operation_id"])).toMatch(/^run_/);
    expect(started["owner_agent_id"]).toBe("a1");
    const payload = JSON.parse(String(completed["payload_json"])) as { attributes: { applied: number; rejected: number } };
    expect(payload.attributes).toMatchObject({ applied: 0, rejected: 0 });
  });
});
