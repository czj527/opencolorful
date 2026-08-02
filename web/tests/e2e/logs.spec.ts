import { test, expect, type Page } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// Phase 11 T7 /logs 工作页 E2E。
// 启动模式参考 workspace.spec.ts：真实 Supervisor + Agent Server（无 provider fixture——
// 日志页不依赖 Provider；Agent Server 启动即产生 system.started 活动事件）。
// 每测试自包含：各自确保 Agent Server 在线后进入 /logs，不依赖跨测试共享状态。

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../../src/cli/main.ts");
const WEB_DIST = path.resolve(import.meta.dirname, "../../dist");

let tempHome: string;
let supervisor: RunningSupervisor | null = null;
let supervisorPort: number;
let agentPort: number;

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

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-logs-"));
  fs.mkdirSync(path.join(tempHome, "workspace"), { recursive: true });

  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: tempHome });
  supervisorPort = await freePort();
  agentPort = await freePort();

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

/** 幂等：确保 Agent Server 在线（/api/observability/* 经 supervisor 代理到 Agent Server） */
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

test.describe("web /logs 日志工作页", () => {
  test("进入 /logs：活动 tab 显示 system.started 行且 health 徽标可见", async ({ page }) => {
    await ensureAgentServerViaApi(page);
    await page.goto(`${baseUrl()}/logs`);

    // 顶部 health 徽标：Agent Server 在线 → Epoch 徽标可见
    await expect(page.getByTestId("logs-health")).toContainText("Epoch", { timeout: 15_000 });

    // 活动 tab 默认激活，system.started 行可见（Agent Server 启动即产生）
    await expect(page.getByText("system.started", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // 过滤栏与实时跟随开关存在
    await expect(page.getByLabel("事件名过滤")).toBeVisible();
    await expect(page.getByLabel("实时跟随")).toBeVisible();
  });

  test("活动行点击打开详情面板并展示字段", async ({ page }) => {
    await ensureAgentServerViaApi(page);
    await page.goto(`${baseUrl()}/logs`);

    const row = page.getByTestId(/^activity-row-/).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    await expect(page.getByTestId("activity-detail")).toBeVisible();
    // 详情包含 actor 与 payload 区块
    await expect(page.getByTestId("activity-detail")).toContainText("Payload");
    await expect(page.getByTestId("activity-detail")).toContainText("traceId");
  });

  test("错误 tab：有错误分组或 empty 状态", async ({ page }) => {
    await ensureAgentServerViaApi(page);
    await page.goto(`${baseUrl()}/logs`);

    await page.getByTestId("logs-tab-errors").click();
    // 服务端可能尚无错误 → 允许 empty 状态；有分组则渲染表格
    const emptyState = page.getByText("暂无错误记录");
    const table = page.locator("table");
    await expect(emptyState.or(table).first()).toBeVisible({ timeout: 15_000 });
  });

  test("原始日志 tab：加载 tail 并显示行数与字节元信息", async ({ page }) => {
    await ensureAgentServerViaApi(page);
    await page.goto(`${baseUrl()}/logs`);

    await page.getByTestId("logs-tab-raw").click();
    await page.getByRole("button", { name: "加载" }).click();

    await expect(page.getByTestId("tail-meta")).toBeVisible({ timeout: 15_000 });
    const viewer = page.getByTestId("log-viewer");
    await expect(viewer).toBeVisible();
    // 元信息展示行数（API 只返回文件尾部，不整文件加载）
    await expect(page.getByTestId("tail-meta")).toContainText("行");
  });

  test("实时跟随开关：开启显示跟随中，关闭后无报错", async ({ page }) => {
    await ensureAgentServerViaApi(page);
    await page.goto(`${baseUrl()}/logs`);

    const toggle = page.getByLabel("实时跟随");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText(/跟随中/)).toBeVisible({ timeout: 15_000 });

    await toggle.click();
    await expect(page.getByText(/跟随中/)).not.toBeVisible();
    // 页面仍正常
    await expect(page.getByText("system.started", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  });

  test("从 Settings 日志 section 入口跳转到 /logs", async ({ page }) => {
    await ensureAgentServerViaApi(page);
    await page.goto(`${baseUrl()}/settings?section=logs`);

    await expect(page.getByTestId("settings-section-logs")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("open-logs-page").click();

    await expect(page.locator("[data-page='logs']")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("日志工作页")).toBeVisible();
  });

  test("移动端（390px）无横向溢出且六 tab 可横向滚动", async ({ page }) => {
    await ensureAgentServerViaApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl()}/logs`);

    // 六个 tab 全部渲染
    for (const id of ["activity", "errors", "audit", "performance", "raw", "export"]) {
      await expect(page.getByTestId(`logs-tab-${id}`)).toBeVisible();
    }
    // 页面无横向溢出
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewport = page.viewportSize();
    expect(bodyWidth).toBeLessThanOrEqual(viewport!.width + 2);
  });
});
