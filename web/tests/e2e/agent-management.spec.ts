import { test, expect, type Page } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// Phase 8 补充修正 E2E：Agent 管理列表、独立创建/编辑路由、模板交互、未保存保护、响应式布局。
// 复用 workspace.spec.ts 的 Supervisor + provider fixture 启动模式。

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

async function startProviderFixture(): Promise<number> {
  const fixture = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-p8",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "好的" }, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  providerFixture = fixture;
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", () => resolve()));
  return (fixture.address() as { port: number }).port;
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-e2e-am-"));
  workspace = path.join(tempHome, "workspace");
  fs.mkdirSync(workspace);

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

async function createAgentViaApi(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${baseUrl()}/api/agents`, {
    data: {
      name,
      baseColor: { persona: "测试", personality: ["测试"], replyStyle: "简洁", innerSetting: "" },
    },
  });
  expect(response.ok()).toBe(true);
  const agent = await response.json();
  return agent.identity.id as string;
}

test.describe("Phase 8 Agent 管理 UX", () => {

  test("a. Agent 管理列表：展示名称、会话数、工作目录，有新建按钮", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    const name = `AM-List-${Date.now()}`;
    await createAgentViaApi(page, name);

    await page.goto(`${baseUrl()}/settings?section=agents`);
    await expect(page.getByTestId("settings-section-agents")).toBeVisible({ timeout: 10_000 });

    // Agent 卡片出现在列表中
    await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });

    // 新建按钮存在
    await expect(page.getByRole("button", { name: "+ 新建 Agent" })).toBeVisible();
  });

  test("b. 新建按钮跳转到 /agents/new", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    await page.goto(`${baseUrl()}/settings?section=agents`);
    await expect(page.getByTestId("settings-section-agents")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "+ 新建 Agent" }).click();
    await expect(page).toHaveURL(/\/agents\/new/);
    await expect(page.getByText("新建 Agent")).toBeVisible({ timeout: 10_000 });
  });

  test("c. /agents/new 页面表单完整", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    await page.goto(`${baseUrl()}/agents/new`);
    await expect(page.getByText("新建 Agent")).toBeVisible({ timeout: 10_000 });

    // 所有必要 section 存在
    await expect(page.getByText("名称（必填）")).toBeVisible();
    await expect(page.getByText("选择底色起点")).toBeVisible();
    await expect(page.getByText("角色描述")).toBeVisible();
    await expect(page.getByText("性格特质")).toBeVisible();
    await expect(page.getByText("回复风格")).toBeVisible();
    await expect(page.getByText("内在设定")).toBeVisible();
    await expect(page.getByText("默认工作目录")).toBeVisible();

    // 操作栏按钮
    await expect(page.getByRole("button", { name: "取消" })).toBeVisible();
    await expect(page.getByRole("button", { name: "创建 Agent" })).toBeVisible();
  });

  test("d. 创建 Agent 成功后跳转回列表", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    await page.goto(`${baseUrl()}/agents/new`);
    await expect(page.getByText("新建 Agent")).toBeVisible({ timeout: 10_000 });

    const name = `AM-Create-${Date.now()}`;
    await page.getByLabel("名称").fill(name);

    // 点击创建
    await page.getByRole("button", { name: "创建 Agent" }).click();

    // 应跳转回 settings agents 页（URL 含 agents section）
    await expect(page).toHaveURL(/section=agents/, { timeout: 15_000 });

    // 新 Agent 出现在列表中
    await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });
  });

  test("d2. 创建成功后浏览器 Back 不重新打开已提交的创建表单", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    // 保留一个明确的前置历史页，再进入管理页和创建页。
    await page.goto(baseUrl());
    await page.goto(`${baseUrl()}/settings?section=agents`);
    await page.getByRole("button", { name: "+ 新建 Agent" }).click();

    const name = `AM-History-${Date.now()}`;
    await page.getByLabel("名称").fill(name);
    await page.getByRole("button", { name: "创建 Agent" }).click();
    await expect(page).toHaveURL(/section=agents/, { timeout: 15_000 });

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${baseUrl()}/?$`), { timeout: 10_000 });
    await expect(page.getByText("新建 Agent", { exact: true })).toHaveCount(0);
  });

  test("e. 点击已有 Agent 卡片跳转到编辑页", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    const name = `AM-Edit-${Date.now()}`;
    const id = await createAgentViaApi(page, name);

    await page.goto(`${baseUrl()}/settings?section=agents`);
    await expect(page.getByTestId("settings-section-agents")).toBeVisible({ timeout: 10_000 });

    // 点击卡片进入编辑
    const card = page.getByTestId(`agent-card-${id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    await expect(page).toHaveURL(new RegExp(`/agents/${id}`));
    await expect(page.getByText(`编辑 ${name}`)).toBeVisible({ timeout: 10_000 });
  });

  test("f. 编辑页无模板区，有保存按钮", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    const name = `AM-EditNoTpl-${Date.now()}`;
    const id = await createAgentViaApi(page, name);

    await page.goto(`${baseUrl()}/agents/${id}`);
    await expect(page.getByText(`编辑 ${name}`)).toBeVisible({ timeout: 10_000 });

    // 编辑页不应有模板选择区
    await expect(page.getByText("选择底色起点")).toHaveCount(0);

    // 应有保存更改按钮
    await expect(page.getByRole("button", { name: "保存更改" })).toBeVisible();
    // 应有返回按钮（使用 exact 避免匹配 header 的 "返回 Agent 管理" 箭头按钮）
    await expect(page.getByRole("button", { name: "返回", exact: true })).toBeVisible();
  });

  test("g. 编辑页修改名称后保存", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    const name = `AM-Orig-${Date.now()}`;
    const id = await createAgentViaApi(page, name);

    await page.goto(`${baseUrl()}/agents/${id}`);
    await expect(page.getByText(`编辑 ${name}`)).toBeVisible({ timeout: 10_000 });

    // 修改名称
    const newName = `${name}-Modified`;
    const nameInput = page.getByLabel("名称");
    await nameInput.fill(newName);

    // 保存
    await page.getByRole("button", { name: "保存更改" }).click();

    // 应显示已保存
    await expect(page.getByText("已保存")).toBeVisible({ timeout: 10_000 });

    // 标题也更新了
    await expect(page.getByText(`编辑 ${newName}`)).toBeVisible({ timeout: 5_000 });

    // API 验证
    const agent = await (await page.request.get(`${baseUrl()}/api/agents/${id}`)).json();
    expect(agent.identity.name).toBe(newName);
  });

  test("h. 编辑页未保存返回触发放弃确认", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    const name = `AM-Discard-${Date.now()}`;
    const id = await createAgentViaApi(page, name);

    // 模拟真实路径：设置页 → 点击卡片 → 进入编辑页
    await page.goto(baseUrl());
    await page.goto(`${baseUrl()}/settings?section=agents`);
    await expect(page.getByTestId("settings-section-agents")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`agent-card-${id}`).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}`));
    await expect(page.getByText(`编辑 ${name}`)).toBeVisible({ timeout: 10_000 });

    // 修改名称（制造 dirty state）
    await page.getByLabel("名称").fill(`${name}-changed`);

    // 点返回 → 应出现放弃确认弹窗（使用 exact 避免匹配 header 的箭头按钮）
    await page.getByRole("button", { name: "返回", exact: true }).click();

    // 确认弹窗出现
    await expect(page.getByText("放弃更改？")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("你有未保存的修改，离开后将丢失。")).toBeVisible();

    // 点"继续编辑" → 弹窗关闭，停留在编辑页
    await page.getByRole("button", { name: "继续编辑" }).click();
    await expect(page.getByText(`编辑 ${name}`)).toBeVisible({ timeout: 5_000 });

    // 再次返回 → 弹窗出现 → 点"放弃更改"
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByText("放弃更改？")).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: "放弃更改" }).click();

    // 应跳转到 settings agents
    await expect(page).toHaveURL(/section=agents/, { timeout: 10_000 });

    // 放弃后再 Back 应回到进入管理页前的工作台，不应重新进入编辑页或停在重复设置项。
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${baseUrl()}/?$`), { timeout: 10_000 });
    await expect(page.getByText(`编辑 ${name}`)).toHaveCount(0);
  });

  test("i. 桌面/窄屏 /agents/new 布局正确", async ({ page }) => {
    test.setTimeout(60_000);
    await ensureAgentServerViaApi(page);

    // 桌面 1280
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseUrl()}/agents/new`);
    await expect(page.getByText("新建 Agent")).toBeVisible({ timeout: 10_000 });

    // 确认关键元素可见
    await expect(page.getByText("选择底色起点")).toBeVisible();

    // 窄屏 390
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByText("新建 Agent")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("选择底色起点")).toBeVisible();

    // 无横向溢出
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
