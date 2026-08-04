import { test, expect } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// Phase 12 T8 插件中心 E2E 冒烟。
// 启动模式参考 logs.spec.ts：真实 Supervisor + Web dist。
// 说明：Server 的 /api/plugins 路由由 T10/组合根接线，当前尚未存在——
// 本用例验证页面级降级（「插件服务未就绪」空态）与五视图 Tab、移动端无横向溢出。

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
  test("进入 /plugins：标题与五视图 Tab 可见，API 未接线时显示服务未就绪占位", async ({ page }) => {
    await page.goto(`${baseUrl()}/plugins`);

    await expect(page.locator("[data-page='plugins']")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("插件中心", { exact: true })).toBeVisible();

    for (const id of ["installed", "discover", "permissions", "development", "sources"]) {
      await expect(page.getByTestId(`plugins-tab-${id}`)).toBeVisible();
    }

    // Server /api/plugins 尚未接线：已安装视图应降级为「插件服务未就绪」而非崩溃
    await expect(page.getByText("插件服务未就绪")).toBeVisible({ timeout: 15_000 });
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
