import { test, expect, type Page } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

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

async function startProviderFixture(): Promise<number> {
  const fixture = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      fixtureCalls += 1;
      const isToolFollowUp = body.includes('"role":"tool"') || body.includes("tool_call_id");
      // SLOW 标记：每个 chunk 间延迟 500ms，方便 Abort 测试点击中断按钮
      const slow = body.includes("SLOW");
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!isToolFollowUp) {
        response.write(streamChunk({ role: "assistant" }));
        if (slow) await new Promise((r) => setTimeout(r, 500));
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
        if (slow) {
          response.write(streamChunk({ role: "assistant", content: "更多内容..." }));
          await new Promise((r) => setTimeout(r, 500));
          response.write(streamChunk({ role: "assistant", content: "还在生成..." }));
          await new Promise((r) => setTimeout(r, 500));
        }
        response.write(streamChunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  providerFixture = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", () => resolve()));
  return (fixture.address() as { port: number }).port;
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-e2e-web-"));
  workspace = path.join(tempHome, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "target.txt"), "E2E_WORKSPACE_CONTENT\n", "utf8");

  const paths = getRuntimePaths({ PERSON_AGENT_HOME: tempHome });
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
  // Windows Defender/SQLite 句柄偶尔会在进程退出后短暂滞留，不影响测试结果。
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
  const option = select.locator("option").filter({ hasText: "fixture-provider/fixture-model" });
  await expect(option).toBeAttached({ timeout: 15_000 });
  const value = await option.getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(value!);
}

test.describe("web workspace 真实浏览器验收", () => {
  test("首屏加载工作台，显示 Supervisor 状态", async ({ page }) => {
    await page.goto(baseUrl());
    await expect(page.getByTestId("connection-status")).toBeVisible({ timeout: 10_000 });
    // Agent 未启动 → 显示已停止 + 启动按钮
    await expect(page.getByTestId("connection-status")).toHaveText("已停止");
    await expect(page.getByRole("button", { name: "启动 Server" })).toBeVisible();
  });

  test("通过页面启动 Agent Server，状态变为已连接", async ({ page }) => {
    await page.goto(baseUrl());
    await page.getByRole("button", { name: "启动 Server" }).click();
    await expect(page.getByTestId("connection-status")).toHaveText("已连接", { timeout: 30_000 });
    await expect(page.getByTestId("agent-port")).toHaveText(`:${agentPort}`);
    // 停止与重启按钮可用
    await expect(page.getByRole("button", { name: "停止 Server" })).toBeVisible();
  });

  test("完整对话流程：Provider → Session → 模型 → Prompt → PI read 工具", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(baseUrl());

    await ensureFixtureProvider(page);

    // 通过页面创建 Session
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("会话标题").fill("E2E 验收会话");
    await page.getByLabel("工作目录").fill(workspace);
    await page.getByRole("button", { name: "创建" }).click();

    // 会话出现在列表并自动选中（标题在侧栏和聊天区各出现一次，取第一个）
    await expect(page.getByText("E2E 验收会话").first()).toBeVisible({ timeout: 10_000 });

    // 等待模型选项加载完成再选择（模型列表异步拉取）
    await selectFixtureModel(page);

    // 发送 Prompt
    await page.getByLabel("消息输入").fill("读取 target.txt");
    await page.getByRole("button", { name: "发送消息" }).click();

    // 流式消息与工具调用出现
    await expect(page.getByTestId("tool-call-call-read")).toBeVisible({ timeout: 30_000 });
    // 工具完成
    await expect(page.getByTestId("tool-call-call-read")).toContainText("完成", { timeout: 30_000 });
    // 最终消息包含工具结果内容
    const messageList = page.getByTestId("message-list");
    await expect(messageList).toContainText("E2E_WORKSPACE_CONTENT", { timeout: 30_000 });

    const timelineOrder = await messageList.locator(":scope > *").evaluateAll((elements) =>
      elements.map((element) => ({
        tool: element.getAttribute("data-testid"),
        text: element.textContent ?? "",
      })));
    const toolIndex = timelineOrder.findIndex((item) => item.tool === "tool-call-call-read");
    const finalAnswerIndex = timelineOrder.findIndex((item) => item.text.includes("读取完成"));
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(finalAnswerIndex).toBeGreaterThan(toolIndex);

    expect(fixtureCalls).toBeGreaterThanOrEqual(2);
  });

  test("普通 Prompt 完成后发送按钮恢复", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);

    // 创建新会话
    const uniqueTitle = `Abort 测试 ${Date.now()}`;
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("会话标题").fill(uniqueTitle);
    await page.getByLabel("工作目录").fill(workspace);
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByText(uniqueTitle).first()).toBeVisible({ timeout: 10_000 });

    // 等待模型选项加载完成再选择（模型列表异步拉取）
    await selectFixtureModel(page);
    await page.getByLabel("消息输入").fill("读取 target.txt");
    await page.getByRole("button", { name: "发送消息" }).click();

    // 普通 Prompt 必须能完整执行工具并恢复发送状态
    await expect(page.getByTestId("tool-call-call-read")).toContainText("完成", { timeout: 30_000 });
    await expect(page.getByTestId("message-list")).toContainText("E2E_WORKSPACE_CONTENT", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 15_000 });
  });

  test("Agent 停止后页面仍可访问并显示已停止", async ({ page }) => {
    await page.goto(baseUrl());
    const status = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
    if (status.agentServer.status === "online") {
      await page.getByRole("button", { name: "停止 Server" }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("已停止", { timeout: 30_000 });
    }
    // 页面仍在，启动按钮可用
    await expect(page.getByRole("button", { name: "启动 Server" })).toBeVisible();
    // 恢复在线供后续测试
    await page.getByRole("button", { name: "启动 Server" }).click();
    await expect(page.getByTestId("connection-status")).toHaveText("已连接", { timeout: 30_000 });
  });

  test("桌面宽度：左右栏独立折叠与全折叠聊天模式", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(baseUrl());

    const leftSidebar = page.getByRole("complementary", { name: "会话列表" });
    const rightSidebar = page.getByRole("complementary", { name: "详情面板" });

    // 初始两栏均展开
    await expect(leftSidebar).toBeVisible();
    await expect(rightSidebar).toBeVisible();

    // 独立收起左栏
    await page.getByRole("button", { name: "收起会话面板" }).click();
    await expect(leftSidebar).not.toBeVisible();
    await expect(rightSidebar).toBeVisible();

    // 恢复左栏
    await page.getByRole("button", { name: "展开会话面板" }).click();
    await expect(leftSidebar).toBeVisible();

    // 独立收起右栏
    await page.getByRole("button", { name: "收起详情面板" }).click();
    await expect(rightSidebar).not.toBeVisible();
    await expect(leftSidebar).toBeVisible();

    // 全折叠聊天模式
    await page.getByRole("button", { name: "收起会话面板" }).click();
    await expect(leftSidebar).not.toBeVisible();
    await expect(rightSidebar).not.toBeVisible();
    await expect(page.getByRole("main", { name: "聊天区域" })).toBeVisible();
  });

  test("窄屏宽度：首屏无重叠，抽屉互斥且带遮罩", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto(baseUrl());

    // 状态栏关键控件在窄屏下仍可见
    await expect(page.getByTestId("connection-status")).toBeVisible();

    // 首屏：两侧栏默认收起，聊天区域可见，无任何抽屉重叠
    await expect(page.getByRole("main", { name: "聊天区域" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "会话列表" })).not.toBeVisible();
    await expect(page.getByRole("complementary", { name: "详情面板" })).not.toBeVisible();

    // 展开左抽屉：出现遮罩，聊天区仍在底层
    await page.getByRole("button", { name: "展开会话面板" }).click();
    await expect(page.getByRole("complementary", { name: "会话列表" })).toBeVisible();
    await expect(page.getByTestId("drawer-backdrop")).toBeVisible();

    // 打开右抽屉时左抽屉自动关闭（互斥）
    await page.getByRole("button", { name: "展开详情面板" }).click();
    await expect(page.getByRole("complementary", { name: "详情面板" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "会话列表" })).not.toBeVisible();

    // 点击遮罩未被抽屉覆盖的区域关闭抽屉（右抽屉占据右侧，点击左边缘）
    await page.getByTestId("drawer-backdrop").click({ position: { x: 10, y: 400 } });
    await expect(page.getByRole("complementary", { name: "详情面板" })).not.toBeVisible();
    await expect(page.getByRole("main", { name: "聊天区域" })).toBeVisible();
  });

  test("通过 Web 表单配置 Provider", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(baseUrl());

    const status = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
    if (status.agentServer.status !== "online") {
      await page.getByRole("button", { name: "启动 Server" }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("已连接", { timeout: 30_000 });
    }

    // 桌面宽度默认右栏已展开，无需点击；若已折叠则展开
    const rightToggle = page.getByRole("button", { name: /详情面板/ });
    const label = await rightToggle.getAttribute("aria-label");
    if (label?.includes("展开")) {
      await rightToggle.click();
    }

    // 切换到 Provider 页签
    await page.getByRole("button", { name: "Provider" }).click();
    await page.getByRole("button", { name: "Provider" }).click();

    // 打开添加表单
    await page.getByRole("button", { name: "+ 添加" }).click();

    // 填写表单
    await page.getByLabel("Provider ID").fill("form-provider");
    await page.getByLabel("名称").fill("Form Provider");
    await page.getByLabel("Base URL").fill(`http://127.0.0.1:${fixturePort}/v1`);
    await page.getByLabel("模型 ID").fill("form-model");
    await page.getByLabel("API Key").fill("form-key");

    // 保存
    await page.getByRole("button", { name: "保存 Provider" }).click();

    // 验证已配置凭据（fixture-provider 已存在，form-provider 新增后有两项）
    await expect(page.getByText("Form Provider")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("✓ 已配置凭据").first()).toBeVisible({ timeout: 5_000 });
  });

  test("真实 Abort：慢速流中点击中断，生成终止", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);

    // 新建会话
    const uniqueTitle = `Abort-SLOW-${Date.now()}`;
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("会话标题").fill(uniqueTitle);
    await page.getByLabel("工作目录").fill(workspace);
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByText(uniqueTitle).first()).toBeVisible({ timeout: 10_000 });

    // 选模型
    await selectFixtureModel(page);

    // 发送 SLOW 标记 Prompt
    await page.getByLabel("消息输入").fill("SLOW 读取 target.txt");
    await page.getByRole("button", { name: "发送消息" }).click();

    // 等待中断按钮出现
    await expect(page.getByRole("button", { name: "中断生成" })).toBeVisible({ timeout: 10_000 });

    // 点击中断
    await page.getByRole("button", { name: "中断生成" }).click();

    // 中断后发送按钮恢复
    await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 15_000 });
  });

  test("重启恢复：Agent 重启后会话历史可续，继续对话成功", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);

    // 通过 UI 创建会话并发送一条 Prompt（建立历史）
    const uniqueTitle = `Restart-${Date.now()}`;
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("会话标题").fill(uniqueTitle);
    await page.getByLabel("工作目录").fill(workspace);
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByText(uniqueTitle).first()).toBeVisible({ timeout: 10_000 });

    await selectFixtureModel(page);
    await page.getByLabel("消息输入").fill("读取 target.txt");
    await page.getByRole("button", { name: "发送消息" }).click();

    // 等待流式完成
    await expect(page.getByTestId("message-list")).toContainText("E2E_WORKSPACE_CONTENT", { timeout: 30_000 });

    // 重启 Agent Server
    await page.getByRole("button", { name: "重启 Server" }).click();
    await expect(page.getByTestId("connection-status")).toHaveText("已连接", { timeout: 60_000 });

    // 重新选中会话 — 历史消息应包含之前的内容
    await page.getByText(uniqueTitle).first().click();
    // 等待 SSE 重连（事件流指示器变绿色）
    await expect(page.getByLabel("事件流已连接")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("message-list")).toContainText("读取", { timeout: 20_000 });

    // 继续对话
    await selectFixtureModel(page);
    await page.getByLabel("消息输入").fill("继续对话");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByTestId("message-list")).toContainText("读取完成", { timeout: 30_000 });
  });

  // Phase 4 验收

  test("桌面宽度：两侧折叠进入 Focus 模式且可再展开", async ({ page }) => {
    await page.goto(baseUrl());
    await page.setViewportSize({ width: 1440, height: 900 });

    // 折叠左侧
    await page.getByRole("button", { name: "折叠左侧栏" }).click();
    await expect(page.locator(".app-sidebar-left.collapsed")).toBeVisible();
    // 折叠右侧
    const toggleRight = page.getByRole("button", { name: "折叠右侧栏" });
    if (await toggleRight.isVisible()) await toggleRight.click();
    await expect(page.locator(".app-inspector.collapsed")).toBeVisible();
    // Focus 模式激活
    await expect(page.locator(".app-layout[data-focus-mode='true']")).toBeVisible();

    // 重新展开左侧
    await page.getByRole("button", { name: "展开左侧栏" }).click();
    await expect(page.locator(".app-layout[data-focus-mode='true']")).not.toBeVisible();
  });

  test("窄屏宽度：无横向溢出、抽屉正常打开和关闭", async ({ page }) => {
    await page.goto(baseUrl());
    await page.setViewportSize({ width: 390, height: 844 });

    // 窄屏首屏确认左右折叠，无横向溢出
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewport = page.viewportSize();
    expect(bodyWidth).toBeLessThanOrEqual(viewport!.width + 2);

    // 打开左侧抽屉
    await page.getByRole("button", { name: "展开左侧栏" }).click();
    await expect(page.locator(".app-sidebar-left")).toBeVisible();
    // 遮罩存在
    await expect(page.getByTestId("drawer-backdrop")).toBeVisible();

    // 点击遮罩关闭
    await page.getByTestId("drawer-backdrop").click();
    await expect(page.locator(".app-sidebar-left.collapsed")).toBeVisible();
  });

  test("进入 /settings 并导航 section，返回聊天保持会话", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(baseUrl());
    await ensureFixtureProvider(page);

    // 先创建会话建立状态
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("会话标题").fill(`Settings-${Date.now()}`);
    await page.getByLabel("工作目录").fill(workspace);
    await page.getByRole("button", { name: "创建" }).click();

    // 进入设置中心
    await page.getByRole("button", { name: "设置中心" }).click();
    await expect(page.locator("[data-page='settings']")).toBeVisible();

    // 导航到不同 section
    await page.getByTestId("settings-nav-defaults").click();
    await expect(page.getByTestId("settings-content")).toBeVisible();

    await page.getByTestId("settings-nav-layout").click();
    await expect(page.getByTestId("settings-content")).toBeVisible();

    await page.getByTestId("settings-nav-runtime").click();
    await expect(page.getByTestId("settings-content")).toBeVisible();

    // 返回聊天 — 会话仍然存在
    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("message-list")).toBeVisible();
  });
});
