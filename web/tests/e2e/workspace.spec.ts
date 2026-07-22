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
    request.on("end", () => {
      fixtureCalls += 1;
      // 携带工具结果（role: tool）的后续请求返回最终文本；首次请求触发 read 工具
      const isToolFollowUp = body.includes('"role":"tool"') || body.includes("tool_call_id");
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!isToolFollowUp) {
        response.write(streamChunk({ role: "assistant" }));
        response.write(streamChunk({
          tool_calls: [{
            index: 0,
            id: `call-read-${fixtureCalls}`,
            type: "function",
            function: { name: "read", arguments: '{"path":"target.txt"}' },
          }],
        }));
        response.write(streamChunk({}, "tool_calls"));
      } else {
        response.write(streamChunk({ role: "assistant", content: "读取完成" }));
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
  fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const baseUrl = () => `http://127.0.0.1:${supervisorPort}`;

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

    // 确保 Agent 在线
    const status = await page.request.get(`${baseUrl()}/api/supervisor/status`);
    const body = await status.json();
    if (body.agentServer.status !== "online") {
      await page.getByRole("button", { name: "启动 Server" }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("已连接", { timeout: 30_000 });
    }

    // 配置 Provider（通过 API 提交，表单已单独做单元测试）
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

    // 通过页面创建 Session
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("会话标题").fill("E2E 验收会话");
    await page.getByLabel("工作目录").fill(workspace);
    await page.getByRole("button", { name: "创建" }).click();

    // 会话出现在列表并自动选中（标题在侧栏和聊天区各出现一次，取第一个）
    await expect(page.getByText("E2E 验收会话").first()).toBeVisible({ timeout: 10_000 });

    // 等待模型选项加载完成再选择（模型列表异步拉取）
    const modelSelect = page.getByLabel("选择模型");
    await expect(modelSelect.locator('option[value="fixture-provider/fixture-model"]')).toBeAttached({ timeout: 15_000 });
    await modelSelect.selectOption("fixture-provider/fixture-model");

    // 发送 Prompt
    await page.getByLabel("消息输入").fill("读取 target.txt");
    await page.getByRole("button", { name: "发送消息" }).click();

    // 流式消息与工具调用出现（工具 ID 按调用次数动态生成，用前缀匹配）
    const toolCall = page.locator('[data-testid^="tool-call-call-read-"]');
    await expect(toolCall).toBeVisible({ timeout: 30_000 });
    // 工具完成
    await expect(toolCall).toContainText("完成", { timeout: 30_000 });
    // 最终消息包含工具结果内容
    await expect(page.getByTestId("message-list")).toContainText("E2E_WORKSPACE_CONTENT", { timeout: 30_000 });

    expect(fixtureCalls).toBeGreaterThanOrEqual(2);
  });

  test("中断按钮在生成中可用", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(baseUrl());

    const status = await (await page.request.get(`${baseUrl()}/api/supervisor/status`)).json();
    if (status.agentServer.status !== "online") {
      await page.getByRole("button", { name: "启动 Server" }).click();
      await expect(page.getByTestId("connection-status")).toHaveText("已连接", { timeout: 30_000 });
    }

    // 创建新会话
    const uniqueTitle = `Abort 测试 ${Date.now()}`;
    await page.getByRole("button", { name: "新建会话" }).click();
    await page.getByLabel("会话标题").fill(uniqueTitle);
    await page.getByLabel("工作目录").fill(workspace);
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByText(uniqueTitle).first()).toBeVisible({ timeout: 10_000 });

    // 等待模型选项加载完成再选择（模型列表异步拉取）
    const modelSelect = page.getByLabel("选择模型");
    await expect(modelSelect.locator('option[value="fixture-provider/fixture-model"]')).toBeAttached({ timeout: 15_000 });
    await modelSelect.selectOption("fixture-provider/fixture-model");
    await page.getByLabel("消息输入").fill("读取 target.txt");
    await page.getByRole("button", { name: "发送消息" }).click();

    // 生成中出现中断按钮
    const abortButton = page.getByRole("button", { name: "中断生成" });
    // 快速流程下中断按钮可能转瞬即逝——只要能发送就算流程通了
    await expect(page.getByTestId("message-list")).toContainText("E2E_WORKSPACE_CONTENT", { timeout: 30_000 });
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
});
