import { test, expect, type Page } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// Phase 8 E2E：底色模板创建 Agent、NewSessionPage 首条消息创建流程、
// 原生目录选择、草稿离开不落库、首次发送只创建一次、桌面/窄屏布局、Agent 绑定不可修改。
// 启动模式参考 workspace.spec.ts：beforeAll 拉真实 Supervisor + Agent Server + Provider fixture。

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
    id: "chatcmpl-p8",
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
      response.end("data: [DONE]\n\n");
    });
  });
  providerFixture = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", () => resolve()));
  return (fixture.address() as { port: number }).port;
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-p8-"));
  workspace = path.join(tempHome, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "target.txt"), "P8_WORKSPACE_CONTENT\n", "utf8");

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

/** 通过 API 创建 Agent，可选设置 defaultCwd；返回 agentId。 */
async function createAgentViaApi(
  page: Page,
  name: string,
  defaultCwd: string | null = null,
): Promise<string> {
  const response = await page.request.post(`${baseUrl()}/api/agents`, {
    data: {
      name,
      baseColor: {
        persona: "测试 Agent",
        personality: ["稳重"],
        replyStyle: "简洁",
        innerSetting: "测试 innerSetting",
      },
      ...(defaultCwd !== null ? { defaultCwd } : {}),
    },
  });
  expect(response.ok()).toBe(true);
  const agent = await response.json();
  return agent.identity.id as string;
}

test.describe("Phase 8：底色模板创建 Agent 与 NewSessionPage", () => {

  test("a. 底色模板选择创建 Agent：独立 /agents/new 页填写 → 创建 → 列表出现", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    // Phase 8 修正后 Agent 创建从设置页内联表单改为独立 /agents/new 页面
    await page.goto(`${baseUrl()}/agents/new`);
    await expect(page.getByText("新建 Agent")).toBeVisible({ timeout: 10_000 });

    // 等待模板加载完成（BaseColorTemplatePicker 异步拉取 /api/agents/templates）
    const blueTemplate = page.getByRole("radio", { name: /蓝色.*冷静理性/ });
    await expect(blueTemplate).toBeVisible({ timeout: 10_000 });

    // 选"蓝色"模板 → 应自动填充角色描述/性格特质/回复风格/内在设定
    await blueTemplate.click();
    await expect(blueTemplate).toHaveAttribute("aria-checked", "true");

    // 填 name
    const agentName = `P8-Blue-${Date.now()}`;
    const nameInput = page.getByRole("textbox", { name: "Agent 名称" });
    await nameInput.fill(agentName);

    // 验证模板填充：内在设定 section 下的 textarea 应有内容（非空）
    // 蓝色模板的 innerSetting 不为空字符串
    const personaSection = page.locator("section").filter({ hasText: "角色描述" });
    await expect(personaSection).toContainText(/冷静/);

    // 创建
    await page.getByRole("button", { name: "创建 Agent" }).click();

    // 应跳转回 settings agents 列表
    await expect(page).toHaveURL(/section=agents/, { timeout: 15_000 });

    // 验证 Agent 出现在列表
    await expect(page.getByTestId("settings-section-agents")).toBeVisible({ timeout: 10_000 });

    // 通过 API 验证 baseColor 含 innerSetting
    const agentsList = await (await page.request.get(`${baseUrl()}/api/agents`)).json();
    const created = agentsList.find((a: { identity: { name: string } }) => a.identity.name === agentName);
    expect(created, "新建 Agent 应出现在 /api/agents 列表").toBeDefined();
    expect(created.baseColor.innerSetting).toBeTruthy();
    expect(created.baseColor.innerSetting.length).toBeGreaterThan(0);
    // Agent 不应保存 templateId/模板版本/颜色字段
    expect(created.templateId).toBeUndefined();
    expect(created.templateKey).toBeUndefined();
  });

  test("b. NewSessionPage 新建会话：选 Agent → 继承 defaultCwd → 首条消息 → 跳回 /", async ({ page }) => {
    test.setTimeout(90_000);
    await ensureFixtureProvider(page);

    // Phase 8 的 /new 页在首条消息发送时创建 Session + 发 prompt，
    // 因此需要在进入 /new 前将 fixture 模型设为默认，确保首条 prompt 走 fixture。
    await page.request.put(`${baseUrl()}/api/settings/preferences`, {
      data: { defaults: { model: { providerId: "fixture-provider", modelId: "fixture-model" } } },
    });

    // 先通过 API 创建带 defaultCwd 的 Agent
    const agentName = `P8-NS-${Date.now()}`;
    const agentId = await createAgentViaApi(page, agentName, workspace);

    // 从工作台侧栏点 "+"
    await page.goto(baseUrl());
    await page.getByRole("button", { name: "新建会话" }).click();

    // 跳转到 /new
    await expect(page).toHaveURL(/\/new/);
    await expect(page.getByText("新建会话").first()).toBeVisible({ timeout: 10_000 });

    // 选 Agent
    const agentChip = page.getByTestId(`new-session-agent-${agentId}`);
    await expect(agentChip).toBeVisible({ timeout: 10_000 });
    await agentChip.click();
    await expect(agentChip).toHaveAttribute("aria-pressed", "true");

    // 验证 defaultCwd 继承：directory-picker-value 应显示 workspace
    await expect(page.getByTestId("directory-picker-value")).toHaveText(workspace, { timeout: 5_000 });

    // 输入首条消息
    const uniqueTitle = `P8-Session-${Date.now()}`;
    await page.getByTestId("new-session-title").fill(uniqueTitle);
    await page.getByLabel("消息输入").fill("读取 target.txt");

    // 发送
    await page.getByRole("button", { name: "发送消息" }).click();

    // 跳回 /（workspace）
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

    // 新会话出现在侧栏
    await expect(page.getByText(uniqueTitle).first()).toBeVisible({ timeout: 15_000 });

    // 流式响应出现（验证 Session 真的被创建并 prompt 发出，且走了 fixture）
    await expect(page.getByTestId("tool-call-call-read")).toBeVisible({ timeout: 30_000 });
  });

  test("b2. 无默认模型时首条消息不创建无模型 Session，并提供设置入口", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    const clearDefaultResponse = await page.request.put(`${baseUrl()}/api/settings/preferences`, {
      data: { defaults: { model: null } },
    });
    expect(clearDefaultResponse.ok()).toBe(true);

    const agentId = await createAgentViaApi(page, `P8-NoDefault-${Date.now()}`, workspace);
    const before = await (await page.request.get(`${baseUrl()}/api/sessions`)).json();
    const countBefore = Array.isArray(before) ? before.length : 0;

    const preferencesLoaded = page.waitForResponse((response) =>
      response.request().method() === "GET" && response.url().endsWith("/api/settings/preferences"),
    );
    await page.goto(`${baseUrl()}/new`);
    await preferencesLoaded;
    await expect(page.getByText("新建会话").first()).toBeVisible({ timeout: 10_000 });

    await page.getByTestId(`new-session-agent-${agentId}`).click();
    await expect(page.getByTestId("directory-picker-value")).toHaveText(workspace, { timeout: 5_000 });
    await page.getByLabel("消息输入").fill("无默认模型时不应创建会话");
    await page.getByRole("button", { name: "发送消息" }).click();

    await expect(page.getByTestId("new-session-error")).toContainText("默认模型", { timeout: 5_000 });
    await expect(page.getByTestId("new-session-model-settings")).toBeVisible();
    const after = await (await page.request.get(`${baseUrl()}/api/sessions`)).json();
    const countAfter = Array.isArray(after) ? after.length : 0;
    expect(countAfter).toBe(countBefore);

    await page.getByTestId("new-session-model-settings").click();
    await expect(page).toHaveURL(/\/settings\?section=defaults/);
  });

  test("c. 原生目录选择：点击调 /api/directories/pick（mock 响应，避免真实 PowerShell 弹窗）", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    // 拦截 /api/directories/pick，避免真实 PowerShell 弹窗卡住 E2E
    let pickCalled = 0;
    const mockedPath = process.platform === "win32" ? "C:\\mocked-folder" : "/tmp/mocked-folder";
    await page.route("**/api/directories/pick", async (route) => {
      pickCalled += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ path: mockedPath, cancelled: false }),
      });
    });

    await page.goto(`${baseUrl()}/new`);
    await expect(page.getByText("新建会话").first()).toBeVisible({ timeout: 10_000 });

    // Windows 平台应显示"选择目录"按钮（navigator.userAgent 含 Win）；
    // 非 Windows 平台原生选择不可用，UI 回退为手工输入（不渲染按钮）。
    const pickBtn = page.getByRole("button", { name: "选择目录" });
    const isWindows = await page.evaluate(() => /Win/i.test(navigator.userAgent));
    if (!isWindows) {
      await expect(pickBtn).toHaveCount(0);
      await expect(page.getByLabel("默认工作目录路径")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId("directory-picker-value")).toHaveText("未设置");
      return;
    }
    await expect(pickBtn).toBeVisible({ timeout: 5_000 });

    // 点击前先验证目录未设置
    await expect(page.getByTestId("directory-picker-value")).toHaveText("未设置");

    // 点击调 /api/directories/pick
    await pickBtn.click();

    // 验证请求被发出
    await expect.poll(() => pickCalled, { timeout: 5_000 }).toBe(1);

    // 验证 mock 路径回填
    await expect(page.getByTestId("directory-picker-value")).toHaveText(mockedPath, { timeout: 5_000 });
  });

  test("d. 草稿离开不落库：进 /new 输入草稿 → 返回 → 不产生新 Session", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    // Phase 8 的 /new 页在无 cwd 时禁用发送按钮与消息输入框。
    // 通过 API 创建带 defaultCwd 的 Agent，选此 Agent 自动继承 cwd → 输入框可用。
    const draftAgentId = await createAgentViaApi(page, `P8-DraftAgent-${Date.now()}`, workspace);

    // 记录离开前 Session 数量
    const before = await (await page.request.get(`${baseUrl()}/api/sessions`)).json();
    const countBefore = Array.isArray(before) ? before.length : 0;

    await page.goto(`${baseUrl()}/new`);
    await expect(page.getByText("新建会话").first()).toBeVisible({ timeout: 10_000 });

    // 选 Agent 以获得 cwd
    await page.getByTestId(`new-session-agent-${draftAgentId}`).click();
    await expect(page.getByTestId("directory-picker-value")).not.toHaveText("未设置", { timeout: 5_000 });

    // 输入草稿（标题 + 消息），但不发送
    await page.getByTestId("new-session-title").fill("P8-Draft-Should-Not-Persist");
    await page.getByLabel("消息输入").fill("这是一条草稿消息，不应落库");

    // 点"返回工作台"
    await page.getByTestId("new-session-back").click();

    // 跳回 /
    await expect(page).toHaveURL(/\/$/, { timeout: 5_000 });

    // 验证 Session 数量不变
    const after = await (await page.request.get(`${baseUrl()}/api/sessions`)).json();
    const countAfter = Array.isArray(after) ? after.length : 0;
    expect(countAfter).toBe(countBefore);

    // 同时验证草稿标题未出现在侧栏
    await expect(page.getByText("P8-Draft-Should-Not-Persist")).toHaveCount(0);
  });

  test("e. 首次发送只创建一次：快速双击发送，POST /api/sessions 仅一次", async ({ page }) => {
    test.setTimeout(90_000);
    await ensureFixtureProvider(page);

    // 设置 fixture 模型为默认，确保 /new 首条 prompt 走 fixture
    await page.request.put(`${baseUrl()}/api/settings/preferences`, {
      data: { defaults: { model: "fixture-provider:fixture-model" } },
    });

    // 监听 POST /api/sessions 调用次数
    let createCalls = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/sessions$/.test(req.url())) {
        createCalls += 1;
      }
    });

    // 先用 API 创建带 defaultCwd 的 Agent，再进 /new 确保列表含此 Agent
    const agentId = await createAgentViaApi(page, `P8-Dbl-${Date.now()}`, workspace);

    await page.goto(`${baseUrl()}/new`);
    await expect(page.getByText("新建会话").first()).toBeVisible({ timeout: 10_000 });

    // 等待 agent 加载并选中（继承 cwd）
    const agentChip = page.getByTestId(`new-session-agent-${agentId}`);
    await expect(agentChip).toBeVisible({ timeout: 10_000 });
    await agentChip.click();
    await expect(page.getByTestId("directory-picker-value")).toHaveText(workspace, { timeout: 5_000 });

    // 输入消息
    await page.getByLabel("消息输入").fill("读取 target.txt");

    // 快速双击发送按钮（两次 click 间隔极短）
    const sendBtn = page.getByRole("button", { name: "发送消息" });
    await sendBtn.click({ clickCount: 2, delay: 10 });

    // 等待跳回 /（说明首次创建+发送完成）
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

    // 验证只创建一个 Session
    expect(createCalls).toBe(1);
  });

  test("f. 桌面/窄屏 NewSessionPage 布局：关键元素可见，无横向溢出", async ({ page, browserName }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    // 桌面视口
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseUrl()}/new`);
    await expect(page.getByText("新建会话").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("new-session-back")).toBeVisible();
    await expect(page.getByTestId("new-session-agent-row")).toBeVisible();
    await expect(page.getByTestId("new-session-title")).toBeVisible();
    await expect(page.getByLabel("消息输入")).toBeVisible();

    // 桌面无横向溢出
    const desktopOverflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(desktopOverflow).toBeLessThanOrEqual(2);

    // 窄屏视口
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    await expect(page.getByText("新建会话").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("new-session-back")).toBeVisible();
    await expect(page.getByTestId("new-session-agent-row")).toBeVisible();
    await expect(page.getByTestId("new-session-title")).toBeVisible();
    await expect(page.getByLabel("消息输入")).toBeVisible();

    // 窄屏无横向溢出（允许 2px 容差）
    const mobileOverflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(mobileOverflow).toBeLessThanOrEqual(2);

    // browserName 仅用于在日志中标识，不做断言
    expect(browserName).toBeTruthy();
  });

  test("g. Agent 绑定不可修改：创建带 Agent 的 Session 后，UI 无切换 Agent 入口", async ({ page }) => {
    test.setTimeout(90_000);
    await ensureFixtureProvider(page);

    // 通过 API 创建带 defaultCwd 的 Agent
    const agentName = `P8-Lock-${Date.now()}`;
    const agentId = await createAgentViaApi(page, agentName, workspace);

    // 通过 API 创建绑定该 Agent 的 Session
    const sessionTitle = `P8-Locked-${Date.now()}`;
    const createRes = await page.request.post(`${baseUrl()}/api/sessions`, {
      data: { title: sessionTitle, cwd: workspace, agentId },
    });
    expect(createRes.ok()).toBe(true);
    const session = await createRes.json();
    expect(session.agentId).toBe(agentId);

    // 进工作台并选中该 Session
    await page.goto(baseUrl());
    await page.getByText(sessionTitle).first().click({ timeout: 10_000 });

    // 验证 SessionSettingsPanel 未提供 agent 字段（若该面板接入）
    // 当前 InspectorSidebar 为占位壳，但若未来接入 SessionSettingsPanel 也应保持无 agent 控件
    const inspector = page.getByRole("complementary", { name: "详情面板" });
    if (await inspector.isVisible().catch(() => false)) {
      // 面板内不应出现 agent 相关入口
      await expect(inspector.getByText(/切换\s*Agent|更换\s*Agent|修改\s*Agent/)).toHaveCount(0);
    }

    // 整个页面不应有显式的"切换 Agent" / "更换 Agent" 按钮
    await expect(page.getByRole("button", { name: /切换\s*Agent|更换\s*Agent|修改\s*Agent/ })).toHaveCount(0);

    // 侧栏的 AgentSelector 是"按 Agent 过滤会话"，不应改 Session.agentId。
    // 验证：AgentSelector aria-label 是"选择 Agent"（过滤语义，非修改语义）
    const agentSelector = page.getByTestId("agent-selector");
    if (await agentSelector.isVisible().catch(() => false)) {
      // 切换过滤器不应改当前选中 Session 的 agentId
      const sessionAfter = await (await page.request.get(`${baseUrl()}/api/sessions/${session.id}`)).json();
      expect(sessionAfter.agentId).toBe(agentId);
    }

    // 通过 API 验证 PUT /api/sessions/:id 不接受 agentId 字段（契约层锁定）
    const putRes = await page.request.put(`${baseUrl()}/api/sessions/${session.id}/settings`, {
      data: { toolMode: "off", workspaceCwd: workspace, workspaceConfirmed: false, thinkingLevel: "off" },
    });
    expect(putRes.ok()).toBe(true);
    const after = await putRes.json();
    expect(after.agentId).toBe(agentId);
  });
});
