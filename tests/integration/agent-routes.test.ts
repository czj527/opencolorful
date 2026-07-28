import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { DECOR_COLORS } from "../../src/contracts/agent-identity.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];

function createAgentContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-agent-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ PERSON_AGENT_HOME: directory });
  const agentStore = new AgentStore(paths.agents);
  const { app } = createServerApp({ agentStore });
  return { paths, agentStore, app };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const blankBaseColor = {
  persona: "",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

describe("Agent routes", () => {
  it("creates an agent with auto-generated UUID when id is not provided", async () => {
    const { app } = createAgentContext();

    const createRes = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "测试助手", baseColor: blankBaseColor }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { identity: { id: string } };
    const agentId = created.identity.id;
    // UUID v4 格式: 小写，36 字符，含连字符
    expect(agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("creates an agent with explicit id when provided", async () => {
    const { app } = createAgentContext();

    const createRes = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "my-agent-1", name: "编码助手", baseColor: blankBaseColor }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { identity: { id: string; name: string } };
    expect(created.identity.id).toBe("my-agent-1");
    expect(created.identity.name).toBe("编码助手");
  });

  it("returns 409 when creating an agent with duplicate id", async () => {
    const { app } = createAgentContext();

    const first = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup-agent", name: "重复助手", baseColor: blankBaseColor }),
    });
    expect(first.status).toBe(201);

    const second = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup-agent", name: "同名助手", baseColor: blankBaseColor }),
    });
    expect(second.status).toBe(409);
    const error = (await second.json()) as { code: string };
    expect(error.code).toBe("CONFLICT");
  });

  it("returns 400 for missing baseColor", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "无底色" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty agent name", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", baseColor: blankBaseColor }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects names longer than 100 characters without creating an agent directory", async () => {
    const { app, paths } = createAgentContext();

    const res = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "too-long", name: "a".repeat(101), baseColor: blankBaseColor }),
    });

    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(paths.agents, "too-long"))).toBe(false);
  });

  it("returns 400 for invalid agent id format", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "INVALID_ID!", name: "坏ID", baseColor: blankBaseColor }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects legacy type and template metadata instead of silently ignoring them", async () => {
    const { app, paths } = createAgentContext();

    const legacyType = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "legacy-type",
        name: "旧类型",
        type: "assistant",
        baseColor: blankBaseColor,
      }),
    });
    const templateMetadata = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "template-metadata",
        name: "模板元数据",
        baseColor: { ...blankBaseColor, templateId: "blue" },
      }),
    });

    expect(legacyType.status).toBe(400);
    expect(templateMetadata.status).toBe(400);
    expect(fs.existsSync(path.join(paths.agents, "legacy-type"))).toBe(false);
    expect(fs.existsSync(path.join(paths.agents, "template-metadata"))).toBe(false);
  });

  it("lists all agents", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent-a", name: "助手A", baseColor: blankBaseColor }),
    });
    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent-b", name: "助手B", baseColor: blankBaseColor }),
    });

    const listRes = await app.request("http://local/api/agents");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { identity: { id: string } }[];
    expect(list.length).toBe(2);
    const ids = list.map((v) => v.identity.id).sort();
    expect(ids).toEqual(["agent-a", "agent-b"]);
  });

  it("gets an agent by id and returns full view (baseColor/settings/decorColor)", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "get-me", name: "工作助手", baseColor: blankBaseColor }),
    });

    const getRes = await app.request("http://local/api/agents/get-me");
    expect(getRes.status).toBe(200);
    const view = (await getRes.json()) as {
      identity: { id: string };
      baseColor: { persona: string };
      settings: { defaultCwd: string | null };
      decorColor: string;
      sessionCount: number;
    };
    expect(view.identity.id).toBe("get-me");
    expect(view.baseColor).toBeTruthy();
    expect(view.baseColor.persona).toBe("");
    expect(view.settings).toBeTruthy();
    expect(view.settings.defaultCwd).toBeNull();
    expect(DECOR_COLORS).toContain(view.decorColor);
    expect(view.sessionCount).toBe(0);
  });

  it("returns 404 for non-existent agent", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents/no-such-agent");
    expect(res.status).toBe(404);
  });

  it("updates agent identity name only (PUT 只接受 { name })", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "up-me", name: "原名称", baseColor: blankBaseColor }),
    });

    const putRes = await app.request("http://local/api/agents/up-me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新名称" }),
    });
    expect(putRes.status).toBe(200);
    const view = (await putRes.json()) as { identity: { name: string } };
    expect(view.identity.name).toBe("新名称");
  });

  it("rejects identity updates longer than 100 characters and preserves the original name", async () => {
    const { app } = createAgentContext();
    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "long-update", name: "原名称", baseColor: blankBaseColor }),
    });

    const putRes = await app.request("http://local/api/agents/long-update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(101) }),
    });
    expect(putRes.status).toBe(400);

    const view = (await (await app.request("http://local/api/agents/long-update")).json()) as {
      identity: { name: string };
    };
    expect(view.identity.name).toBe("原名称");
  });

  it("returns 400 when PUT has no updatable field", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "empty-put", name: "原名称", baseColor: blankBaseColor }),
    });

    const putRes = await app.request("http://local/api/agents/empty-put", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(putRes.status).toBe(400);
  });

  it("gets and updates agent base-color (原 profile)", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "prof-me", name: "配置文件", baseColor: blankBaseColor }),
    });

    // 初始 baseColor 为空白
    const getProf = await app.request("http://local/api/agents/prof-me/base-color");
    expect(getProf.status).toBe(200);
    const initBaseColor = (await getProf.json()) as { persona: string; innerSetting: string };
    expect(initBaseColor.persona).toBe("");
    expect(initBaseColor.innerSetting).toBe("");

    // 更新 baseColor
    const putProf = await app.request("http://local/api/agents/prof-me/base-color", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona: "你是一个友好的助手",
        personality: ["友好", "专业"],
        replyStyle: "日常",
        innerSetting: "尊重对方节奏",
      }),
    });
    expect(putProf.status).toBe(200);

    // 再次获取
    const getProf2 = await app.request("http://local/api/agents/prof-me/base-color");
    expect(getProf2.status).toBe(200);
    const updatedBaseColor = (await getProf2.json()) as {
      persona: string;
      personality: string[];
      replyStyle: string;
      innerSetting: string;
    };
    expect(updatedBaseColor.persona).toBe("你是一个友好的助手");
    expect(updatedBaseColor.personality).toEqual(["友好", "专业"]);
    expect(updatedBaseColor.replyStyle).toBe("日常");
    expect(updatedBaseColor.innerSetting).toBe("尊重对方节奏");
  });

  it("gets and updates agent settings", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "set-me", name: "设置", baseColor: blankBaseColor }),
    });

    // 初始 settings 默认 defaultCwd=null
    const getSet = await app.request("http://local/api/agents/set-me/settings");
    expect(getSet.status).toBe(200);
    const initSettings = (await getSet.json()) as { defaultCwd: string | null };
    expect(initSettings.defaultCwd).toBeNull();

    // 更新 settings
    const putSet = await app.request("http://local/api/agents/set-me/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultCwd: "/home/user" }),
    });
    expect(putSet.status).toBe(200);

    const getSet2 = await app.request("http://local/api/agents/set-me/settings");
    const updatedSettings = (await getSet2.json()) as { defaultCwd: string | null };
    expect(updatedSettings.defaultCwd).toBe("/home/user");
  });

  it("returns 404 for base-color and settings operations on a missing agent without creating files", async () => {
    const { app, paths } = createAgentContext();
    const missingDir = path.join(paths.agents, "ghost-agent");

    const getBaseColor = await app.request("http://local/api/agents/ghost-agent/base-color");
    const putBaseColor = await app.request("http://local/api/agents/ghost-agent/base-color", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: "ghost" }),
    });
    const getSettings = await app.request("http://local/api/agents/ghost-agent/settings");
    const putSettings = await app.request("http://local/api/agents/ghost-agent/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultCwd: "C:\\ghost" }),
    });

    expect(getBaseColor.status).toBe(404);
    expect(putBaseColor.status).toBe(404);
    expect(getSettings.status).toBe(404);
    expect(putSettings.status).toBe(404);
    expect(fs.existsSync(missingDir)).toBe(false);
  });

  it("lists base-color templates", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents/templates");
    expect(res.status).toBe(200);
    const templates = (await res.json()) as { key: string; baseColor: { innerSetting: string } }[];
    expect(templates.length).toBeGreaterThan(0);
    // 模板必须含 innerSetting 字段
    for (const t of templates) {
      expect(typeof t.baseColor.innerSetting).toBe("string");
    }
  });

  it("archives an agent", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "arch-me", name: "待归档", baseColor: blankBaseColor }),
    });

    const archiveRes = await app.request("http://local/api/agents/arch-me/archive", {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    const result = (await archiveRes.json()) as { status: string };
    expect(result.status).toBe("archived");

    // 归档后不在列表中
    const list = await (await app.request("http://local/api/agents")).json() as unknown[];
    expect(list.length).toBe(0);

    // 归档后 GET 返回 404
    const getRes = await app.request("http://local/api/agents/arch-me");
    expect(getRes.status).toBe(404);
  });
});
