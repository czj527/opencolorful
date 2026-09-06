import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import type { UsageCallStatus, UsageRole, UsageSource } from "../../src/contracts/usage.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { UsageStore } from "../../src/storage/usage-store.js";
import { createServerApp } from "../../src/server/app.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-usage-api-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const usageStore = new UsageStore(database);
  const { app } = createTrustedServerApp({ usageStore });
  return { paths, database, usageStore, app };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function insertRecord(
  store: UsageStore,
  overrides: Partial<{
    sessionId: string | null;
    turnId: string | null;
    provider: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    contextTokens: number | null;
    contextWindow: number | null;
    createdAt: string;
    source: UsageSource;
    role: UsageRole;
    status: UsageCallStatus;
    agentId: string | null;
    runId: string | null;
    callId: string | null;
  }> = {},
) {
  const source = overrides.source ?? "main";
  store.record({
    sessionId: overrides.sessionId === undefined ? "session-1" : overrides.sessionId,
    turnId: overrides.turnId === undefined ? `turn-${crypto.randomUUID()}` : overrides.turnId,
    provider: overrides.provider ?? "faux",
    model: overrides.model ?? "faux-1",
    input: overrides.input ?? 100,
    output: overrides.output ?? 50,
    cacheRead: overrides.cacheRead ?? 20,
    cacheWrite: overrides.cacheWrite ?? 10,
    totalTokens: overrides.totalTokens ?? 180,
    contextTokens: overrides.contextTokens ?? null,
    contextWindow: overrides.contextWindow ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    source,
    // 与 UsageStore.record 的缺省推导保持一致：main → primary，其余 → secondary
    role: overrides.role ?? (source === "main" ? "primary" : "secondary"),
    status: overrides.status ?? "completed",
    agentId: overrides.agentId ?? null,
    runId: overrides.runId ?? null,
    callId: overrides.callId ?? null,
  });
}

describe("usage API", () => {
  describe("GET /api/sessions/:id/usage", () => {
    it("returns zeroed structure for a session with no records", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/sessions/session-empty/usage");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.sessionId).toBe("session-empty");
      expect(body.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
      expect(body.cacheHitRate).toBeNull();
      expect(body.turns).toBe(0);
      expect(body.context).toBeNull();
      database.close();
    });

    it("returns aggregated totals and cacheHitRate", async () => {
      const { app, usageStore, database } = createContext();
      insertRecord(usageStore, { sessionId: "s1", turnId: "t1", input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180 });
      insertRecord(usageStore, { sessionId: "s1", turnId: "t2", input: 200, output: 80, cacheRead: 40, cacheWrite: 20, totalTokens: 340 });

      const response = await app.request("http://127.0.0.1/api/sessions/s1/usage");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.totals).toEqual({ input: 300, output: 130, cacheRead: 60, cacheWrite: 30, totalTokens: 520 });
      expect(body.turns).toBe(2);
      // cacheHitRate = 60 / (300 + 60) = 0.1666...
      expect(body.cacheHitRate).toBeCloseTo(60 / 360, 5);
      database.close();
    });

    it("returns null cacheHitRate when denominator is zero", async () => {
      const { app, usageStore, database } = createContext();
      insertRecord(usageStore, { sessionId: "s1", turnId: "t1", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

      const response = await app.request("http://127.0.0.1/api/sessions/s1/usage");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.cacheHitRate).toBeNull();
      database.close();
    });

    it("returns context from the latest record with context_window", async () => {
      const { app, usageStore, database } = createContext();
      insertRecord(usageStore, {
        sessionId: "s1",
        turnId: "t1",
        contextTokens: 5000,
        contextWindow: 128000,
        createdAt: "2026-07-25T10:00:00.000Z",
      });
      insertRecord(usageStore, {
        sessionId: "s1",
        turnId: "t2",
        contextTokens: 8000,
        contextWindow: 128000,
        createdAt: "2026-07-25T12:00:00.000Z",
      });

      const response = await app.request("http://127.0.0.1/api/sessions/s1/usage");
      const body = (await response.json()) as Record<string, unknown>;
      const context = body.context as { tokens: number; contextWindow: number; percent: number };
      expect(context.tokens).toBe(8000);
      expect(context.contextWindow).toBe(128000);
      expect(context.percent).toBeCloseTo((8000 / 128000) * 100, 5);
      database.close();
    });

    it("returns null context when no records have context_window", async () => {
      const { app, usageStore, database } = createContext();
      insertRecord(usageStore, { sessionId: "s1", turnId: "t1" });

      const response = await app.request("http://127.0.0.1/api/sessions/s1/usage");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.context).toBeNull();
      database.close();
    });

    it("counts calls across sources while turns stays main-only", async () => {
      const { app, usageStore, database } = createContext();
      const now = new Date().toISOString();
      // main 轮次 ×2
      insertRecord(usageStore, { sessionId: "s1", turnId: "t1", createdAt: now });
      insertRecord(usageStore, { sessionId: "s1", turnId: "t2", createdAt: now });
      // 派生子代理调用（source=subagent，缺省 role=secondary）
      insertRecord(usageStore, { sessionId: "s1", turnId: null, source: "subagent", runId: "run-1", agentId: "agent-x", createdAt: now });

      const response = await app.request("http://127.0.0.1/api/sessions/s1/usage");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.turns).toBe(2);
      expect(body.calls).toBe(3);
      expect(body.totals).toEqual({ input: 300, output: 150, cacheRead: 60, cacheWrite: 30, totalTokens: 540 });
      database.close();
    });
  });

  describe("GET /api/usage/summary", () => {
    it("returns empty structure when no records exist", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.days).toBe(30);
      expect(body.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
      expect(body.cacheHitRate).toBeNull();
      expect(body.sessions).toBe(0);
      expect(body.turns).toBe(0);
      expect(body.byDay).toEqual([]);
      expect(body.byModel).toEqual([]);
      // A8 新增字段：零记录时 calls 为 0，分组聚合为数组
      expect(body.calls).toBe(0);
      expect(body.bySource).toEqual([]);
      expect(body.byRole).toEqual([]);
      expect(body.byStatus).toEqual([]);
      database.close();
    });

    it("returns aggregated summary with default days=30", async () => {
      const { app, usageStore, database } = createContext();
      const today = new Date().toISOString();
      insertRecord(usageStore, { sessionId: "s1", turnId: "t1", createdAt: today });
      insertRecord(usageStore, { sessionId: "s2", turnId: "t2", createdAt: today });

      const response = await app.request("http://127.0.0.1/api/usage/summary");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.days).toBe(30);
      expect(body.sessions).toBe(2);
      expect(body.turns).toBe(2);
      expect((body.byDay as unknown[]).length).toBeGreaterThan(0);
      expect((body.byModel as unknown[]).length).toBeGreaterThan(0);
      database.close();
    });

    it("accepts valid days parameter", async () => {
      const { app, usageStore, database } = createContext();
      insertRecord(usageStore, { createdAt: new Date().toISOString() });

      const response = await app.request("http://127.0.0.1/api/usage/summary?days=7");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.days).toBe(7);
      database.close();
    });

    it("returns 400 for days=0", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary?days=0");
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("INVALID_INPUT");
      expect(body.message).toBe("days 必须是 1-365 的整数");
      database.close();
    });

    it("returns 400 for days=366", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary?days=366");
      expect(response.status).toBe(400);
      database.close();
    });

    it("returns 400 for non-integer days", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary?days=abc");
      expect(response.status).toBe(400);
      database.close();
    });

    it("returns 400 for float days", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary?days=7.5");
      expect(response.status).toBe(400);
      database.close();
    });

    it("aggregates byDay correctly", async () => {
      const { app, usageStore, database } = createContext();
      const today = new Date().toISOString().slice(0, 10);
      insertRecord(usageStore, { turnId: "t1", createdAt: `${today}T08:00:00.000Z` });
      insertRecord(usageStore, { turnId: "t2", createdAt: `${today}T12:00:00.000Z` });

      const response = await app.request("http://127.0.0.1/api/usage/summary?days=1");
      const body = (await response.json()) as Record<string, unknown>;
      const byDay = body.byDay as Array<{ date: string; input: number; totalTokens: number }>;
      expect(byDay.length).toBe(1);
      expect(byDay[0]?.date).toBe(today);
      expect(byDay[0]?.input).toBe(200);
      expect(byDay[0]?.totalTokens).toBe(360);
      database.close();
    });

    it("aggregates byModel correctly", async () => {
      const { app, usageStore, database } = createContext();
      const now = new Date().toISOString();
      insertRecord(usageStore, { turnId: "t1", provider: "faux", model: "faux-1", createdAt: now });
      insertRecord(usageStore, { turnId: "t2", provider: "faux", model: "faux-1", createdAt: now });
      insertRecord(usageStore, { turnId: "t3", provider: "other", model: "other-1", createdAt: now });

      const response = await app.request("http://127.0.0.1/api/usage/summary?days=1");
      const body = (await response.json()) as Record<string, unknown>;
      const byModel = body.byModel as Array<{ provider: string; model: string; totalTokens: number }>;
      expect(byModel.length).toBe(2);
      const faux = byModel.find((r) => r.provider === "faux");
      const other = byModel.find((r) => r.provider === "other");
      expect(faux?.totalTokens).toBe(360);
      expect(other?.totalTokens).toBe(180);
      database.close();
    });

    it("excludes records older than the days window", async () => {
      const { app, usageStore, database } = createContext();
      const old = new Date();
      old.setDate(old.getDate() - 10);
      insertRecord(usageStore, { turnId: "t-old", createdAt: old.toISOString() });
      insertRecord(usageStore, { turnId: "t-new", createdAt: new Date().toISOString() });

      const response = await app.request("http://127.0.0.1/api/usage/summary?days=5");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.turns).toBe(1);
      database.close();
    });
  });

  describe("GET /api/usage/summary filtering (A8)", () => {
    /** 插入覆盖 main/subagent/utility 三来源的混合行，返回各来源期望记录数。 */
    function insertMixedRecords(usageStore: UsageStore, sessionId: string): void {
      const now = new Date().toISOString();
      // main：session 内两轮
      insertRecord(usageStore, {
        source: "main",
        sessionId,
        turnId: "turn-main-1",
        provider: "faux",
        model: "faux-1",
        totalTokens: 100,
        createdAt: now,
      });
      insertRecord(usageStore, {
        source: "main",
        sessionId,
        turnId: "turn-main-2",
        provider: "faux",
        model: "faux-1",
        totalTokens: 110,
        createdAt: now,
      });
      // subagent：同一父会话、不同 agent
      insertRecord(usageStore, {
        source: "subagent",
        sessionId,
        turnId: null,
        agentId: "agent-explorer",
        runId: "run-1",
        provider: "other",
        model: "other-1",
        totalTokens: 200,
        createdAt: now,
      });
      insertRecord(usageStore, {
        source: "subagent",
        sessionId,
        turnId: null,
        agentId: "agent-planner",
        runId: "run-2",
        provider: "faux",
        model: "faux-2",
        totalTokens: 300,
        createdAt: now,
      });
      // utility：无会话归属的全局调用
      insertRecord(usageStore, {
        source: "utility",
        sessionId: null,
        turnId: null,
        agentId: null,
        callId: "call-1",
        provider: "faux",
        model: "faux-1",
        totalTokens: 400,
        createdAt: now,
      });
    }

    it("filters by source=utility", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?source=utility");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.turns).toBe(0);
      expect(body.calls).toBe(1);
      expect(body.sessions).toBe(0);
      expect(body.totals).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 400 });
      database.close();
    });

    it("filters by source=main and keeps turns semantics", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?source=main");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.turns).toBe(2);
      expect(body.calls).toBe(2);
      expect(body.sessions).toBe(1);
      expect(body.totals).toEqual({ input: 200, output: 100, cacheRead: 40, cacheWrite: 20, totalTokens: 210 });
      database.close();
    });

    it("filters by source=subagent", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?source=subagent");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.turns).toBe(0);
      expect(body.calls).toBe(2);
      expect(body.sessions).toBe(1);
      expect(body.totals).toEqual({ input: 200, output: 100, cacheRead: 40, cacheWrite: 20, totalTokens: 500 });
      database.close();
    });

    it("filters by role=secondary", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?role=secondary");
      const body = (await response.json()) as Record<string, unknown>;
      // main 缺省 role=primary，其余缺省 secondary
      expect(body.calls).toBe(3);
      expect(body.turns).toBe(0);
      expect(body.totals).toEqual({ input: 300, output: 150, cacheRead: 60, cacheWrite: 30, totalTokens: 900 });
      database.close();
    });

    it("filters by role=primary", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?role=primary");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.calls).toBe(2);
      expect(body.turns).toBe(2);
      expect(body.totals).toEqual({ input: 200, output: 100, cacheRead: 40, cacheWrite: 20, totalTokens: 210 });
      database.close();
    });

    it("filters by agentId", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?agentId=agent-explorer");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.calls).toBe(1);
      expect(body.totals).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 200 });
      database.close();
    });

    it("filters by sessionId", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");
      // 另一会话的行不应计入
      insertRecord(usageStore, { sessionId: "s-other", turnId: "turn-other", totalTokens: 999 });

      const response = await app.request("http://127.0.0.1/api/usage/summary?sessionId=s-mix");
      const body = (await response.json()) as Record<string, unknown>;
      // s-mix：main×2 + subagent×2（utility 无会话归属）
      expect(body.calls).toBe(4);
      expect(body.totals).toEqual({ input: 400, output: 200, cacheRead: 80, cacheWrite: 40, totalTokens: 710 });
      database.close();
    });

    it("filters by providerId", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?providerId=other");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.calls).toBe(1);
      expect(body.totals).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 200 });
      const byModel = body.byModel as Array<{ provider: string; model: string }>;
      expect(byModel).toEqual([{ provider: "other", model: "other-1", input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 200 }]);
      database.close();
    });

    it("filters by modelId", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?modelId=faux-2");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.calls).toBe(1);
      expect(body.totals).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 300 });
      database.close();
    });

    it("trims whitespace on text filters and treats empty string as not provided", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const trimmed = await app.request("http://127.0.0.1/api/usage/summary?agentId=%20agent-planner%20");
      expect(trimmed.status).toBe(200);
      const trimmedBody = (await trimmed.json()) as Record<string, unknown>;
      expect(trimmedBody.calls).toBe(1);
      expect(trimmedBody.totals).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 300 });

      const empty = await app.request("http://127.0.0.1/api/usage/summary?agentId=");
      expect(empty.status).toBe(200);
      const emptyBody = (await empty.json()) as Record<string, unknown>;
      // 空串视为未提供：返回全部 5 行
      expect(emptyBody.calls).toBe(5);
      database.close();
    });

    it("returns 400 for invalid source", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary?source=unknown");
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("INVALID_INPUT");
      expect(body.message).toBe("source 必须是 main、subagent、utility 之一");
      database.close();
    });

    it("returns 400 for invalid role", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary?role=admin");
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("INVALID_INPUT");
      expect(body.message).toBe("role 必须是 primary、secondary 之一");
      database.close();
    });

    it("returns 400 for invalid days combined with valid filter", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://127.0.0.1/api/usage/summary?source=utility&days=999");
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("INVALID_INPUT");
      expect(body.message).toBe("days 必须是 1-365 的整数");
      database.close();
    });

    it("combines source and sessionId filters", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?source=subagent&sessionId=s-mix");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.calls).toBe(2);
      expect(body.turns).toBe(0);
      expect(body.totals).toEqual({ input: 200, output: 100, cacheRead: 40, cacheWrite: 20, totalTokens: 500 });
      database.close();
    });

    it("combines source and providerId filters", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary?source=utility&providerId=faux");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.calls).toBe(1);
      expect(body.totals).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 400 });
      database.close();
    });

    it("returns calls/bySource/byRole/byStatus with correct shapes", async () => {
      const { app, usageStore, database } = createContext();
      const now = new Date().toISOString();
      insertRecord(usageStore, { sessionId: "s1", turnId: "t1", provider: "faux", model: "faux-1", totalTokens: 100, createdAt: now });
      insertRecord(usageStore, { source: "subagent", sessionId: "s1", turnId: null, agentId: "agent-x", runId: "run-1", provider: "faux", model: "faux-2", totalTokens: 200, createdAt: now });
      insertRecord(usageStore, { source: "utility", sessionId: null, turnId: null, callId: "call-1", provider: "other", model: "other-1", totalTokens: 350, createdAt: now });
      insertRecord(usageStore, { source: "main", sessionId: "s1", turnId: "t2", totalTokens: 400, status: "failed", createdAt: now });

      const response = await app.request("http://127.0.0.1/api/usage/summary?days=1");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.calls).toBe(4);
      expect(body.turns).toBe(2);
      expect(body.sessions).toBe(1);

      // 每行缺省 input=100 output=50 cacheRead=20 cacheWrite=10；分组和随行数变化
      const oneRow = { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 };
      const twoRows = { input: 200, output: 100, cacheRead: 40, cacheWrite: 20 };
      const threeRows = { input: 300, output: 150, cacheRead: 60, cacheWrite: 30 };
      // bySource 按 total_tokens 降序：main(500) > utility(350) > subagent(200)
      expect(body.bySource).toEqual([
        { source: "main", ...twoRows, totalTokens: 500, calls: 2 },
        { source: "utility", ...oneRow, totalTokens: 350, calls: 1 },
        { source: "subagent", ...oneRow, totalTokens: 200, calls: 1 },
      ]);
      // byRole 按 total_tokens 降序：secondary(550) > primary(500)
      expect(body.byRole).toEqual([
        { role: "secondary", ...twoRows, totalTokens: 550, calls: 2 },
        { role: "primary", ...twoRows, totalTokens: 500, calls: 2 },
      ]);
      // byStatus 按 calls 降序：completed(3) > failed(1)
      expect(body.byStatus).toEqual([
        { status: "completed", ...threeRows, totalTokens: 650, calls: 3 },
        { status: "failed", ...oneRow, totalTokens: 400, calls: 1 },
      ]);
      database.close();
    });

    it("keeps legacy field shapes alongside new A8 fields", async () => {
      const { app, usageStore, database } = createContext();
      insertMixedRecords(usageStore, "s-mix");

      const response = await app.request("http://127.0.0.1/api/usage/summary");
      const body = (await response.json()) as Record<string, unknown>;
      // 既有字段零变化：键集合包含旧字段且形状不变
      expect(Object.keys(body)).toEqual(
        expect.arrayContaining(["days", "totals", "cacheHitRate", "sessions", "turns", "byDay", "byModel", "calls", "bySource", "byRole", "byStatus"]),
      );
      expect(body.days).toBe(30);
      expect(body.sessions).toBe(1); // 仅 s-mix（utility 无会话归属，不计入 sessions）
      expect(body.turns).toBe(2);
      expect(body.calls).toBe(5);
      expect(Array.isArray(body.byDay)).toBe(true);
      expect(Array.isArray(body.byModel)).toBe(true);
      database.close();
    });
  });
});
