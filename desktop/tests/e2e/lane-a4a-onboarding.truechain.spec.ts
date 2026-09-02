/**
 * L6 真链 lane A4a · ONB-05（引导第 3 步「浏览…」目录选择）。
 *
 * 真链路径：渲染层 click → preload desktopShell.pickDirectory()（contextBridge）
 *   → IPC desktop:pick-directory → main 进程 dialog.showOpenDialog → 返回绝对路径/null → 输入框。
 * OS 原生对话框本体不可自动化，本 spec 在 main 进程内替换 dialog.showOpenDialog 的返回值
 * （选择/取消两态，fixtures/lane-a4a/stub-dialog.ts），其余链路全部真实。
 * 注：POST /api/directories/pick 是 Web 面路径；Desktop 产品走 preload IPC 桥（main.cjs:125）。
 *
 * 真值对照（只读）：完成后读 agents/<id>/settings.json 的 defaultCwd。
 */
import { expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/harness.js";
import { stubPickDialog } from "./fixtures/lane-a4a/stub-dialog.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

test.describe("@a4a ONB-05 目录选择真链", () => {
  test("ONB-05: 「浏览…」取消回退手输 → 选择落输入框 → 完成后 defaultCwd 落盘 settings.json", async ({ harness }) => {
    const runId = Date.now().toString(36);
    const agentName = `oc-e2e-浏览助理-${runId}`;
    const manualPath = "D:\\oc-e2e-manual-cwd";
    // 桩返回的目标目录：真实存在于临时 runRoot 内（不触碰用户目录）
    const pickedDir = path.join(harness.runRoot, "oc-e2e-picked-workspace");
    fs.mkdirSync(pickedDir, { recursive: true });

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);
      const onboarding = new OnboardingPO(page);
      await onboarding.expectStepAssistantVisible();

      // 第 1、2 步：名字 + 自定义 Provider 指向本地 stub（与冒烟同路径）
      await page.getByLabel("名字").fill(agentName);
      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("heading", { name: "接入模型" })).toBeVisible();
      await page.getByRole("radio", { name: /自定义/ }).click();
      await page.getByLabel("API Key").fill(harness.fakeApiKey);
      await page.getByText("高级设置（Base URL / 模型）").click();
      await page.getByLabel("Base URL").fill(harness.stubUrl);
      await page.getByLabel("模型 ID").fill("oc-e2e-model");
      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("heading", { name: "选一个工作目录" })).toBeVisible();

      const directoryInput = page.getByPlaceholder("例如 D:\\Projects\\notes");
      await directoryInput.fill(manualPath);

      /* ---- 取消分支：stub 返回 canceled → handler 返回 null → 输入框保留手输值 ---- */
      await stubPickDialog(app, { canceled: true, filePaths: [] });
      await page.getByRole("button", { name: "浏览…" }).click();
      await expect(directoryInput).toHaveValue(manualPath, { timeout: 15_000 });

      /* ---- 选择分支：stub 返回目标目录 → 真链 IPC 把路径带回输入框 ---- */
      await stubPickDialog(app, { canceled: false, filePaths: [pickedDir] });
      await page.getByRole("button", { name: "浏览…" }).click();
      await expect(directoryInput).toHaveValue(pickedDir, { timeout: 15_000 });

      /* ---- 完成引导 → defaultCwd 真值落盘 ---- */
      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("heading", { name: "它能做什么、不能做什么" })).toBeVisible();
      await page.getByRole("button", { name: "完成，开始对话" }).click();
      await onboarding.expectHidden(30_000);

      const agents = await harness.apiGet<Array<{ identity: { id: string; name: string } }>>("/api/agents");
      expect(agents, "引导后应恰好一个助理").toHaveLength(1);
      const agentId = agents[0]!.identity.id;
      const settingsPath = path.join(harness.homeDir, "agents", agentId, "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { defaultCwd?: string | null };
      expect(settings.defaultCwd, "defaultCwd 应等于目录选择返回的路径").toBe(pickedDir);

      // 会话设置真值：新建草稿尚未落库，services.json 的 defaultCwd 即是 ONB-05 的服务端事实
      expect(fs.existsSync(pickedDir), "桩目标目录应真实存在").toBe(true);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
