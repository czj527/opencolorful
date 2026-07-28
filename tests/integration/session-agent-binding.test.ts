import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createServerApp } from "../../src/server/app.js";

const temporaryDirectories: string[] = [];

const blankBaseColor = {
  persona: "",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

interface TestContext {
  paths: ReturnType<typeof getRuntimePaths>;
  database: ReturnType<typeof openMetadataDatabase>;
  index: SessionIndex;
  sessionService: SessionService;
  agentStore: AgentStore;
  app: ReturnType<typeof createServerApp>["app"];
  dispose(): void;
}

function createTestContext(): TestContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-sa-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const index = new SessionIndex(database);
  const sessionService = new SessionService(paths, index);
  const agentStore = new AgentStore(paths.agents);
  const { app } = createServerApp({ sessionService, agentStore, paths });

  return {
    paths,
    database,
    index,
    sessionService,
    agentStore,
    app,
    dispose() {
      sessionService.closeAll();
      database.close();
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Session-Agent binding", () => {
  it("creates session without agentId (NULL agent)", async () => {
    const ctx = createTestContext();
    try {
      const res = await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "无Agent会话", cwd: process.cwd() }),
      });
      expect(res.status).toBe(201);
      const view = (await res.json()) as { id: string; sessionPath: string; agentId: string | null };
      expect(view.agentId).toBeNull();
      // 会话文件落在 sessions/ 根目录下（PI SDK 会在文件名前加时间戳，后缀 .jsonl）
      expect(view.sessionPath).toContain(ctx.paths.sessions);
      expect(view.sessionPath.endsWith(".jsonl")).toBe(true);
      expect(fs.existsSync(view.sessionPath)).toBe(true);
    } finally {
      ctx.dispose();
    }
  });

  it("creates session bound to an Agent and stores under agents/<id>/sessions/", async () => {
    const ctx = createTestContext();
    try {
      // 先创建 Agent
      const agentRes = await ctx.app.request("http://local/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "bind-me", name: "绑定助手", baseColor: blankBaseColor }),
      });
      expect(agentRes.status).toBe(201);
      const agentView = (await agentRes.json()) as { identity: { id: string } };
      const agentId = agentView.identity.id;

      // 创建绑定到该 Agent 的会话
      const res = await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Agent会话", cwd: process.cwd(), agentId }),
      });
      expect(res.status).toBe(201);
      const view = (await res.json()) as { id: string; sessionPath: string; agentId: string | null };
      expect(view.agentId).toBe(agentId);
      // 会话文件落在 agents/<id>/sessions/ 下
      const expectedDir = path.join(ctx.paths.agents, agentId, "sessions");
      expect(view.sessionPath).toContain(expectedDir);
      expect(fs.existsSync(view.sessionPath)).toBe(true);
    } finally {
      ctx.dispose();
    }
  });

  it("returns 404 when creating session with non-existent agentId", async () => {
    const ctx = createTestContext();
    try {
      const res = await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "坏Agent会话", cwd: process.cwd(), agentId: "no-such-agent" }),
      });
      expect(res.status).toBe(404);
      const error = (await res.json()) as { code: string };
      expect(error.code).toBe("NOT_FOUND");
    } finally {
      ctx.dispose();
    }
  });

  it("returns 400 for invalid agentId format in session creation", async () => {
    const ctx = createTestContext();
    try {
      const res = await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "坏格式", cwd: process.cwd(), agentId: "INVALID!" }),
      });
      expect(res.status).toBe(400);
      const error = (await res.json()) as { code: string };
      expect(error.code).toBe("INVALID_INPUT");
    } finally {
      ctx.dispose();
    }
  });

  it("listByAgent filters sessions correctly", async () => {
    const ctx = createTestContext();
    try {
      // 创建两个 Agent
      await ctx.app.request("http://local/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "agent-x", name: "X", baseColor: blankBaseColor }),
      });
      await ctx.app.request("http://local/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "agent-y", name: "Y", baseColor: blankBaseColor }),
      });

      // 创建会话：一个无 Agent，一个绑定 agent-x，一个绑定 agent-y
      await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "无Agent", cwd: process.cwd() }),
      });
      await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "X会话", cwd: process.cwd(), agentId: "agent-x" }),
      });
      await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Y会话", cwd: process.cwd(), agentId: "agent-y" }),
      });

      // listByAgent("agent-x") 只返回 1 条
      const xRes = await ctx.app.request("http://local/api/agents/agent-x/sessions");
      expect(xRes.status).toBe(200);
      const xSessions = (await xRes.json()) as { title: string; agentId: string | null }[];
      expect(xSessions.length).toBe(1);
      expect(xSessions[0]!.title).toBe("X会话");
      expect(xSessions[0]!.agentId).toBe("agent-x");

      // listByAgent("agent-y") 只返回 1 条
      const yRes = await ctx.app.request("http://local/api/agents/agent-y/sessions");
      expect(yRes.status).toBe(200);
      const ySessions = (await yRes.json()) as { title: string; agentId: string | null }[];
      expect(ySessions.length).toBe(1);
      expect(ySessions[0]!.title).toBe("Y会话");
    } finally {
      ctx.dispose();
    }
  });

  it("restart recovery: can open agent-bound session after creating new SessionService instance", async () => {
    const ctx = createTestContext();
    try {
      // 先创建 Agent 和绑定会话
      await ctx.app.request("http://local/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "recover-me", name: "恢复测试", baseColor: blankBaseColor }),
      });

      const createRes = await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "恢复会话", cwd: process.cwd(), agentId: "recover-me" }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; sessionPath: string; agentId: string | null };
      expect(created.agentId).toBe("recover-me");
      const sessionId = created.id;
      const sessionPath = created.sessionPath;

      // 关闭当前 SessionService
      ctx.sessionService.closeAll();
      ctx.database.close();

      // 模拟重启：用同一 paths 创建新的 SessionService
      const db2 = openMetadataDatabase(ctx.paths.database);
      const index2 = new SessionIndex(db2);
      const service2 = new SessionService(ctx.paths, index2);

      try {
        // 应该能成功 open 绑定到 Agent 的会话
        const reopened = service2.open(sessionId);
        expect(reopened.id).toBe(sessionId);
        expect(reopened.path).toBe(sessionPath);
        expect(fs.existsSync(sessionPath)).toBe(true);
      } finally {
        service2.closeAll();
        db2.close();
      }
    } finally {
      ctx.dispose();
    }
  });

  it("restart recovery: agent session is visible in list after restart", async () => {
    const ctx = createTestContext();
    try {
      // 创建 Agent 和绑定会话
      await ctx.app.request("http://local/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "list-me", name: "列表恢复", baseColor: blankBaseColor }),
      });

      const createRes = await ctx.app.request("http://local/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "列表会话", cwd: process.cwd(), agentId: "list-me" }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string };

      // 关闭并重建
      ctx.sessionService.closeAll();
      ctx.database.close();

      const db2 = openMetadataDatabase(ctx.paths.database);
      const index2 = new SessionIndex(db2);
      const service2 = new SessionService(ctx.paths, index2);

      try {
        // 重启后列表仍可见
        const list = service2.list();
        expect(list.length).toBe(1);
        expect(list[0]!.id).toBe(created.id);

        // listByAgent 仍能过滤
        const byAgent = service2.listByAgent("list-me");
        expect(byAgent.length).toBe(1);
        expect(byAgent[0]!.id).toBe(created.id);
      } finally {
        service2.closeAll();
        db2.close();
      }
    } finally {
      ctx.dispose();
    }
  });

  it("prevents path traversal for session paths outside controlled roots", () => {
    const ctx = createTestContext();
    try {
      // 直接在 index 中插入一个越界路径来测试 assertSessionPath
      ctx.index.create({
        id: "00000000-0000-4000-8000-000000000099",
        title: "越界会话",
        sessionPath: path.join(os.tmpdir(), "outside.jsonl"),
        workspaceCwd: process.cwd(),
        agentId: null,
      });

      // open 应该被拒绝
      expect(() => ctx.sessionService.open("00000000-0000-4000-8000-000000000099")).toThrow(
        "Session 路径不在受控目录内",
      );
      // 清理
      ctx.index.remove("00000000-0000-4000-8000-000000000099");
    } finally {
      ctx.dispose();
    }
  });
});
