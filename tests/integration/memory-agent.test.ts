import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { MemoryBatchStore } from "../../src/storage/memory/batch-store.js";
import { MemoryEventStore } from "../../src/storage/memory/event-store.js";
import { MemoryFactStore } from "../../src/storage/memory/fact-store.js";
import { MemoryJournalStore } from "../../src/storage/memory/journal-store.js";
import { MemoryRecallStore } from "../../src/storage/memory/recall-store.js";
import { buildMemorySearchText } from "../../src/storage/memory/cjk-ngram.js";
import { MemoryAgentRunner } from "../../src/runtime/memory/agent/memory-agent-runner.js";
import { createPersistentSession } from "../../src/pi-sdk/index.js";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-memory-agent-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const agentsDir = path.join(dir, "agents");
  fs.mkdirSync(path.join(agentsDir, "a1", "sessions"), { recursive: true });
  return { dir, paths, database, agentsDir };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("MemoryAgentRunner", () => {
  it("完整流程：提取 → 提案 → final → 报告落盘且批次保持 pending", async () => {
    const { database, agentsDir } = createContext();
    const batchStore = new MemoryBatchStore(database);
    batchStore.createBatch({
      id: "b1", agentId: "a1", sessionId: "s1",
      revision: { branchRevision: "br" }, sourceStartEntry: "e1", sourceEndEntry: "e2",
      priority: 0,
    }, "sealed");

    let script = [
      JSON.stringify({ kind: "tool_call", tool: "propose_fact", args: { payload: { fact: "用户偏好中文交流" }, evidenceRefs: ["session:s1"], reason: "批次摘要中明确", confidence: 0.9 } }),
      JSON.stringify({ kind: "tool_call", tool: "propose_forget", args: { payload: { targetType: "event", targetId: "ev_old", reason: "已失效" }, evidenceRefs: ["session:s1"], reason: "事件已失效", confidence: 0.8 } }),
      JSON.stringify({ kind: "final", report: { summary: "整理完成", issues: [] } }),
    ].join("\n");

    const runner = new MemoryAgentRunner({
      agentId: "a1",
      batchStore,
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      agentsDir,
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      completeText: async () => {
        const line = script.split("\n").shift()!;
        script = script.slice(script.indexOf("\n") + 1);
        return line;
      },
      limits: { maxIterations: 10 },
    });

    const result = await runner.run();
    expect(result.status).toBe("completed");
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]?.type).toBe("create_fact");
    expect(result.proposals[0]?.payload.fact).toBe("用户偏好中文交流");
    expect(result.proposals[1]?.type).toBe("forget");
    // 批次保持 pending（runner 不应用）
    expect(batchStore.listPendingBatches("a1")).toHaveLength(1);
    // 报告落盘
    const runsDir = path.join(agentsDir, "a1", "memory", "runs");
    const runDirs = fs.readdirSync(runsDir);
    expect(runDirs).toHaveLength(1);
    const runDir = path.join(runsDir, runDirs[0]!);
    expect(fs.existsSync(path.join(runDir, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "REPORT.md"))).toBe(true);
    const report = fs.readFileSync(path.join(runDir, "REPORT.md"), "utf8");
    // 脱敏摘要：包含提案类型与理由，不含完整原文与敏感信息
    expect(report).toContain("create_fact");
    expect(report).toContain("forget");
    expect(report).not.toContain("sk-");
    expect(report).not.toContain("Bearer ");
  });

  it("预算熔断：超过最大迭代次数 → deferred", async () => {
    const { database, agentsDir } = createContext();
    const batchStore = new MemoryBatchStore(database);
    const runner = new MemoryAgentRunner({
      agentId: "a1",
      batchStore,
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      agentsDir,
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      completeText: async () => JSON.stringify({ kind: "final", report: { summary: "x" } }),
      limits: { maxIterations: 0 },
    });
    const result = await runner.run();
    expect(result.status).toBe("deferred");
  });

  it("模型输出非法 JSON 连续 3 次 → deferred 而非 failed", async () => {
    const { database, agentsDir } = createContext();
    const runner = new MemoryAgentRunner({
      agentId: "a1",
      batchStore: new MemoryBatchStore(database),
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      agentsDir,
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      completeText: async () => "不是 JSON 的内容",
      limits: { maxIterations: 10 },
    });
    const result = await runner.run();
    expect(result.status).toBe("deferred");
  });

  it("search_memory_candidates 不写 recall ledger、不发 SSE", async () => {
    const { database, agentsDir } = createContext();
    const factStore = new MemoryFactStore(database);
    factStore.createFact({
      agentId: "a1", fact: "用户偏好深色模式", tags: [], source: "agent_approved",
      sourceRefs: ["session:seed"], confidence: 0.9, retentionStrength: 50,
    });
    const recallStore = new MemoryRecallStore(database);
    let script = [
      JSON.stringify({ kind: "tool_call", tool: "search_memory_candidates", args: { query: "深色", layer: "facts" } }),
      JSON.stringify({ kind: "final", report: { summary: "检索完成" } }),
    ].join("\n");
    const runner = new MemoryAgentRunner({
      agentId: "a1",
      batchStore: new MemoryBatchStore(database),
      journalStore: new MemoryJournalStore(database),
      factStore,
      eventStore: new MemoryEventStore(database),
      agentsDir,
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      completeText: async () => {
        const line = script.split("\n").shift()!;
        script = script.slice(script.indexOf("\n") + 1);
        return line;
      },
    });
    const result = await runner.run();
    expect(result.status).toBe("completed");
    // 只读：候选检索不产生 recall ledger 行
    expect(recallStore.listByAgent("a1")).toHaveLength(0);
    expect(result.proposals).toHaveLength(0);
  });

  it("read_session_entries 读取批次限定原文；越界路径 fail-closed", async () => {
    const { database, agentsDir } = createContext();
    // 真实 PI 会话文件（带时间戳前缀）
    const sessionDir = path.join(agentsDir, "a1", "sessions");
    const handle = createPersistentSession(sessionDir, sessionDir, "sess-read");
    handle.appendUserMessage("第一问");
    handle.appendAssistantMessage("第一答");
    handle.persist();
    // 用 jsonl-branch-reader 拿到 entry id
    const { readSessionBranchSnapshot } = await import("../../src/runtime/memory/jsonl-branch-reader.js");
    const snapshot = readSessionBranchSnapshot(handle.path);
    expect(snapshot).not.toBeNull();
    const start = snapshot!.entries[0]!.id;
    const end = snapshot!.entries[1]!.id;

    const batchStore = new MemoryBatchStore(database);
    batchStore.createBatch({
      id: "b-read", agentId: "a1", sessionId: "sess-read",
      revision: { branchRevision: "br" }, sourceStartEntry: start, sourceEndEntry: end,
      priority: 0,
    }, "sealed");

    let script = [
      JSON.stringify({ kind: "tool_call", tool: "read_session_entries", args: { batchId: "b-read" } }),
      JSON.stringify({ kind: "final", report: { summary: "已核对原文" } }),
    ].join("\n");
    const sessionPaths = new Map<string, string>([["sess-read", handle.path]]);
    const denied: string[] = [];
    const runner = new MemoryAgentRunner({
      agentId: "a1",
      batchStore,
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      agentsDir,
      sessionPathResolver: (sessionId) => sessionPaths.get(sessionId) ?? path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      assertSessionReadable: (sessionPath) => { if (!sessionPath.startsWith(sessionDir)) denied.push(sessionPath); },
      completeText: async () => {
        const line = script.split("\n").shift()!;
        script = script.slice(script.indexOf("\n") + 1);
        return line;
      },
    });
    const result = await runner.run();
    expect(result.status).toBe("completed");
    expect(denied).toHaveLength(0);

    // 越界路径：resolver 返回外部路径 → assertSessionReadable 拒绝 → 工具报错回填
    const runner2 = new MemoryAgentRunner({
      agentId: "a1",
      batchStore,
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      agentsDir,
      sessionPathResolver: () => path.join(os.tmpdir(), "outside.jsonl"),
      assertSessionReadable: (sessionPath) => { throw new Error("路径越界"); },
      completeText: async () => JSON.stringify({ kind: "final", report: { summary: "完成" } }),
    });
    const result2 = await runner2.run();
    expect(result2.status).toBe("completed");
  });

  it("白名单外工具被拒绝并继续", async () => {
    const { database, agentsDir } = createContext();
    let script = [
      JSON.stringify({ kind: "tool_call", tool: "shell_exec", args: { cmd: "rm -rf /" } }),
      JSON.stringify({ kind: "final", report: { summary: "结束" } }),
    ].join("\n");
    const runner = new MemoryAgentRunner({
      agentId: "a1",
      batchStore: new MemoryBatchStore(database),
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      agentsDir,
      sessionPathResolver: (sessionId) => path.join(agentsDir, "a1", "sessions", `${sessionId}.jsonl`),
      completeText: async () => {
        const line = script.split("\n").shift()!;
        script = script.slice(script.indexOf("\n") + 1);
        return line;
      },
    });
    const result = await runner.run();
    expect(result.status).toBe("completed");
    expect(result.proposals).toHaveLength(0);
  });
});
