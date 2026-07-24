import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentStore } from "../../src/config/agent-store.js";
import type { AgentView } from "../../src/contracts/agent-identity.js";

let tempDirs: string[] = [];

function makeTempAgentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-agentstore-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("AgentStore", () => {
  it("lists empty when no agents exist", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    expect(store.list()).toEqual([]);
  });

  it("creates an agent and reads it back", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    const identity = store.create({ id: "my-assistant", type: "assistant", name: "小助手" });

    expect(identity.version).toBe(1);
    expect(identity.id).toBe("my-assistant");
    expect(identity.type).toBe("assistant");
    expect(identity.name).toBe("小助手");
    expect(identity.createdAt).toBeTruthy();

    const view = store.load("my-assistant");
    expect(view.identity).toEqual(identity);
    expect(view.profile).toBeNull();
    expect(view.sessionCount).toBe(0);
  });

  it("rejects invalid agent id", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    expect(() => store.create({ id: "INVALID ID!", type: "coding", name: "x" })).toThrow("ID 格式无效");
    expect(() => store.create({ id: "../escape", type: "work", name: "x" })).toThrow("ID 格式无效");
  });

  it("rejects duplicate agent id", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "test", type: "assistant", name: "Test" });
    expect(() => store.create({ id: "test", type: "coding", name: "Dup" })).toThrow("已存在");
  });

  it("updates identity fields", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "ag1", type: "assistant", name: "旧名" });

    const updated = store.updateIdentity("ag1", { name: "新名", type: "coding" });
    expect(updated.name).toBe("新名");
    expect(updated.type).toBe("coding");
    expect(updated.id).toBe("ag1"); // 不可变
  });

  it("saves and reads profile", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "ag1", type: "work", name: "Worker" });

    const profile = store.saveProfile("ag1", {
      persona: "你是一个高效的工作助手",
      personality: ["严谨", "高效"],
      replyStyle: "专业",
    });
    expect(profile.persona).toBe("你是一个高效的工作助手");

    const reloaded = store.load("ag1");
    expect(reloaded.profile?.personality).toEqual(["严谨", "高效"]);
  });

  it("archives agent (renames directory)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "old", type: "assistant", name: "Old" });

    store.archive("old");
    expect(store.list()).toEqual([]);

    expect(fs.existsSync(path.join(dir, ".archived-old"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "old"))).toBe(false);
  });

  it("rejects path traversal in agent id", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    expect(() => store.create({ id: "../../escape", type: "assistant", name: "x" })).toThrow("ID 格式无效");
    expect(() => store.load("../../escape")).toThrow("路径字符");
  });

  it("allows duplicate names (name is not unique)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "a1", type: "assistant", name: "小助手" });
    store.create({ id: "a2", type: "assistant", name: "小助手" });

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.identity.name).toBe("小助手");
    expect(list[1]!.identity.name).toBe("小助手");
  });

  it("skips corrupted agent directories in list", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "good", type: "assistant", name: "Good" });

    // 手动创建一个损坏的 agent 目录（缺少 identity.json）
    fs.mkdirSync(path.join(dir, "bad"), { recursive: true });

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.identity.id).toBe("good");
  });
});
