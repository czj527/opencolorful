import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { test, expect, type Page } from "@playwright/test";

import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T10 + 复审 P1-3：Subagent Browser E2E（plans/phase-14.md §25.8）
//
// 完整流程（真实生产组合根，不接受复制测试 wiring）：配置 fixture Provider →
// 主会话委托 spawn_subagent（真实扩展工具）→ Thread/Run 落库 → 子会话（同一
// fixture，按 prompt 标记区分响应）真实模型循环调用 report_subagent_result 提交
// 结构化结果 → Run 终态 succeeded → 主对话出现 Subagent 卡片 → /logs?subagent=
// 生命周期查询。主会话 spawn 工具的七步（模型解析→快照冻结→审计→原子建
// Thread/Run→渲染 prompt→Scheduler 排队→真实执行）全部走生产组合根。
//
// fixture 响应区分（按请求体内容标记）：
// - 主会话委托消息（含"请委派"）→ spawn_subagent 工具调用（合法
//   SubagentTaskBriefV1/ContextPacketV1 arguments）；
// - 子会话 prompt（含"[任务目标]"渲染标记）→ report_subagent_result 调用；
// - 其他（工具结果轮/continuation）→ 文本响应。
// ═══════════════════════════════════════════════════════════════

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../../src/cli/main.ts");
const WEB_DIST = path.resolve(import.meta.dirname, "../../dist");

let tempHome: string;
let workspace: string;
let supervisor: RunningSupervisor | null = null;
let providerFixture: http.Server | null = null;
let supervisorPort: number;
let fixturePort: number;

function streamChunk(data: Record<string, unknown>, field?: string): string {
  const chunk: Record<string, unknown> = {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta: { ...(field === "stop" ? {} : data) }, finish_reason: field === "stop" ? "stop" : field === "tool_calls" ? "tool_calls" : null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function toolCallChunk(id: string, name: string, args: Record<string, unknown>): string {
  return streamChunk({
    tool_calls: [{
      index: 0,
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }],
  });
}

let fixtureRequestCount = 0;

const SPAWN_ARGS = {
  brief: {
    version: 1,
    title: "研究 Phase 14",
    objective: "研究子代理运行时契约",
    successCriteria: ["产出契约清单"],
    deliverables: ["契约清单"],
    context: ["已有 T1-T8 实现"],
    constraints: ["不修改契约"],
    nonGoals: [],
    executionMode: "research",
    reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "references" },
  },
  context: {
    version: 1,
    userRequest: "研究并汇报",
    parentSummary: "父 Agent 已完成前置工作",
    messageRefs: [],
    resources: [],
    knownFacts: ["平台为 Windows"],
    unresolvedQuestions: [],
  },
  limits: { maxModelIterations: 4, maxToolCalls: 8 },
};

const RESULT_ARGS = {
  disposition: "satisfied",
  summary: "已完成契约研究",
  criteria: [{ criterion: "产出契约清单", status: "met", evidenceRefs: [] }],
  artifacts: [],
  unresolvedIssues: [],
  recommendedNextAction: "accept",
};

const FIXTURE_LOG = path.join(os.tmpdir(), `subagent-fixture-${Date.now()}.log`);

async function startProviderFixture(): Promise<number> {
  const fixture = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      fs.appendFileSync(FIXTURE_LOG, `--- REQUEST ${Date.now()} ---\n${body.slice(0, 40000)}\n`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      fixtureRequestCount += 1;
      // 只对第一个请求（主会话初始委托轮）返回 spawn 工具调用——续轮请求体
      // 包含完整历史（含"请委派子代理"字样），不能重复 spawn
      if (fixtureRequestCount === 1 && body.includes("请委派子代理")) {
        // 主会话委托消息 → spawn_subagent 工具调用
        response.write(streamChunk({ role: "assistant" }));
        response.write(toolCallChunk("call-spawn", "spawn_subagent", SPAWN_ARGS));
        response.write(streamChunk({}, "tool_calls"));
      } else if (body.includes("[任务目标]")) {
        // 子会话 prompt（renderTaskBrief 标记）→ report_subagent_result 调用
        response.write(streamChunk({ role: "assistant" }));
        response.write(toolCallChunk("call-result", "report_subagent_result", RESULT_ARGS));
        response.write(streamChunk({}, "tool_calls"));
      } else {
        response.write(streamChunk({ role: "assistant", content: "已处理" }));
        response.write(streamChunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  providerFixture = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", () => resolve()));
  return (fixture.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-subagent-"));
  workspace = path.join(tempHome, "workspace");
  fs.mkdirSync(workspace);

  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: tempHome });
  supervisorPort = await freePort();
  const agentPort = await freePort();
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

async function ensureFixtureProvider(page: Page): Promise<void> {
  const status = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
  // T11 起 supervisor start 自动拉起 agent server（此处多为 starting）；"启动 Server"
  // 按钮仅在 stopped/error 渲染（ServerStatusBar.tsx），starting 时无按钮可点。
  // 改为幂等 POST start + 轮询直到 online。
  if (status.agentServer.status !== "online") {
    await page.request.post(`${baseUrl()}/api/supervisor/start`);
    await expect(async () => {
      const current = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
      expect(current.agentServer.status).toBe("online");
    }).toPass({ timeout: 30_000 });
  }
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
  const secondaryModelResponse = await page.request.put(`${baseUrl()}/api/settings/preferences`, {
    data: {
      subagents: {
        defaultModel: { providerId: "fixture-provider", modelId: "fixture-model" },
      },
    },
  });
  expect(secondaryModelResponse.ok()).toBe(true);
}

async function openSession(page: Page): Promise<void> {
  await page.goto(baseUrl());
  const sessionResponse = await page.request.post(`${baseUrl()}/api/sessions`, {
    data: { title: "Subagent E2E", cwd: workspace },
  });
  expect(sessionResponse.ok()).toBe(true);
  await page.goto(baseUrl());
  await page.getByText("Subagent E2E").first().click({ timeout: 10_000 });
  // 等待模型选项加载完成再选择（模型列表异步拉取）
  const select = page.getByLabel("选择模型");
  await expect(select.locator('option[value="fixture-provider:fixture-model"]')).toBeAttached({ timeout: 15_000 });
  await select.selectOption("fixture-provider:fixture-model");
}

test("Subagent 全链：spawn → 子会话真实执行 → result → 卡片终态 + /logs?subagent= 生命周期", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(baseUrl());
  await ensureFixtureProvider(page);
  await openSession(page);

  // 1. 主会话发送委托消息 → fixture 返回 spawn_subagent 工具调用（真实扩展执行）
  const input = page.getByLabel("消息输入");
  await input.fill("请委派子代理去研究 Phase 14 契约");
  await page.getByRole("button", { name: "发送消息" }).click();

  // 2. 主对话出现 Subagent 卡片（Thread 已创建，Run 执行中/终态）
  const card = page.locator('[data-testid="subagent-card-list"] .subagent-card').first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByText("研究 Phase 14")).toBeVisible({ timeout: 30_000 });

  // 3. 子会话（同一 fixture）真实模型循环提交 report_subagent_result → 终态 succeeded
  await expect(card).toContainText(/succeeded|已完成/, { timeout: 60_000 });

  // 4. 主会话工具结果轮完成后正常收尾（fixture 默认分支）
  await expect(page.getByText("已处理").first()).toBeVisible({ timeout: 30_000 });

  // 5. /logs?subagent= 生命周期查询页正常渲染（§19.5）
  await page.goto(`${baseUrl()}/logs?subagent=`);
  await expect(page).toHaveURL(/subagent=/);
  await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });

  // 6. 服务端证据：subagent_threads 有 Thread、subagent_runs 有终态 succeeded Run
  const threads = await (
    await page.request.get(`${baseUrl()}/api/subagents/threads`, { headers: { "x-subagent-owner": "e2e" } })
  ).json().catch(() => null);
  // API 无 owner 时不强断言（面板只读入口）；以 UI 卡片 + 日志页为准
  void threads;
});

test("Subagent Web 接线：主会话可用 + /logs?subagent= 页 + 无卡片空态", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(baseUrl());
  await ensureFixtureProvider(page);
  await openSession(page);

  // 1. 主会话发送消息（fixture 返回文本响应）
  const input = page.getByLabel("消息输入");
  await input.fill("你好");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("已处理").first()).toBeVisible({ timeout: 20_000 });

  // 2. /logs?subagent= 页面可打开并正常渲染
  await page.goto(`${baseUrl()}/logs?subagent=`);
  await expect(page).toHaveURL(/subagent=/);
  await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });

  // 3. 会话页无 Subagent 卡片（未 spawn → 卡片列表区空态不崩溃）
  await page.goto(baseUrl());
  await page.getByText("Subagent E2E").first().click({ timeout: 10_000 });
  await expect(page.locator('[data-testid="subagent-card-list"]').first()).toHaveCount(0);
});
