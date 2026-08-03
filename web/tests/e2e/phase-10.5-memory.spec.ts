import { test, expect, type Page } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import Database from "better-sqlite3";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// Phase 10.5 E2E：记忆页时间线 UI（事实双强度 + 事件显著度）、整理设置持久化、
// 后台整理状态流转（SSE memory.agent.*：已排队 → 正在整理往事 → 整理完成）与脱敏运行报告。
// 启动模式参考 phase8.spec.ts：真实 Supervisor + Agent Server + Provider fixture（faux，不发真实网络）。

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../../src/cli/main.ts");
const WEB_DIST = path.resolve(import.meta.dirname, "../../dist");

let tempHome: string;
let workspace: string;
let supervisor: RunningSupervisor | null = null;
let providerFixture: http.Server | null = null;
let supervisorPort: number;
let agentPort: number;
let fixturePort: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-p105",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

const defaultSettings = {
  enabled: true,
  utilityProviderId: null,
  utilityModel: null,
  deepDiveMode: "script",
  dailyRunTime: "03:00",
  minIdleMinutes: 30,
  weeklyReviewDay: 0,
  weeklyReviewTime: "03:30",
  turnsPerSummary: 10,
  injectBudgetChars: 2500,
  retentionThresholds: { mediumUp: 45, mediumDown: 35, permanentUp: 85 },
};

const MEMORY_AGENT_FINAL = JSON.stringify({
  kind: "final",
  report: { summary: "e2e 整理完成", issues: [] },
});

/**
 * faux Provider：仅在本机回环上应答，绝不访问真实网络。
 * - 流式请求（stream:true）→ SSE；非流式（utility 调用）→ JSON。
 * - 记忆 Agent 请求（system prompt 含“记忆整理者”）→ 直接 final 提案结果。
 */
async function startProviderFixture(): Promise<number> {
  const fixture = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      const stream = body.includes('"stream":true');
      const isMemoryAgent = body.includes("记忆整理者");
      const content = isMemoryAgent ? MEMORY_AGENT_FINAL : "e2e 普通回复";

      if (stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk({ role: "assistant" }));
        if (!isMemoryAgent) response.write(streamChunk({ content: "e2e 普通回复" }));
        else response.write(streamChunk({ content: MEMORY_AGENT_FINAL }));
        response.write(streamChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-p105",
        object: "chat.completion",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  providerFixture = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", () => resolve()));
  return (fixture.address() as { port: number }).port;
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-p105-"));
  workspace = path.join(tempHome, "workspace");
  fs.mkdirSync(workspace);

  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: tempHome });
  supervisorPort = await freePort();
  agentPort = await freePort();
  fixturePort = await startProviderFixture();

  supervisor = await startSupervisor({
    paths,
    supervisorPort,
    agentServerPort: agentPort,
    entryScript: CLI_ENTRY,
    webDistDir: WEB_DIST,
  });
});

test.afterAll(async () => {
  if (supervisor) {
    await supervisor.stop().catch(() => {});
  }
  if (providerFixture) {
    await new Promise<void>((resolve) => providerFixture!.close(() => resolve()));
  }
  const cleanupDeadline = Date.now() + 15_000;
  while (Date.now() < cleanupDeadline) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(`临时 E2E 目录仍被系统占用，稍后可清理：${tempHome}`);
});

const baseUrl = () => `http://127.0.0.1:${supervisorPort}`;

async function ensureAgentServerViaApi(page: Page): Promise<void> {
  const status = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
  if (status.agentServer.status === "online") return;
  const response = await page.request.post(`${baseUrl()}/api/supervisor/start`);
  expect(response.ok()).toBe(true);
  await expect.poll(async () => {
    const current = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
    return current.agentServer.status;
  }, { timeout: 30_000 }).toBe("online");
}

async function ensureFixtureProvider(page: Page): Promise<void> {
  await ensureAgentServerViaApi(page);
  const providerResponse = await page.request.put(`${baseUrl()}/api/settings/providers`, {
    data: {
      provider: {
        providerId: "fixture-provider",
        name: "Fixture Provider",
        protocol: "openai-completions",
        baseUrl: `http://127.0.0.1:${fixturePort}/v1`,
        models: [{
          modelId: "fixture-model",
          name: "Fixture Model",
          capabilities: { reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512 },
        }],
      },
      apiKey: "fixture-key",
    },
  });
  expect(providerResponse.ok()).toBe(true);
}

async function createAgentViaApi(page: Page): Promise<string> {
  const response = await page.request.post(`${baseUrl()}/api/agents`, {
    data: {
      name: `P105-记忆-${Date.now()}`,
      baseColor: {
        persona: "测试 Agent",
        personality: ["稳重"],
        replyStyle: "简洁",
        innerSetting: "测试 innerSetting",
      },
    },
  });
  expect(response.ok()).toBe(true);
  const agent = await response.json();
  return agent.identity.id as string;
}

/** 直接向临时 home 数据库预置一条事实 + 两个不同日期的回想（时间线双强度派生数据） */
function seedTimelineData(agentId: string): void {
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: tempHome });
  const db = new Database(paths.database);
  try {
    const result = db.prepare(`
      INSERT INTO memory_facts (agent_id, fact, search_text, tags, source, source_refs, retention_strength, activation_strength, confidence, status, created_at, updated_at)
      VALUES (?, 'e2e 时间线事实', 'e2e 时间线事实', '[]', 'agent_approved', '["session:s1"]', 60, 30, 0.9, 'active', '2026-07-30T10:00:00.000Z', '2026-07-30T10:00:00.000Z')
    `).run(agentId);
    const factId = String(result.lastInsertRowid);
    const insertRecall = db.prepare(`
      INSERT INTO memory_recalls (agent_id, session_id, recall_id, target_type, target_id, query_hash, layer, source_type, created_at)
      VALUES (?, 's1', ?, 'fact', ?, 'q', 'facts', 'memory_recall', ?)
    `);
    insertRecall.run(agentId, crypto.randomUUID(), factId, "2026-07-30T10:00:00.000Z");
    insertRecall.run(agentId, crypto.randomUUID(), factId, "2026-08-01T10:00:00.000Z");
  } finally {
    db.close();
  }
}

test.describe("Phase 10.5：记忆页时间线 / 整理设置 / 后台整理状态", () => {

  test("a. 记忆页渲染：编译记忆、强度时间线双分解、设置回显", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);
    const agentId = await createAgentViaApi(page);
    seedTimelineData(agentId);

    await page.goto(`${baseUrl()}/memory?agent=${encodeURIComponent(agentId)}`);
    await expect(page.getByText("记忆", { exact: true })).toBeVisible({ timeout: 15_000 });

    // 强度时间线：事实双强度（retention 60 / activation 30）+ 2 个回想日
    const strengthSection = page.getByLabel("时间线事实强度");
    await expect(page.getByText("强度时间线")).toBeVisible({ timeout: 15_000 });
    await expect(strengthSection.getByText("e2e 时间线事实")).toBeVisible();
    await expect(strengthSection.getByText("60")).toBeVisible();
    await expect(strengthSection.getByText("30")).toBeVisible();
    await expect(strengthSection.getByText("2 个回想日")).toBeVisible();

    // 整理设置表单回显全局默认
    const daily = page.getByLabel("每日整理时间");
    await expect(daily).toHaveValue("03:00", { timeout: 15_000 });
    await expect(page.getByLabel("记忆健康状态").getByText("空闲", { exact: true })).toBeVisible();
  });

  test("b. 整理设置保存：PUT 覆盖 per-agent 并持久化", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);
    const agentId = await createAgentViaApi(page);

    await page.goto(`${baseUrl()}/memory?agent=${encodeURIComponent(agentId)}`);
    const daily = page.getByLabel("每日整理时间");
    await expect(daily).toHaveValue("03:00", { timeout: 15_000 });

    await daily.fill("04:30");
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByText(/已保存/)).toBeVisible({ timeout: 10_000 });

    // 通过 API 验证持久化到该 Agent（不影响其他 Agent / 全局）
    const settings = await (await page.request.get(`${baseUrl()}/api/agents/${agentId}/memory/settings`)).json();
    expect(settings.settings.dailyRunTime).toBe("04:30");
  });

  test("c. 后台整理状态流转：立即整理 → 已排队 → 整理完成 + 脱敏报告", async ({ page }) => {
    test.setTimeout(90_000);
    await ensureFixtureProvider(page);
    const agentId = await createAgentViaApi(page);
    // P0-2 验收：设置必须真实生效——显式开启 experimental-agent（默认 script 不调用 LLM）
    const settingsResponse = await page.request.put(`${baseUrl()}/api/agents/${agentId}/memory/settings`, {
      data: { ...defaultSettings, deepDiveMode: "experimental-agent" },
    });
    expect(settingsResponse.ok()).toBe(true);

    await page.goto(`${baseUrl()}/memory?agent=${encodeURIComponent(agentId)}`);
    await expect(page.getByLabel("记忆健康状态").getByText("空闲", { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /立即整理/ }).click();
    // 手动整理可能瞬时完成（faux provider 立即应答）：容忍 已排队/整理中/整理完成 任一中间态。
    // 定位器作用域限定「后台整理控制」region + exact 匹配，避免命中说明段落触发 strict mode。
    const maintenance = page.getByLabel("后台整理控制");
    const queued = maintenance.getByText("已排队", { exact: true });
    const started = maintenance.getByText("正在整理往事", { exact: true });
    const done = maintenance.getByText("整理完成", { exact: true });
    await expect(queued.or(started).or(done)).toBeVisible({ timeout: 10_000 });
    // SSE memory.agent.*：终态 整理完成（中间态文案映射由单测覆盖；faux provider 瞬时应答，
    // 中间态可能一闪而过，不作独立断言避免竞态）
    await expect(done).toBeVisible({ timeout: 30_000 });

    // completed 后自动拉取脱敏运行报告（REPORT.md：状态/提案/未解决问题，不含原文）
    const reportSummary = page.getByText("最近运行报告（脱敏）");
    await expect(reportSummary).toBeVisible({ timeout: 15_000 });
    await reportSummary.click();
    await expect(page.getByText(/状态：completed/)).toBeVisible();

    // API：不存在的 run 返回 404
    const missing = await page.request.get(`${baseUrl()}/api/agents/${agentId}/memory/runs/run-nope`);
    expect(missing.status()).toBe(404);
  });

  test("d. timeline API：事实双强度与 hitDates 派生、不落库", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);
    const agentId = await createAgentViaApi(page);
    seedTimelineData(agentId);

    const timeline = await (await page.request.get(`${baseUrl()}/api/agents/${agentId}/memory/timeline`)).json();
    const fact = timeline.facts.find((f: { fact: string }) => f.fact === "e2e 时间线事实");
    expect(fact).toBeDefined();
    expect(fact.retentionStrength).toBe(60);
    expect(fact.activationStrength).toBe(30);
    expect(fact.hitDates).toBe(2);
    expect(fact.validUntil).toBeNull();
  });
});
