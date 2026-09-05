/**
 * A4c lane · Provider / settings / model 全功能回归（@a4c，L6 Electron 真链）。
 *
 * 覆盖矩阵行（L6 侧；SET-05 目标层为 L5，此处为真链佐证）：
 * - PROV-01 设置页新增/编辑 Provider → 凭据只入 AuthStorage（providers.json/auth.json 真值对照）
 * - PROV-02 凭据配置后 /api/models credentialConfigured 翻转 → 会话模型 chips 与设置页同源一致
 * - PROV-03 负例：非法 URL 客户端拦截；URL 内嵌凭据服务端 400；错误不泄露已提交秘密
 * - PROV-04 切全局默认模型 → preferences 真值 → 重启后新会话草稿采用；失效引用漂移有中文提示
 * - SET-05 关于页：版本（主进程桥上报）与连接信息（IPC 数据源 label ↔ serverUrl 真值）
 *
 * 真链路径与隔离边界同 smoke.truechain.spec.ts：隔离 OPENCOLORFUL_HOME + --user-data-dir
 * + 本地 stub Provider（fixtures 共享基建，本 lane 只新增 fixtures/lane-a4c/ 下文件）。
 */
import { expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./fixtures/backend.js";
import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/harness.js";
import { ProvidersPO } from "./fixtures/lane-a4c/providers-po.js";
import { SettingsPO } from "./fixtures/lane-a4c/settings-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

/* ---- 服务端真值的只读读取形状（对齐 src/pi-sdk/types.ts 与 routes/providers.ts） ---- */

interface ProviderWire {
  readonly providerId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly { readonly modelId: string; readonly name: string }[];
  readonly credentialConfigured: boolean;
}

interface ModelWire {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly credentialConfigured: boolean;
}

/** GET /api/models 兼容裸数组与 { models: [...] } 两种历史形状 */
function asModels(payload: unknown): ModelWire[] {
  const list = Array.isArray(payload) ? payload : (payload as { models?: unknown } | null)?.models;
  return Array.isArray(list) ? (list as ModelWire[]) : [];
}

/** 把全局默认模型固定到指定 Provider/模型（与冒烟/其他 lane 同法：模型确定性由 fixture 显式固定） */
async function pinDefaultModel(
  harness: { serverUrl: string },
  providerId: string,
  modelId: string,
): Promise<void> {
  const response = await fetch(`${harness.serverUrl}/api/settings/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaults: { model: { providerId, modelId } } }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok, `PUT preferences 应成功：${response.status}`).toBe(true);
}

test.describe("@a4c A4c Provider/settings/model 真链回归", () => {
  test("PROV-01+PROV-02: 设置页新增/编辑 Provider → 凭据入 AuthStorage → /api/models 翻转 → 会话 chips 与设置页一致", async ({ harness }) => {
    const runId = Date.now().toString(36);
    let currentApp: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      /* ---- 引导建助理（Provider A 指向本地 stub）---- */
      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(currentApp);
      const onboarding = new OnboardingPO(page);
      await onboarding.expectStepAssistantVisible();
      await onboarding.completeAllSteps({
        name: `oc-e2e-助理-${runId}`,
        apiKey: harness.fakeApiKey,
        baseUrl: harness.stubUrl,
        modelId: "oc-e2e-model-a",
      });

      /* ---- 基线真值：引导 Provider 已配置凭据；模型列表该项 credentialConfigured=true ---- */
      const providersBase = await harness.apiGet<ProviderWire[]>("/api/settings/providers");
      expect(providersBase, "引导后应恰好一个自定义 Provider").toHaveLength(1);
      expect(providersBase[0]!.credentialConfigured).toBe(true);
      await pinDefaultModel(harness, providersBase[0]!.providerId, "oc-e2e-model-a");
      const modelsBase = asModels(await harness.apiGet<unknown>("/api/models"));
      expect(modelsBase.find((model) => model.modelId === "oc-e2e-model-a")?.credentialConfigured).toBe(true);

      /* ---- 设置页：Provider 卡片 + 新增 Provider B（设置页写入口，PROV-01）---- */
      const settings = new SettingsPO(page);
      const providers = new ProvidersPO(page);
      await settings.open();
      await settings.switchCategory("模型与 Provider");
      await providers.expectCardVisible(harness.stubUrl, "已配置凭据");

      await providers.openAddForm();
      await providers.fillForm({
        providerId: "oc-e2e-prov-b",
        name: "oc-e2e-Provider-B",
        baseUrl: harness.stubUrl,
        modelId: "oc-e2e-model-b",
        apiKey: harness.fakeApiKey,
      });
      await providers.save();
      await providers.expectCardVisible("oc-e2e-Provider-B", "已配置凭据");
      await providers.expectFormHidden();

      // 红线（约定 §七）：Key 不回显——保存后 DOM 可见文本不含已提交秘密
      const bodyText = await page.locator("body").innerText();
      expect(bodyText, "UI 不得回显 API Key").not.toContain(harness.fakeApiKey);

      /* ---- 服务端真值：providers.json 不含 Key；auth.json 含 Key（凭据只入 AuthStorage）---- */
      const providersAfterAdd = await harness.apiGet<ProviderWire[]>("/api/settings/providers");
      expect(providersAfterAdd.map((provider) => provider.providerId).sort())
        .toEqual(["oc-e2e-prov-b", providersBase[0]!.providerId].sort());
      const providersJsonPath = path.join(harness.homeDir, "config", "providers.json");
      const providersJson = fs.readFileSync(providersJsonPath, "utf8");
      expect(providersJson, "providers.json 不得包含 API Key").not.toContain(harness.fakeApiKey);
      expect(providersJson).toContain("provider:oc-e2e-prov-b");
      const authJsonPath = path.join(harness.homeDir, "auth", "auth.json");
      expect(fs.existsSync(authJsonPath), "AuthStorage 应已建立").toBe(true);
      expect(fs.readFileSync(authJsonPath, "utf8"), "API Key 应存入 AuthStorage").toContain(harness.fakeApiKey);

      /* ---- PROV-02：凭据配置后 /api/models credentialConfigured 翻转 ---- */
      const modelsAfterAdd = asModels(await harness.apiGet<unknown>("/api/models"));
      expect(modelsAfterAdd.find((model) => model.modelId === "oc-e2e-model-b")?.credentialConfigured).toBe(true);

      /* ---- 编辑 Provider B（改名，不重填 Key）：预填不回显 + 凭据保持 ---- */
      await providers.startEdit("oc-e2e-Provider-B");
      await providers.expectApiKeyFieldEmpty();
      await providers.fillForm({ name: "oc-e2e-Provider-B2" });
      await providers.save();
      await providers.expectCardVisible("oc-e2e-Provider-B2", "已配置凭据");
      const providersAfterEdit = await harness.apiGet<ProviderWire[]>("/api/settings/providers");
      const editedB = providersAfterEdit.find((provider) => provider.providerId === "oc-e2e-prov-b");
      expect(editedB?.name).toBe("oc-e2e-Provider-B2");
      expect(editedB?.credentialConfigured, "不重填 Key 的编辑应保持凭据").toBe(true);

      /* ---- PROV-02 一致性视角：会话模型 chips == /api/models 中已配置凭据集合 ---- */
      await settings.close();
      const chip = page.getByRole("button", { name: "oc-e2e-model-a" });
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await chip.click();
      const menu = page.getByRole("menu", { name: "模型" });
      await expect(menu.getByText("oc-e2e-model-b")).toBeVisible({ timeout: 15_000 });
      const itemNames = await menu.locator("strong").allInnerTexts();
      const configuredNames = modelsAfterAdd
        .filter((model) => model.credentialConfigured)
        .map((model) => model.name);
      expect([...itemNames].sort(), "chips 菜单应与后端已配置凭据模型集合一致")
        .toEqual([...configuredNames].sort());
      await page.keyboard.press("Escape");
    } finally {
      if (currentApp !== null) {
        await closeApp(currentApp).catch(() => undefined);
      }
    }
  });

  test("PROV-03: 负例——非法 URL 客户端拦截；URL 内嵌凭据服务端 400；错误不泄露已提交秘密且后端不变", async ({ harness }) => {
    let currentApp: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(currentApp);
      const onboarding = new OnboardingPO(page);
      await onboarding.expectStepAssistantVisible();
      // 「稍后再说」退出引导：无助理空态仍可从侧栏进入设置
      await page.getByRole("button", { name: "稍后再说" }).click();
      await expect(page.getByRole("heading", { name: "还没有可用的助理" })).toBeVisible({ timeout: 30_000 });

      // 基线真值：无 Provider
      const providersPath = "/api/settings/providers";
      expect(await harness.apiGet<ProviderWire[]>(providersPath)).toHaveLength(0);

      const settings = new SettingsPO(page);
      const providers = new ProvidersPO(page);
      await settings.open();
      await settings.switchCategory("模型与 Provider");
      await expect(page.getByText("还没有 Provider，添加一个开始对话")).toBeVisible();

      /* ---- 负例 1：file:// URL → 客户端字段级拦截，请求不发出 ---- */
      await providers.openAddForm();
      await providers.fillForm({
        providerId: "oc-e2e-neg",
        name: "oc-e2e-负例",
        baseUrl: "file:///tmp/model",
        modelId: "oc-e2e-model-neg",
        apiKey: harness.fakeApiKey,
      });
      await providers.save();
      await expect(providers.saveError()).toContainText("Base URL 必须是 HTTP 或 HTTPS");
      expect(await harness.apiGet<ProviderWire[]>(providersPath), "非法输入不得写后端").toHaveLength(0);

      /* ---- 负例 2：URL 内嵌凭据（客户端放行、服务端 400）→ 错误不泄露秘密 ---- */
      await providers.fillForm({ baseUrl: "http://oc-e2e-user:oc-e2e-pass@127.0.0.1:9/v1" });
      await providers.save();
      const alert = providers.saveError();
      await expect(alert).toBeVisible();
      const alertText = await alert.innerText();
      expect(alertText, "保存错误应输出中文提示").toMatch(/[\u4e00-\u9fff]/);
      expect(alertText, "错误提示不得包含已提交 API Key").not.toContain(harness.fakeApiKey);
      expect(alertText, "错误提示不得回显 URL 内嵌凭据").not.toContain("oc-e2e-user:oc-e2e-pass");

      // 后端状态不变：无 Provider 落盘；凭据未写入 AuthStorage；providers.json 无残留
      expect(await harness.apiGet<ProviderWire[]>(providersPath)).toHaveLength(0);
      const authJsonPath = path.join(harness.homeDir, "auth", "auth.json");
      if (fs.existsSync(authJsonPath)) {
        expect(fs.readFileSync(authJsonPath, "utf8"), "被拒绝的凭据不得写入 AuthStorage")
          .not.toContain(harness.fakeApiKey);
      }
      const providersJsonPath = path.join(harness.homeDir, "config", "providers.json");
      if (fs.existsSync(providersJsonPath)) {
        expect(fs.readFileSync(providersJsonPath, "utf8")).not.toContain("oc-e2e-neg");
      }
    } finally {
      if (currentApp !== null) {
        await closeApp(currentApp).catch(() => undefined);
      }
    }
  });

  test("PROV-04: 切全局默认模型 → 偏好落盘 → 重启后新会话草稿采用；失效引用漂移有中文提示", async ({ harness }) => {
    const runId = Date.now().toString(36);
    let currentApp: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      /* ---- Phase 1：引导（Provider A）+ 设置页新增 Provider B + 切默认模型为 B ---- */
      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      let page = await firstWindow(currentApp);
      const onboarding = new OnboardingPO(page);
      await onboarding.expectStepAssistantVisible();
      await onboarding.completeAllSteps({
        name: `oc-e2e-助理-${runId}`,
        apiKey: harness.fakeApiKey,
        baseUrl: harness.stubUrl,
        modelId: "oc-e2e-model-a",
      });

      const settings = new SettingsPO(page);
      const providers = new ProvidersPO(page);
      await settings.open();
      await settings.switchCategory("模型与 Provider");
      await providers.openAddForm();
      await providers.fillForm({
        providerId: "oc-e2e-prov-b",
        name: "oc-e2e-Provider-B",
        baseUrl: harness.stubUrl,
        modelId: "oc-e2e-model-b",
        apiKey: harness.fakeApiKey,
      });
      await providers.save();
      await providers.expectCardVisible("oc-e2e-Provider-B", "已配置凭据");

      // 全局默认模型：初始「未设置」→ 切到 Provider B 的模型
      const expectedRef = JSON.stringify({ providerId: "oc-e2e-prov-b", modelId: "oc-e2e-model-b" });
      await expect(settings.defaultModelSelect()).toHaveValue("");
      await settings.selectDefaultModel("oc-e2e-model-b（oc-e2e-prov-b）");
      await expect(settings.defaultModelSelect()).toHaveValue(expectedRef);

      // 服务端真值：PUT /api/settings/preferences defaults.model 已落盘
      const prefs = await harness.apiGet<{ defaults: { model: { providerId: string; modelId: string } | null } }>(
        "/api/settings/preferences",
      );
      expect(prefs.defaults.model).toEqual({ providerId: "oc-e2e-prov-b", modelId: "oc-e2e-model-b" });

      // 现状语义（两档模型策略 A6 之前，仅记录）：偏好未设时草稿取首个已配置凭据模型，
      // 且偏好切换不覆盖已有草稿解析
      await expect(page.getByRole("button", { name: "oc-e2e-model-a" })).toBeVisible();
      await settings.close();

      /* ---- Phase 2：重启（同一 home + user-data）→ 新会话草稿缺省采用偏好模型 ---- */
      await closeApp(currentApp);
      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      page = await firstWindow(currentApp);
      // 无会话 → 草稿空态；草稿模型 chip = 偏好默认 B（显示名 = 模型 ID）
      await expect(page.getByRole("button", { name: "oc-e2e-model-b" })).toBeVisible({ timeout: 30_000 });

      // 重启后设置页下拉仍选中 B（偏好持久化）
      const settings2 = new SettingsPO(page);
      await settings2.open();
      await settings2.switchCategory("模型与 Provider");
      await expect(settings2.defaultModelSelect()).toHaveValue(expectedRef);
      await settings2.close();

      /* ---- Phase 3：漂移——偏好默认指向失效引用（外部改临时 home 的 preferences.json）→ 重启 ---- */
      await closeApp(currentApp);
      const prefsPath = path.join(harness.homeDir, "config", "preferences.json");
      const prefsDoc = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as { defaults: { model: unknown } };
      prefsDoc.defaults.model = { providerId: "oc-e2e-ghost", modelId: "ghost-model" };
      fs.writeFileSync(prefsPath, `${JSON.stringify(prefsDoc, null, 2)}\n`, "utf8");

      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      page = await firstWindow(currentApp);
      const settings3 = new SettingsPO(page);
      await settings3.open();
      await settings3.switchCategory("模型与 Provider");
      await expect(
        page.getByText("当前默认模型 oc-e2e-ghost/ghost-model 未配置凭据或已不在列表中。"),
      ).toBeVisible();
      // 失效引用不得作为已选项呈现
      const ghostRef = JSON.stringify({ providerId: "oc-e2e-ghost", modelId: "ghost-model" });
      await expect(settings3.defaultModelSelect()).not.toHaveValue(ghostRef);
      await settings3.close();
      // 草稿回退到首个已配置凭据模型（A/B 之一），不使用失效引用
      await expect(page.getByRole("button", { name: /oc-e2e-model-(a|b)/ })).toBeVisible({ timeout: 30_000 });
    } finally {
      if (currentApp !== null) {
        await closeApp(currentApp).catch(() => undefined);
      }
    }
  });

  test("SET-05: 关于页真链——版本来自主进程桥上报，连接信息与 serverUrl 真值一致", async ({ harness }) => {
    let currentApp: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(currentApp);
      await page.getByRole("button", { name: "稍后再说" }).click();
      await expect(page.getByRole("heading", { name: "还没有可用的助理" })).toBeVisible({ timeout: 30_000 });

      // 连接信息的真值来源：后端健康
      const health = await harness.apiGet<{ status?: string }>("/api/health");
      expect(health.status ?? "ok").toBeTruthy();

      const settings = new SettingsPO(page);
      await settings.open();
      await settings.switchCategory("关于");

      // 版本：dev（非 packaged）下主进程桥上报 app.getVersion()（= desktop/package.json version）
      const desktopPkg = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "desktop", "package.json"), "utf8"),
      ) as { version: string };
      await expect(
        page.getByText(`${desktopPkg.version} · Electron · React · Vite`),
        "关于页应显示主进程上报的应用版本",
      ).toBeVisible();

      // dev 模式更新区（unsupported 态文案）
      await expect(page.getByText("开发模式不提供更新检查")).toBeVisible();
      await expect(page.getByText("打包安装的正式版本支持应用内更新")).toBeVisible();

      // 连接信息：IPC 数据源 label「已连接 · <host:port>」与 fixture serverUrl 真值一致
      // （同一文本也出现在标题栏，限定在设置对话框内断言避免 strict 冲突）
      const aboutDialog = page.getByRole("dialog", { name: "设置" });
      const hostLabel = harness.serverUrl.replace("http://", "");
      await expect(aboutDialog.getByText(`已连接 · ${hostLabel}`)).toBeVisible();
      await expect(aboutDialog.getByText("已连接", { exact: true })).toBeVisible();

      await settings.close();
    } finally {
      if (currentApp !== null) {
        await closeApp(currentApp).catch(() => undefined);
      }
    }
  });
});
