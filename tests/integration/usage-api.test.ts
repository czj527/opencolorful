import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { UsageStore } from "../../src/storage/usage-store.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-usage-api-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const usageStore = new UsageStore(database);
  const { app } = createServerApp({ usageStore });
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
    sessionId: string;
    turnId: string;
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
  }> = {},
) {
  store.record({
    sessionId: overrides.sessionId ?? "session-1",
    turnId: overrides.turnId ?? `turn-${crypto.randomUUID()}`,
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
  });
}

describe("usage API", () => {
  describe("GET /api/sessions/:id/usage", () => {
    it("returns zeroed structure for a session with no records", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://local/api/sessions/session-empty/usage");
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

      const response = await app.request("http://local/api/sessions/s1/usage");
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

      const response = await app.request("http://local/api/sessions/s1/usage");
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

      const response = await app.request("http://local/api/sessions/s1/usage");
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

      const response = await app.request("http://local/api/sessions/s1/usage");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.context).toBeNull();
      database.close();
    });
  });

  describe("GET /api/usage/summary", () => {
    it("returns empty structure when no records exist", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://local/api/usage/summary");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.days).toBe(30);
      expect(body.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
      expect(body.cacheHitRate).toBeNull();
      expect(body.sessions).toBe(0);
      expect(body.turns).toBe(0);
      expect(body.byDay).toEqual([]);
      expect(body.byModel).toEqual([]);
      database.close();
    });

    it("returns aggregated summary with default days=30", async () => {
      const { app, usageStore, database } = createContext();
      const today = new Date().toISOString();
      insertRecord(usageStore, { sessionId: "s1", turnId: "t1", createdAt: today });
      insertRecord(usageStore, { sessionId: "s2", turnId: "t2", createdAt: today });

      const response = await app.request("http://local/api/usage/summary");
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

      const response = await app.request("http://local/api/usage/summary?days=7");
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.days).toBe(7);
      database.close();
    });

    it("returns 400 for days=0", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://local/api/usage/summary?days=0");
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe("INVALID_INPUT");
      expect(body.message).toBe("days 必须是 1-365 的整数");
      database.close();
    });

    it("returns 400 for days=366", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://local/api/usage/summary?days=366");
      expect(response.status).toBe(400);
      database.close();
    });

    it("returns 400 for non-integer days", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://local/api/usage/summary?days=abc");
      expect(response.status).toBe(400);
      database.close();
    });

    it("returns 400 for float days", async () => {
      const { app, database } = createContext();
      const response = await app.request("http://local/api/usage/summary?days=7.5");
      expect(response.status).toBe(400);
      database.close();
    });

    it("aggregates byDay correctly", async () => {
      const { app, usageStore, database } = createContext();
      const today = new Date().toISOString().slice(0, 10);
      insertRecord(usageStore, { turnId: "t1", createdAt: `${today}T08:00:00.000Z` });
      insertRecord(usageStore, { turnId: "t2", createdAt: `${today}T12:00:00.000Z` });

      const response = await app.request("http://local/api/usage/summary?days=1");
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

      const response = await app.request("http://local/api/usage/summary?days=1");
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

      const response = await app.request("http://local/api/usage/summary?days=5");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.turns).toBe(1);
      database.close();
    });
  });
});
