import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
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

describe("Agent routes", () => {
  it("creates an agent with auto-generated UUID when id is not provided", async () => {
    const { app } = createAgentContext();

    const createRes = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "assistant", name: "测试助手" }),
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
      body: JSON.stringify({ id: "my-agent-1", type: "coding", name: "编码助手" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { identity: { id: string; type: string; name: string } };
    expect(created.identity.id).toBe("my-agent-1");
    expect(created.identity.type).toBe("coding");
    expect(created.identity.name).toBe("编码助手");
  });

  it("returns 409 when creating an agent with duplicate id", async () => {
    const { app } = createAgentContext();

    const first = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup-agent", type: "assistant", name: "重复助手" }),
    });
    expect(first.status).toBe(201);

    const second = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup-agent", type: "assistant", name: "同名助手" }),
    });
    expect(second.status).toBe(409);
    const error = (await second.json()) as { code: string };
    expect(error.code).toBe("CONFLICT");
  });

  it("returns 400 for invalid agent type", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid", name: "无效类型" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty agent name", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "assistant", name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid agent id format", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "INVALID_ID!", type: "assistant", name: "坏ID" }),
    });
    expect(res.status).toBe(400);
  });

  it("lists all agents", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent-a", type: "assistant", name: "助手A" }),
    });
    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent-b", type: "coding", name: "助手B" }),
    });

    const listRes = await app.request("http://local/api/agents");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { identity: { id: string } }[];
    expect(list.length).toBe(2);
    const ids = list.map((v) => v.identity.id).sort();
    expect(ids).toEqual(["agent-a", "agent-b"]);
  });

  it("gets an agent by id", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "get-me", type: "work", name: "工作助手" }),
    });

    const getRes = await app.request("http://local/api/agents/get-me");
    expect(getRes.status).toBe(200);
    const view = (await getRes.json()) as { identity: { id: string; type: string } };
    expect(view.identity.id).toBe("get-me");
    expect(view.identity.type).toBe("work");
  });

  it("returns 404 for non-existent agent", async () => {
    const { app } = createAgentContext();

    const res = await app.request("http://local/api/agents/no-such-agent");
    expect(res.status).toBe(404);
  });

  it("updates agent identity (type/name)", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "up-me", type: "assistant", name: "原名称" }),
    });

    const putRes = await app.request("http://local/api/agents/up-me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "coding", name: "新名称" }),
    });
    expect(putRes.status).toBe(200);
    const view = (await putRes.json()) as { identity: { type: string; name: string } };
    expect(view.identity.type).toBe("coding");
    expect(view.identity.name).toBe("新名称");
  });

  it("gets and updates agent profile", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "prof-me", type: "assistant", name: "配置文件" }),
    });

    // 初始 profile 为空
    const getProf = await app.request("http://local/api/agents/prof-me/profile");
    expect(getProf.status).toBe(200);
    const initProfile = (await getProf.json()) as Record<string, unknown>;
    // 未设置时返回空对象
    expect(initProfile.persona).toBeUndefined();

    // 更新 profile
    const putProf = await app.request("http://local/api/agents/prof-me/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona: "你是一个友好的助手",
        personality: ["友好", "专业"],
        replyStyle: "日常",
      }),
    });
    expect(putProf.status).toBe(200);

    // 再次获取
    const getProf2 = await app.request("http://local/api/agents/prof-me/profile");
    expect(getProf2.status).toBe(200);
    const updatedProfile = (await getProf2.json()) as { persona: string; personality: string[]; replyStyle: string };
    expect(updatedProfile.persona).toBe("你是一个友好的助手");
    expect(updatedProfile.personality).toEqual(["友好", "专业"]);
    expect(updatedProfile.replyStyle).toBe("日常");
  });

  it("archives an agent", async () => {
    const { app } = createAgentContext();

    await app.request("http://local/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "arch-me", type: "assistant", name: "待归档" }),
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
