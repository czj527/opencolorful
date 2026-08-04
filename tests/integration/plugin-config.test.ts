import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginConfigStore } from "../../src/storage/plugin-config-store.js";

// ═══════════════════════════════════════════════════════════════
// T3 插件配置存储（plugin_configs）
// - 全局（agentId=''）与 per-Agent 非敏感配置分离；
// - revision 按 (plugin_id, agent_id) 单调递增（配置变更下一 turn 生效）；
// - 配置变更的严格审计由 T5 Config contribution 接入，本层只做原子读写。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createStore(): { store: PluginConfigStore; db: Database.Database } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t3-config-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const db = openMetadataDatabase(paths.database);
  openDatabases.push(db);
  return { store: new PluginConfigStore(db), db };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("T3 PluginConfigStore", () => {
  it("首次写入 revision = 1，每次写入单调 +1，不覆盖旧 revision 计数", () => {
    const { store } = createStore();
    expect(store.maxRevision("example.p", "")).toBe(0);
    expect(store.set({ pluginId: "example.p", agentId: "", config: { theme: "light" }, updatedAt: "t1" }).revision).toBe(1);
    expect(store.set({ pluginId: "example.p", agentId: "", config: { theme: "dark" }, updatedAt: "t2" }).revision).toBe(2);
    expect(store.get("example.p", "")?.revision).toBe(2);
    expect(store.get("example.p", "")?.config).toEqual({ theme: "dark" });
  });

  it("全局与 per-Agent 配置隔离，各自独立 revision", () => {
    const { store } = createStore();
    store.set({ pluginId: "example.p", agentId: "", config: { scope: "global" }, updatedAt: "t1" });
    store.set({ pluginId: "example.p", agentId: "a1", config: { scope: "agent" }, updatedAt: "t2" });
    store.set({ pluginId: "example.p", agentId: "a1", config: { scope: "agent-v2" }, updatedAt: "t3" });
    expect(store.get("example.p", "")?.revision).toBe(1);
    expect(store.get("example.p", "a1")?.revision).toBe(2);
    expect(store.get("example.p", "")?.config).toEqual({ scope: "global" });
    expect(store.get("example.p", "a1")?.config).toEqual({ scope: "agent-v2" });
    expect(store.list("example.p")).toHaveLength(2);
  });

  it("remove 删除指定 agent 配置；removeAll 清空插件全部配置", () => {
    const { store } = createStore();
    store.set({ pluginId: "example.p", agentId: "", config: { a: 1 }, updatedAt: "t1" });
    store.set({ pluginId: "example.p", agentId: "a1", config: { a: 2 }, updatedAt: "t2" });
    store.remove("example.p", "a1");
    expect(store.get("example.p", "a1")).toBeNull();
    expect(store.get("example.p", "")).not.toBeNull();
    store.removeAll("example.p");
    expect(store.listAll()).toHaveLength(0);
  });

  it("不同插件配置互不影响", () => {
    const { store } = createStore();
    store.set({ pluginId: "example.a", agentId: "", config: { x: 1 }, updatedAt: "t1" });
    store.set({ pluginId: "example.b", agentId: "", config: { y: 2 }, updatedAt: "t2" });
    expect(store.get("example.a", "")?.revision).toBe(1);
    expect(store.get("example.b", "")?.revision).toBe(1);
  });
});
