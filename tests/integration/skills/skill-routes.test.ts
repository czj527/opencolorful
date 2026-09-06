import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServerApp } from "../../../src/server/app.js";
import type { SkillRef } from "../../../src/contracts/skill-protocol.js";
import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { cleanupT6Harnesses, createT6Harness, ingestManagedSkill, packSkillZip, type T6Harness } from "../../unit/skills/t6-harness.js";
import { createTrustedServerApp } from "../../fixtures/trusted-app.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 Skill Server API（plans/phase-13.md §14.1 / §18.5）
// - 成功与失败状态码；安装四态映射（201/202/403/400）；
// - 确认审批（200/404/409）；
// - 无正文安装输入、未登记 session-file 拒绝、任意绝对路径拒绝；
// - Agent/Session Skill 端点。
// ═══════════════════════════════════════════════════════════════

let harness: T6Harness;

afterEach(() => {
  cleanupT6Harnesses();
});

function setup(): { app: ReturnType<typeof createServerApp>["app"]; harness: T6Harness } {
  harness = createT6Harness();
  const { app } = createTrustedServerApp({ skillCoreService: harness.core });
  return { app, harness };
}

function jsonRequest(
  app: ReturnType<typeof createServerApp>["app"],
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`http://127.0.0.1${url}`, {
      method: options.method ?? "GET",
      ...(options.body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.body),
          }
        : {}),
    }),
  );
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function skillRefOf(harness: T6Harness, packageDir: string): SkillRef {
  const registered = harness.catalog.list({}).find((skill) => skill.sourceId === path.resolve(packageDir));
  if (registered === undefined) {
    throw new Error(`Skill 未登记：${packageDir}`);
  }
  return registered.skillRef;
}

describe("GET /api/skills 与详情", () => {
  it("列表返回空数组（无过滤参数）", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, "/api/skills");
    expect(response.status).toBe(200);
    const body = (await bodyOf(response)) as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it("未知 skillRefKey → 404", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, `/api/skills/${encodeURIComponent("unknown@source@1.0.0")}`);
    expect(response.status).toBe(404);
  });
});

describe("POST /api/skills/search / inspect", () => {
  it("search 返回结构化结果（含 remote 诊断）", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, "/api/skills/search", { method: "POST", body: { query: "x" } });
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(Array.isArray(body["hits"])).toBe(true);
    expect(body["remote"]).toMatchObject({ available: false });
  });

  it("search 非法参数 → 400", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, "/api/skills/search", { method: "POST", body: { query: 42 } });
    expect(response.status).toBe(400);
  });

  it("inspect 本地目录（kind=local）→ 200 结构化", async () => {
    const { app, harness } = setup();
    const dir = harness.makePackage("route-inspect", { name: "route-inspect-skill", version: "1.0.0" });
    const response = await jsonRequest(app, "/api/skills/inspect", {
      method: "POST",
      body: { sourceRef: path.resolve(dir), kind: "local" },
    });
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body["ok"]).toBe(true);
    expect((body["manifest"] as { name: string }).name).toBe("route-inspect-skill");
  });

  it("inspect 缺少 sourceRef/skillRef → 400；sourceRef 无 kind → 400（failed 结果）", async () => {
    const { app } = setup();
    const empty = await jsonRequest(app, "/api/skills/inspect", { method: "POST", body: {} });
    expect(empty.status).toBe(400);
    const noKind = await jsonRequest(app, "/api/skills/inspect", { method: "POST", body: { sourceRef: "/tmp/x" } });
    expect(noKind.status).toBe(400);
    const noKindBody = (await bodyOf(noKind)) as { details?: { reasonCode?: string } };
    expect(noKindBody.details?.reasonCode).toBe("skill_source_unsupported");
  });
});

describe("POST /api/skills/install（四态状态码；无正文安装输入）", () => {
  it("低风险可信本地目录 → 201 installed（结构化结果）", async () => {
    const { app, harness } = setup();
    const dir = harness.makePackage("route-install", { name: "route-install-skill", version: "1.0.0" });
    const response = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef: path.resolve(dir), kind: "local", agentId: "agent-1", sessionId: "session-1" },
    });
    expect(response.status).toBe(201);
    const body = await bodyOf(response);
    expect(body["status"]).toBe("installed");
    expect((body["skillRef"] as { skillId: string }).skillId).toBe("route-install-skill");
  });

  it("ask-always → 202 confirmation_required；approve → 带令牌 → 201", async () => {
    const { app, harness } = setup();
    harness.agentService.setLearningPolicy({
      agentId: "agent-1",
      policy: "ask-always",
      confirmed: true,
      actor: { kind: "user", id: "test" },
    });
    const dir = harness.makePackage("route-confirm", { name: "route-confirm-skill", version: "1.0.0" });
    const sourceRef = path.resolve(dir);
    const first = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef, kind: "local", agentId: "agent-1", sessionId: "session-1" },
    });
    expect(first.status).toBe(202);
    const firstBody = await bodyOf(first);
    expect(firstBody["status"]).toBe("confirmation_required");
    const token = (firstBody["confirmation"] as { token: string }).token;

    const approved = await jsonRequest(app, `/api/skills/confirmation/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      body: { agentId: "agent-1", sessionId: "session-1" },
    });
    expect(approved.status).toBe(200);

    const second = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef, kind: "local", confirmationToken: token, agentId: "agent-1", sessionId: "session-1" },
    });
    expect(second.status).toBe(201);
  });

  it("learningPolicy=disabled → 403 rejected + reasonCode", async () => {
    const { app, harness } = setup();
    harness.agentService.setLearningPolicy({
      agentId: "agent-1",
      policy: "disabled",
      confirmed: true,
      actor: { kind: "user", id: "test" },
    });
    const dir = harness.makePackage("route-disabled", { name: "route-disabled-skill", version: "1.0.0" });
    const response = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef: path.resolve(dir), kind: "local", agentId: "agent-1", sessionId: "session-1" },
    });
    expect(response.status).toBe(403);
    const body = (await bodyOf(response)) as { details?: { reasonCode?: string } };
    expect(body.details?.reasonCode).toBe("skill_agent_unauthorized");
  });

  it("无效包 → 400 failed + reasonCode", async () => {
    const { app, harness } = setup();
    const dir = path.join(harness.home, "route-bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "不是包", "utf8");
    const response = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef: dir, kind: "local", agentId: "agent-1", sessionId: "session-1" },
    });
    expect(response.status).toBe(400);
    const body = (await bodyOf(response)) as { details?: { reasonCode?: string } };
    expect(body.details?.reasonCode).toBe("skill_not_a_complete_package");
  });

  it("未登记 session-file → 400 failed skill_content_read_denied（不接受未登记引用）", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef: "sf-not-registered", kind: "session-file", sessionId: "session-1" },
    });
    expect(response.status).toBe(400);
    const body = (await bodyOf(response)) as { details?: { reasonCode?: string } };
    expect(body.details?.reasonCode).toBe("skill_content_read_denied");
  });

  it("已登记 session-file（.zip）→ 201 installed", async () => {
    const { app, harness } = setup();
    const dir = harness.makePackage("route-sf", { name: "route-sf-skill", version: "1.0.0" });
    const zipPath = packSkillZip(dir, path.join(harness.home, "uploads", "route-sf.zip"));
    const fileKey = harness.registerSessionZip(zipPath, "session-1");
    const response = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef: fileKey, kind: "session-file", sessionId: "session-1" },
    });
    expect(response.status).toBe(201);
  });

  it("非法参数（缺 kind）→ 400 不进入领域层", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef: "/tmp/x" },
    });
    expect(response.status).toBe(400);
  });
});

describe("确认审批端点", () => {
  it("未知令牌 → 404", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, `/api/skills/confirmation/${encodeURIComponent("ct-unknown")}/approve`, {
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(404);
  });

  it("过期令牌 → 409 + reasonCode=skill_confirmation_expired", async () => {
    const { app, harness } = setup();
    harness.agentService.setLearningPolicy({
      agentId: "agent-1",
      policy: "ask-always",
      confirmed: true,
      actor: { kind: "user", id: "test" },
    });
    const dir = harness.makePackage("route-expire", { name: "route-expire-skill", version: "1.0.0" });
    const first = await jsonRequest(app, "/api/skills/install", {
      method: "POST",
      body: { sourceRef: path.resolve(dir), kind: "local", agentId: "agent-1", sessionId: "session-1" },
    });
    const firstBody = await bodyOf(first);
    const token = (firstBody["confirmation"] as { token: string }).token;
    harness.advance(16 * 60 * 1000);
    const response = await jsonRequest(app, `/api/skills/confirmation/${encodeURIComponent(token)}/approve`, {
      method: "POST",
      body: { agentId: "agent-1", sessionId: "session-1" },
    });
    expect(response.status).toBe(409);
    const body = (await bodyOf(response)) as { details?: { reasonCode?: string } };
    expect(body.details?.reasonCode).toBe("skill_confirmation_expired");
  });
});

describe("Agent / Session Skill 端点", () => {
  it("GET /api/agents/:agentId/skills → 200 结构化视图", async () => {
    const { app, harness } = setup();
    const dir = harness.makePackage("route-agent", { name: "route-agent-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "route-agent-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    const response = await jsonRequest(app, "/api/agents/agent-1/skills");
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body["status"]).toBe("ok");
    const bindResponse = await jsonRequest(app, "/api/agents/agent-1/skills", {
      method: "PUT",
      body: { action: "bind", skillRef: ref },
    });
    expect(bindResponse.status).toBe(200);
    const bindBody = await bodyOf(bindResponse);
    expect(bindBody["status"]).toBe("ok");
  });

  it("PUT unbind 无确认 → 200 confirmation_required（结构内判定，不做领域修改）", async () => {
    const { app, harness } = setup();
    const dir = harness.makePackage("route-unbind", { name: "route-unbind-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "route-unbind-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);
    await jsonRequest(app, "/api/agents/agent-1/skills", { method: "PUT", body: { action: "bind", skillRef: ref } });
    const key = skillRefKey(ref);
    const response = await jsonRequest(app, "/api/agents/agent-1/skills", {
      method: "PUT",
      body: { action: "unbind", skillRefKey: key },
    });
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body["status"]).toBe("confirmation_required");
    expect(harness.agentService.getSkillsConfig("agent-1").directSkillRefs).toHaveLength(1);
  });

  it("GET/POST /api/sessions/:sessionId/skills（临时绑定）", async () => {
    const { app, harness } = setup();
    const dir = harness.makePackage("route-session", { name: "route-session-skill", version: "1.0.0" });
    ingestManagedSkill(harness, path.dirname(dir), { name: "route-session-skill", version: "1.0.0" });
    const ref = skillRefOf(harness, dir);

    const empty = await jsonRequest(app, "/api/sessions/session-9/skills");
    expect(empty.status).toBe(200);

    const bound = await jsonRequest(app, "/api/sessions/session-9/skills", {
      method: "POST",
      body: { skillRef: ref, ttlMs: 60_000 },
    });
    expect(bound.status).toBe(201);

    const view = await jsonRequest(app, "/api/sessions/session-9/skills");
    const viewBody = await bodyOf(view);
    expect((viewBody["active"] as unknown[]).length).toBe(1);
  });

  it("session 临时绑定非法参数 → 400", async () => {
    const { app } = setup();
    const response = await jsonRequest(app, "/api/sessions/session-9/skills", {
      method: "POST",
      body: { skillRef: { skillId: "x" } },
    });
    expect(response.status).toBe(400);
  });
});
