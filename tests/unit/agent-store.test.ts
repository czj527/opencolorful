import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentStore } from "../../src/config/agent-store.js";
import { DECOR_COLORS, defaultBaseColor } from "../../src/contracts/agent-identity.js";
import { defaultAgentSettings } from "../../src/contracts/agent-settings.js";

let tempDirs: string[] = [];

function makeTempAgentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-agentstore-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const blankBaseColor = {
  persona: "",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

describe("AgentStore", () => {
  it("lists empty when no agents exist", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    expect(store.list()).toEqual([]);
  });

  it("creates an agent and reads it back", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    const identity = store.create({ id: "my-assistant", name: "小助手", baseColor: blankBaseColor });

    expect(identity.version).toBe(2);
    expect(identity.id).toBe("my-assistant");
    expect(identity.name).toBe("小助手");
    expect(identity.createdAt).toBeTruthy();

    const view = store.load("my-assistant");
    expect(view.identity).toEqual(identity);
    // 新契约：baseColor 不再为 null，默认空白底色
    expect(view.baseColor.version).toBe(1);
    expect(view.baseColor.persona).toBe("");
    expect(view.baseColor.personality).toEqual([]);
    expect(view.baseColor.replyStyle).toBe("");
    expect(view.baseColor.innerSetting).toBe("");
    expect(view.baseColor.updatedAt).toBeTruthy();
    // 新契约：AgentView 含 settings 与 decorColor
    expect(view.settings.version).toBe(2);
    expect(view.settings.defaultCwd).toBeNull();
    expect(view.settings.updatedAt).toBeTruthy();
    expect(DECOR_COLORS).toContain(view.decorColor);
    expect(view.sessionCount).toBe(0);
  });

  it("creates an agent with defaultCwd and reads settings back", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({
      id: "cwd-agent",
      name: "工作目录助手",
      baseColor: blankBaseColor,
      defaultCwd: "/tmp/work",
    });

    const view = store.load("cwd-agent");
    expect(view.settings.defaultCwd).toBe("/tmp/work");
    expect(view.settings.version).toBe(2);
  });

  it("rejects invalid agent id", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    expect(() => store.create({ id: "INVALID ID!", name: "x", baseColor: blankBaseColor })).toThrow("ID 格式无效");
    expect(() => store.create({ id: "../escape", name: "x", baseColor: blankBaseColor })).toThrow("ID 格式无效");
  });

  it("rejects an overlong name before creating the agent directory", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);

    expect(() => store.create({
      id: "too-long",
      name: "a".repeat(101),
      baseColor: blankBaseColor,
    })).toThrow("名称长度");
    expect(fs.existsSync(path.join(dir, "too-long"))).toBe(false);
  });

  it("rejects duplicate agent id", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "test", name: "Test", baseColor: blankBaseColor });
    expect(() => store.create({ id: "test", name: "Dup", baseColor: blankBaseColor })).toThrow("已存在");
  });

  it("updates identity name (id/createdAt immutable)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "ag1", name: "旧名", baseColor: blankBaseColor });

    const updated = store.updateIdentity("ag1", { name: "新名" });
    expect(updated.name).toBe("新名");
    expect(updated.id).toBe("ag1"); // 不可变
    expect(updated.version).toBe(2);
  });

  it("rejects an overlong identity update without corrupting the stored identity", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "ag1", name: "原名称", baseColor: blankBaseColor });

    expect(() => store.updateIdentity("ag1", { name: "a".repeat(101) })).toThrow("名称长度");
    expect(store.load("ag1").identity.name).toBe("原名称");
  });

  it("saves and reads baseColor (底色修改)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "ag1", name: "Worker", baseColor: blankBaseColor });

    const baseColor = store.saveBaseColor("ag1", {
      persona: "你是一个高效的工作助手",
      personality: ["严谨", "高效"],
      replyStyle: "专业",
    });
    expect(baseColor.persona).toBe("你是一个高效的工作助手");
    expect(baseColor.personality).toEqual(["严谨", "高效"]);
    // 未传 innerSetting 时保留空白
    expect(baseColor.innerSetting).toBe("");
    expect(baseColor.version).toBe(1);
    expect(baseColor.updatedAt).toBeTruthy();

    const reloaded = store.load("ag1");
    expect(reloaded.baseColor.personality).toEqual(["严谨", "高效"]);
  });

  it("getBaseColor returns default when not saved (不再返回 null)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "empty", name: "空底色", baseColor: blankBaseColor });

    const baseColor = store.getBaseColor("empty");
    expect(baseColor.persona).toBe("");
    expect(baseColor.innerSetting).toBe("");
    // 与 defaultBaseColor 结构一致（updatedAt 动态）
    expect(baseColor.version).toBe(defaultBaseColor().version);
  });

  it("saves and reads settings", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "set-me", name: "设置", baseColor: blankBaseColor });

    const settings = store.saveSettings("set-me", { defaultCwd: "/home/user" });
    expect(settings.defaultCwd).toBe("/home/user");
    expect(settings.version).toBe(2);

    const reloaded = store.load("set-me");
    expect(reloaded.settings.defaultCwd).toBe("/home/user");
  });

  it("getSettings returns default when not saved", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "no-set", name: "默认设置", baseColor: blankBaseColor });

    const settings = store.getSettings("no-set");
    expect(settings.defaultCwd).toBeNull();
    expect(settings.version).toBe(defaultAgentSettings().version);
  });

  it("rejects base-color and settings access for a missing agent without creating a ghost directory", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);

    expect(() => store.getBaseColor("ghost")).toThrow("Agent 不存在");
    expect(() => store.saveBaseColor("ghost", { persona: "ghost" })).toThrow("Agent 不存在");
    expect(() => store.getSettings("ghost")).toThrow("Agent 不存在");
    expect(() => store.saveSettings("ghost", { defaultCwd: "C:\\ghost" })).toThrow("Agent 不存在");
    expect(fs.existsSync(path.join(dir, "ghost"))).toBe(false);
  });

  it("migrates legacy identity (含 type) and profile.json to new contract", () => {
    const dir = makeTempAgentsDir();
    const agentDir = path.join(dir, "legacy-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    // 旧 identity.json（version 1，含 type）
    fs.writeFileSync(
      path.join(agentDir, "identity.json"),
      JSON.stringify({ version: 1, id: "legacy-agent", type: "assistant", name: "旧Agent", createdAt: "2024-01-01T00:00:00.000Z" }, null, 2),
    );
    // 旧 profile.json（无 innerSetting）
    fs.writeFileSync(
      path.join(agentDir, "profile.json"),
      JSON.stringify({ persona: "旧人设", personality: ["稳重"], replyStyle: "平实" }, null, 2),
    );

    const store = new AgentStore(dir);
    const report = store.migrate();

    expect(report.total).toBe(1);
    expect(report.migrated).toBe(1);
    expect(report.failed).toBe(0);

    // 迁移后 identity 去 type，version 2
    const view = store.load("legacy-agent");
    expect(view.identity.version).toBe(2);
    expect((view.identity as unknown as Record<string, unknown>).type).toBeUndefined();
    expect(view.identity.name).toBe("旧Agent");

    // profile.json → base-color.json，innerSetting 补空
    expect(view.baseColor.persona).toBe("旧人设");
    expect(view.baseColor.personality).toEqual(["稳重"]);
    expect(view.baseColor.replyStyle).toBe("平实");
    expect(view.baseColor.innerSetting).toBe("");
    // 旧 profile.json 已删除
    expect(fs.existsSync(path.join(agentDir, "profile.json"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "base-color.json"))).toBe(true);
  });

  it("migrate is idempotent (已迁移的跳过)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "new-agent", name: "新Agent", baseColor: blankBaseColor });

    const report = store.migrate();
    expect(report.total).toBe(1);
    expect(report.migrated).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it("preserves every legacy file when migration preparation fails", () => {
    const dir = makeTempAgentsDir();
    const agentDir = path.join(dir, "broken-legacy");
    fs.mkdirSync(agentDir, { recursive: true });
    const identityPath = path.join(agentDir, "identity.json");
    const profilePath = path.join(agentDir, "profile.json");
    const originalIdentity = `${JSON.stringify({
      version: 1,
      id: "broken-legacy",
      type: "assistant",
      name: "旧 Agent",
      createdAt: "2024-01-01T00:00:00.000Z",
    }, null, 2)}\n`;
    fs.writeFileSync(identityPath, originalIdentity, "utf8");
    fs.writeFileSync(profilePath, "{ invalid json", "utf8");

    const store = new AgentStore(dir);
    const report = store.migrate();

    expect(report.failed).toBe(1);
    expect(fs.readFileSync(identityPath, "utf8")).toBe(originalIdentity);
    expect(fs.readFileSync(profilePath, "utf8")).toBe("{ invalid json");
    expect(fs.existsSync(path.join(agentDir, "base-color.json"))).toBe(false);
  });

  it("archives agent (renames directory)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "old", name: "Old", baseColor: blankBaseColor });

    store.archive("old");
    expect(store.list()).toEqual([]);

    expect(fs.existsSync(path.join(dir, ".archived-old"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "old"))).toBe(false);
  });

  it("rejects path traversal in agent id", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    expect(() => store.create({ id: "../../escape", name: "x", baseColor: blankBaseColor })).toThrow("ID 格式无效");
    expect(() => store.load("../../escape")).toThrow("路径字符");
  });

  it("allows duplicate names (name is not unique)", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "a1", name: "小助手", baseColor: blankBaseColor });
    store.create({ id: "a2", name: "小助手", baseColor: blankBaseColor });

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.identity.name).toBe("小助手");
    expect(list[1]!.identity.name).toBe("小助手");
  });

  it("skips corrupted agent directories in list", () => {
    const dir = makeTempAgentsDir();
    const store = new AgentStore(dir);
    store.create({ id: "good", name: "Good", baseColor: blankBaseColor });

    // 手动创建一个损坏的 agent 目录（缺少 identity.json）
    fs.mkdirSync(path.join(dir, "bad"), { recursive: true });

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.identity.id).toBe("good");
  });
});
