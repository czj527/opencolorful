import { test, expect } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// Phase 12 T8 插件中心 E2E 冒烟。
// 启动模式参考 logs.spec.ts：真实 Supervisor + Web dist。
// 说明：Server /api/plugins 已由 T10/组合根接线并返回 200；fresh 环境下无插件，
// 已安装视图应展示空态而非崩溃。本用例验证页面级渲染、五视图 Tab、移动端无横向溢出。

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
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-plugin-"));
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
  // startSupervisor 不自动启动 agent server；/api/plugins 需经 supervisor 代理到真实
  // agent server（含 Phase 12 插件路由）。startAgentServer 自带健康等待（HTTP 就绪）。
  await supervisor.controller.startAgentServer();
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

test.describe("web /plugins 插件中心", () => {
  test("进入 /plugins：标题与五视图 Tab 可见，/api/plugins 已接线时已安装视图展示空态", async ({ page }) => {
    await page.goto(`${baseUrl()}/plugins`);

    await expect(page.locator("[data-page='plugins']")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("插件中心", { exact: true })).toBeVisible();

    for (const id of ["installed", "discover", "permissions", "development", "sources"]) {
      await expect(page.getByTestId(`plugins-tab-${id}`)).toBeVisible();
    }

    // Server /api/plugins 已接线（返回 200）：fresh 环境无插件，应展示空态而非「服务未就绪」占位或崩溃。
    // 注：空态分支不渲染 data-testid="installed-view"（该 testid 仅在有插件时存在），
    // 直接断言空态文案即可证明列表加载成功且为空。
    await expect(page.getByText("暂无已安装插件")).toBeVisible({ timeout: 15_000 });
  });

  test("移动端（390px）无横向溢出且五个 Tab 可见", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl()}/plugins`);

    await expect(page.locator("[data-page='plugins']")).toBeVisible({ timeout: 15_000 });
    for (const id of ["installed", "discover", "permissions", "development", "sources"]) {
      await expect(page.getByTestId(`plugins-tab-${id}`)).toBeVisible();
    }

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewport = page.viewportSize();
    expect(bodyWidth).toBeLessThanOrEqual(viewport!.width + 2);
  });
});
