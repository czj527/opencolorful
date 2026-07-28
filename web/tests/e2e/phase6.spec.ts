import { test, expect, type Page } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// Phase 6 验收：会话命令系统、token 用量链路、对话时间线导航。
// fixture Provider 在最终 chunk 携带 usage，验证"事件 → 落库 → API → UI"全链路。

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../../src/cli/main.ts");
const WEB_DIST = path.resolve(import.meta.dirname, "../../dist");

let tempHome: string;
let workspace: string;
let supervisor: RunningSupervisor | null = null;
let providerFixture: http.Server | null = null;
let supervisorPort: number;
let agentPort: number;
let fixturePort: number;
let fixtureCalls = 0;

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
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function usageChunk(): string {
  // OpenAI stream_options.include_usage 约定的 usage-only chunk（choices 为空）
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  })}\n\n`;
}

async function startProviderFixture(): Promise<number> {
  const fixture = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      fixtureCalls += 1;
      const isToolFollowUp = body.includes('"role":"tool"') || body.includes("tool_call_id");
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!isToolFollowUp) {
        response.write(streamChunk({ role: "assistant" }));
        response.write(streamChunk({
          tool_calls: [{
            index: 0,
            id: "call-read",
            type: "function",
            function: { name: "read", arguments: '{"path":"target.txt"}' },
          }],
        }));
        response.write(streamChunk({}, "tool_calls"));
      } else {
        response.write(streamChunk({ role: "assistant", content: "读取完成" }));
        response.write(streamChunk({}, "stop"));
      }
      response.write(usageChunk());
      response.end("data: [DONE]\n\n");
    });
  });
  providerFixture = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", () => resolve()));
  return (fixture.address() as { port: number }).port;
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-p6-"));
  workspace = path.join(tempHome, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "target.txt"), "E2E_PHASE6_CONTENT\n", "utf8");

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

async function ensureFixtureProvider(page: Page): Promise<void> {
  const status = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
  if (status.agentServer.status !== "online") {
    await page.getByRole("button", { name: "启动 Server" }).click();
    await expect(page.getByTestId("connection-status")).toHaveText("已连接", { timeout: 30_000 });
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
}

async function selectFixtureModel(page: Page): Promise<void> {
  const select = page.getByLabel("选择模型");
  const value = "fixture-provider:fixture-model";
  await expect(select.locator(`option[value="${value}"]`)).toBeAttached({ timeout: 15_000 });
  await select.selectOption(value);
}

/**
 * 通过 API 创建 Session 并让 UI 选中。
 * Phase 8 起 Session 创建从弹窗改为 /new 独立单页（首条消息发送即创建），
 * 此 helper 绕过 UI 直接调 API 创建，与其他 E2E 文件保持一致。
 */
async function createSession(page: Page, title: string): Promise<void> {
  const response = await page.request.post(`${baseUrl()}/api/sessions`, {
    data: { title, cwd: workspace },
  });
  expect(response.ok()).toBe(true);
  // 刷新侧栏会话列表，再点击 title 选中
  await page.goto(baseUrl());
  await page.getByText(title).first().click({ timeout: 10_000 });
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
}

async function sendPrompt(page: Page, content: string): Promise<void> {
  await page.getByLabel("消息输入").fill(content);
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByTestId("message-list")).toContainText("E2E_PHASE6_CONTENT", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Phase 6：会话命令系统", () => {
  test("输入 / 弹出命令面板，/help 插入本地帮助卡片且不发送给 LLM", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);
    await createSession(page, `P6-CMD-${Date.now()}`);

    const callsBefore = fixtureCalls;

    // 首字符 / 弹出面板，包含全部五个命令
    const input = page.getByLabel("消息输入");
    await input.fill("/");
    const panel = page.getByTestId("command-panel");
    await expect(panel).toBeVisible();
    for (const name of ["help", "compact", "new", "abort", "clear"]) {
      await expect(page.getByTestId(`command-item-${name}`)).toBeVisible();
    }

    // 输入前缀实时过滤
    await input.fill("/he");
    await expect(page.getByTestId("command-item-help")).toBeVisible();
    await expect(page.getByTestId("command-item-compact")).not.toBeVisible();

    // Enter 执行 /help → 本地帮助卡片，输入框清空
    await input.press("Enter");
    await expect(panel).not.toBeVisible();
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("message-list")).toContainText("可用命令", { timeout: 5_000 });
    await expect(page.getByTestId("message-list")).toContainText("/compact — 压缩当前会话上下文");

    // 命令没有发给 LLM
    expect(fixtureCalls).toBe(callsBefore);
  });

  test("/compact 在无可压缩内容时插入失败提示卡片", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);
    await createSession(page, `P6-COMPACT-${Date.now()}`);

    const input = page.getByLabel("消息输入");
    await input.fill("/compact");
    await input.press("Enter");

    await expect(page.getByTestId("message-list")).toContainText("压缩", { timeout: 15_000 });
    await expect(page.locator("[data-testid^='command-card-'], [data-testid^='compaction-card-']").first())
      .toBeVisible({ timeout: 15_000 });
  });

  test("/abort 在无进行中生成时给出提示卡片", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);
    await createSession(page, `P6-ABORT-${Date.now()}`);

    const input = page.getByLabel("消息输入");
    await input.fill("/abort");
    await input.press("Enter");
    await expect(page.getByTestId("message-list")).toContainText("当前没有进行中的生成", { timeout: 5_000 });
  });
});

test.describe("Phase 6：Token 用量", () => {
  test("对话后显示本 turn 用量行与上下文圆环，悬停展示详情", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);
    await createSession(page, `P6-USAGE-${Date.now()}`);
    await selectFixtureModel(page);
    await sendPrompt(page, "读取 target.txt");

    // 本 turn 用量行出现在 assistant 卡片
    await expect(page.locator("[data-testid^='turn-usage-']").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-testid^='turn-usage-']").first()).toContainText("↑");
    await expect(page.locator("[data-testid^='turn-usage-']").first()).toContainText("↓");

    // 圆环存在，悬停弹出详情卡
    const ring = page.getByTestId("context-usage-ring");
    await expect(ring).toBeVisible();
    await ring.hover();
    const popover = page.getByTestId("context-ring-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("上下文");
    await expect(popover).toContainText("缓存命中率");
  });

  test("设置中心用量统计页展示对话后的聚合数据", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);
    await createSession(page, `P6-USAGE-SETTINGS-${Date.now()}`);
    await selectFixtureModel(page);
    await sendPrompt(page, "读取 target.txt");

    await page.goto(`${baseUrl()}/settings?section=usage`);
    const section = page.getByTestId("settings-section-usage");
    await expect(section).toBeVisible({ timeout: 10_000 });
    // 时间范围切换存在
    await expect(section.getByRole("button", { name: "7 天" })).toBeVisible();
    await expect(section.getByRole("button", { name: "90 天" })).toBeVisible();
    // 已有真实用量数据（不是空状态）
    await expect(section).toContainText("总 Tokens", { timeout: 10_000 });
    await expect(section).toContainText("加权平均缓存命中率");
    await expect(section).not.toContainText("暂无用量数据");
  });
});

test.describe("Phase 6：对话时间线导航", () => {
  test("多轮对话后出现时间线，点击节点定位并高亮，开关可隐藏", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);
    await createSession(page, `P6-TIMELINE-${Date.now()}`);
    await selectFixtureModel(page);

    await sendPrompt(page, "第一轮 读取 target.txt");
    // 第二轮：不依赖跨轮工具结果文本（历史工具块在 PROMPT_SENT 重置后不再渲染，属既有表现）
    await page.getByLabel("消息输入").fill("第二轮 读取 target.txt");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByTestId("message-list")).toContainText("第二轮", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 30_000 });

    // 时间线栏出现且至少两个轮次节点
    const nav = page.getByRole("navigation", { name: "对话时间线" });
    await expect(nav).toBeVisible({ timeout: 10_000 });
    const items = nav.locator("[data-testid^='timeline-node-']");
    await expect(items).toHaveCount(2, { timeout: 10_000 });

    // 点击第一个节点 → 目标锚点获得高亮闪烁类
    await items.first().click();
    await expect(page.locator(".anchor-highlight").first()).toBeAttached({ timeout: 5_000 });

    // 隐藏时间线 → 导航消失；再显示 → 恢复
    await page.getByRole("button", { name: "隐藏时间线" }).click();
    await expect(page.getByRole("navigation", { name: "对话时间线" })).not.toBeVisible();
    await page.getByRole("button", { name: "显示时间线" }).click();
    await expect(page.getByRole("navigation", { name: "对话时间线" })).toBeVisible();
  });
});
