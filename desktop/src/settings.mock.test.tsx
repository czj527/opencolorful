/**
 * L5 · SET-01/02/03（设置页类目接线与外观/对话显示偏好）Mock 渲染层回归。
 * A4c lane 扩展：PROV-01/02/03/04（Provider 增改、凭据翻转、负例、全局默认模型）与
 * SET-05（关于页版本/连接信息）。
 * 生产 MockDataSource + local-prefs（localStorage）真实路径。
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
import { renderApp, type AppSession } from "../tests/fixtures/app-harness.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeComposerPO } from "../tests/fixtures/pages/composer.js";
import { makeSidebarPO } from "../tests/fixtures/pages/sidebar.js";
import { makeSettingsPO } from "../tests/fixtures/pages/settings.js";

/**
 * A4c lane：与 chat.mock.test.tsx 相同的注入通道——覆写 createDataSource 以注入
 * overrideSource 包装的生产 Mock（injected.current = null 时完全走原路径，
 * 不影响本文件既有 SET-01/02/03 用例）。
 */
const injected = vi.hoisted(() => ({ current: null as DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

it("SET-01: 设置页四类目全部接线——外观 / 模型与 Provider / 对话显示 / 关于，无死类目", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const settings = makeSettingsPO(app.user);
  try {
    await sidebar.openSettings();
    expect(settings.dialog()).toBeTruthy();
    for (const label of ["外观", "模型与 Provider", "对话显示", "关于"]) {
      expect(settings.categoryButton(label)).not.toBeNull();
    }

    // 外观：主题三态 + 减少动效
    await settings.switchCategory("外观");
    expect(within(settings.dialog()).getByRole("group", { name: "主题" })).toBeTruthy();
    expect(settings.toggle("减少动效")).toBeTruthy();

    // 模型与 Provider：默认模型（来自服务端偏好）+ Provider 列表（异步加载后断言）
    await settings.switchCategory("模型与 Provider");
    expect(await within(settings.dialog()).findByLabelText("全局默认模型")).toBeTruthy();
    expect(await within(settings.dialog()).findByText("DeepSeek 本地")).toBeTruthy();
    expect(within(settings.dialog()).getByText("Moonshot")).toBeTruthy();

    // 对话显示：事件显隐开关
    await settings.switchCategory("对话显示");
    expect(settings.toggle("显示思考事件")).toBeTruthy();
    expect(settings.toggle("显示工具调用")).toBeTruthy();

    // 关于：版本与连接信息（无更新桥 → dev）
    await settings.switchCategory("关于");
    expect(within(settings.dialog()).getByText("桌面端")).toBeTruthy();
    expect(within(settings.dialog()).getByText("dev")).toBeTruthy();
    expect(within(settings.dialog()).getByText("离线 · mock 数据")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("SET-02: 对话显示开关即时过滤时间线并持久化（重启后保持）", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const settings = makeSettingsPO(app.user);
  try {
    // 等时间线加载：默认选中首个会话（极简桌面原型），时间线含思考与工具调用事件
    await screen.findByText(/把桌面原型改成极简风格/);
    expect(screen.getByText("思考")).toBeTruthy();
    expect(screen.getByText("工具调用")).toBeTruthy();

    await sidebar.openSettings();
    await settings.switchCategory("对话显示");
    expect(settings.toggle("显示思考事件").getAttribute("aria-checked")).toBe("true");

    await app.user.click(settings.toggle("显示思考事件"));
    expect(settings.toggle("显示思考事件").getAttribute("aria-checked")).toBe("false");
    expect(JSON.parse(window.localStorage.getItem("ocf-desktop-local-prefs") ?? "{}")).toMatchObject({
      showThinking: false,
    });

    await settings.close();
    expect(screen.queryByText("思考")).toBeNull(); // 即时生效：时间线不再渲染思考事件
    expect(screen.getByText("工具调用")).toBeTruthy(); // 工具事件不受影响
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();

  // 重启保持：同一 localStorage 下全新渲染仍隐藏思考事件
  app.unmount();
  const second = await renderApp();
  try {
    await screen.findByText(/把桌面原型改成极简风格/); // 等时间线重新装配
    expect(screen.queryByText("思考")).toBeNull();
    expect(screen.getByText("工具调用")).toBeTruthy();
  } finally {
    second.consoleTracker.restore();
  }
  second.consoleTracker.expectNoErrors();
});

it("SET-03: 外观主题三态 + 减少动效写入 html data 属性并持久化", async () => {
  const app = await renderApp();
  const sidebar = makeSidebarPO(app.user);
  const settings = makeSettingsPO(app.user);
  try {
    await sidebar.openSettings();
    await settings.switchCategory("外观");

    await settings.setTheme("深色");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(window.localStorage.getItem("ocf-desktop-theme")).toBe("dark");

    await settings.setTheme("浅色");
    expect(document.documentElement.dataset["theme"]).toBe("light");

    await settings.setTheme("跟随系统");
    expect(window.localStorage.getItem("ocf-desktop-theme")).toBe("system");
    // matchMedia stub：prefers-color-scheme dark = false → 解析为浅色
    expect(document.documentElement.dataset["theme"]).toBe("light");

    await app.user.click(settings.toggle("减少动效"));
    expect(document.documentElement.dataset["reduceMotion"]).toBe("true");
    expect(JSON.parse(window.localStorage.getItem("ocf-desktop-local-prefs") ?? "{}")).toMatchObject({
      reduceMotion: true,
    });

    await app.user.click(settings.toggle("减少动效"));
    expect(document.documentElement.dataset["reduceMotion"]).toBeUndefined();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

/* ------------------------------------------------------------------ */
/* A4c lane（PROV/SET 主战场）：以下用例为 A4 波次 A4c lane 新增回归     */
/* ------------------------------------------------------------------ */

/** 假凭据：仅用于断言「不回显/不泄露」，不得出现在任何可见状态（约定 §七红线） */
const FAKE_KEY = "oc-e2e-l5-secret-key";

/** 打开设置弹窗并切到「模型与 Provider」类目 */
async function openModelsSettings(app: AppSession) {
  const sidebar = makeSidebarPO(app.user);
  const settings = makeSettingsPO(app.user);
  await sidebar.openSettings();
  await settings.switchCategory("模型与 Provider");
  return settings;
}

/** RTL 填表（user-event 真实键入路径：先清空再逐字输入） */
async function fillField(app: AppSession, scope: HTMLElement, label: RegExp | string, text: string) {
  const field = within(scope).getByLabelText(label) as HTMLInputElement;
  await app.user.clear(field);
  await app.user.type(field, text);
}

it("PROV-01: 设置页新增 Provider——列表出现新卡片与凭据徽标，API Key 不回显", async () => {
  const app = await renderApp();
  try {
    const settings = await openModelsSettings(app);
    const dialog = settings.dialog();
    // mock 基线：两个已配置（DeepSeek 本地 / Moonshot）+ 一个未配置（OpenAI）
    await within(dialog).findByText("DeepSeek 本地");
    expect(within(dialog).getByText("Moonshot")).toBeTruthy();
    expect(within(dialog).getByText("OpenAI")).toBeTruthy();

    await app.user.click(within(dialog).getByRole("button", { name: "+ 添加 Provider" }));
    // Base URL 用 happy-dom 原生 type=url 校验可接受的值（其内置正则拒绝回环 IP/个位数端口，
    // 真实 Chromium 无此限制），保证「点击保存」路径真实触发 React onSubmit。
    await fillField(app, dialog, /Provider ID/, "oc-lane-a4c");
    await fillField(app, dialog, /名称/, "A4c 测试源");
    await fillField(app, dialog, /Base URL/, "http://oc-e2e-stub.local/v1");
    await fillField(app, dialog, /模型 ID/, "oc-lane-model");
    await fillField(app, dialog, "API Key", FAKE_KEY);
    await app.user.click(within(dialog).getByRole("button", { name: "保存 Provider" }));

    // 保存成功：表单收起（含 Key 输入框），列表出现新卡片且凭据徽标为已配置
    await waitFor(() => expect(within(dialog).getByText("A4c 测试源")).toBeTruthy());
    const card = within(dialog).getByText("A4c 测试源").closest("li");
    expect(card?.textContent ?? "").toContain("已配置凭据");
    expect(within(dialog).queryByLabelText("API Key")).toBeNull();
    // 红线（约定 §七）：已提交的 Key 不得出现在任何可见状态
    expect(document.body.textContent ?? "").not.toContain(FAKE_KEY);
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("PROV-01: 编辑 Provider——预填不含 API Key（不回显），改名保存后凭据保持", async () => {
  const app = await renderApp();
  try {
    const settings = await openModelsSettings(app);
    const dialog = settings.dialog();
    await within(dialog).findByText("Moonshot");
    const moonshotCard = within(dialog).getByText("Moonshot").closest("li");
    expect(moonshotCard).toBeTruthy();
    await app.user.click(within(moonshotCard!).getByRole("button", { name: "编辑" }));

    // 编辑预填：首个模型回填表单；API Key 恒为空（凭据只入 AuthStorage，renderer 不回显）
    expect((within(dialog).getByLabelText(/Provider ID/) as HTMLInputElement).value).toBe("moonshot");
    expect((within(dialog).getByLabelText(/模型 ID/) as HTMLInputElement).value).toBe("kimi-k3");
    expect((within(dialog).getByLabelText("API Key") as HTMLInputElement).value).toBe("");

    // 仅改名保存（不重填 Key）：凭据保持已配置
    await fillField(app, dialog, /名称/, "Moonshot 改名");
    await app.user.click(within(dialog).getByRole("button", { name: "保存 Provider" }));
    await waitFor(() => expect(within(dialog).getByText("Moonshot 改名")).toBeTruthy());
    const card = within(dialog).getByText("Moonshot 改名").closest("li");
    expect(card?.textContent ?? "").toContain("已配置凭据");
    expect(document.body.textContent ?? "").not.toContain(FAKE_KEY);
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("PROV-03: 非法表单负例——内联中文错误、不提交 upsert、列表保持不变", async () => {
  const base = new MockDataSource();
  const upsertSpy = vi.fn(base.upsertProvider.bind(base));
  injected.current = overrideSource(base, {
    upsertProvider: (provider, apiKey) => {
      void upsertSpy(provider, apiKey);
      return base.upsertProvider(provider, apiKey);
    },
  });
  const app = await renderApp();
  try {
    const settings = await openModelsSettings(app);
    const dialog = settings.dialog();
    await within(dialog).findByText("DeepSeek 本地");
    await app.user.click(within(dialog).getByRole("button", { name: "+ 添加 Provider" }));
    const save = () => within(dialog).getByRole("button", { name: "保存 Provider" });

    // 空表单直接保存 → 必填中文错误（role=alert）
    await app.user.click(save());
    expect(within(dialog).getByText("Provider ID 不能为空")).toBeTruthy();
    expect(within(dialog).getByText("名称不能为空")).toBeTruthy();
    expect(within(dialog).getByText("Base URL 不能为空")).toBeTruthy();
    expect(within(dialog).getByText("模型 ID 不能为空")).toBeTruthy();

    // 非法 ID 字符 + maxTokens > contextWindow（URL 用 happy-dom 原生校验可接受的值，
    // 保证点击路径真实触发 React onSubmit）
    await fillField(app, dialog, /Provider ID/, "Bad_ID");
    await fillField(app, dialog, /名称/, "负例");
    await fillField(app, dialog, /Base URL/, "http://oc-e2e-stub.local/v1");
    await fillField(app, dialog, /模型 ID/, "m1");
    await fillField(app, dialog, /最大输出/, "999999");
    await app.user.click(save());
    expect(within(dialog).getByText("只能包含小写字母、数字、点、横线和下划线")).toBeTruthy();
    expect(within(dialog).getByText("最大输出不能大于上下文窗口")).toBeTruthy();

    // 非法 URL（file://，服务端同规则）：真实浏览器原生约束校验放行任意合法绝对 URL，
    // 由 React 校验拦截并内联报错；happy-dom 的 type=url 内置正则过严（拒绝非 http(s)
    // scheme），会先于 React 拦截提交，故此处直接派发 submit 事件驱动 React 校验
    // （等价于真实浏览器中通过原生校验后的后续路径）。
    await fillField(app, dialog, /Base URL/, "file:///tmp/model");
    fireEvent.submit(
      within(dialog).getByRole("button", { name: "保存 Provider" }).closest("form")!,
    );
    expect(within(dialog).getByText("Base URL 必须是 HTTP 或 HTTPS")).toBeTruthy();

    // 一次都未提交；列表仍为基线三张卡
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(dialog.querySelectorAll(".pv-card").length).toBe(3);
  } finally {
    injected.current = null;
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("PROV-02: 凭据缺失的模型不进选择器；配置凭据后翻转出现（会话 chips 与设置默认模型同步）", async () => {
  const app = await renderApp();
  try {
    // 基线：会话模型 chip 菜单只含已配置凭据模型；OpenAI/GPT-5.2（未配置）缺席
    const chip = await screen.findByRole("button", { name: "DeepSeek V3.2" });
    await app.user.click(chip);
    const menu = screen.getByRole("menu", { name: "模型" });
    expect(within(menu).getByText("DeepSeek V3.2")).toBeTruthy();
    expect(within(menu).getByText("Kimi K3")).toBeTruthy();
    expect(within(menu).queryByText("GPT-5.2")).toBeNull();
    await app.user.keyboard("{Escape}");

    // 设置页为未配置的 OpenAI 补填凭据
    const settings = await openModelsSettings(app);
    const dialog = settings.dialog();
    await within(dialog).findByText("OpenAI");
    const openaiCard = within(dialog).getByText("OpenAI").closest("li");
    expect(openaiCard).toBeTruthy();
    await app.user.click(within(openaiCard!).getByRole("button", { name: "编辑" }));
    await fillField(app, dialog, "API Key", FAKE_KEY);
    await app.user.click(within(dialog).getByRole("button", { name: "保存 Provider" }));
    await waitFor(() => {
      const card = within(dialog).getByText("OpenAI").closest("li");
      expect(card?.textContent ?? "").toContain("已配置凭据");
    });

    // 设置页默认模型下拉同步出现该模型（同一 models 来源）
    const select = (await within(dialog).findByLabelText("全局默认模型")) as HTMLSelectElement;
    await waitFor(() => {
      expect([...select.options].some((option) => option.textContent === "GPT-5.2（openai）")).toBe(true);
    });
    await settings.close();

    // 会话 chips 同步出现 GPT-5.2（credentialConfigured 翻转后进入可用列表）
    await app.user.click(screen.getByRole("button", { name: "DeepSeek V3.2" }));
    const menu2 = screen.getByRole("menu", { name: "模型" });
    await waitFor(() => expect(within(menu2).getByText("GPT-5.2")).toBeTruthy());
    expect(document.body.textContent ?? "").not.toContain(FAKE_KEY);
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("PROV-04: 设置页切全局默认模型——下拉反映新默认；新会话草稿缺省采用偏好模型（现状语义）", async () => {
  const app = await renderApp();
  try {
    // 启动即采偏好默认：草稿态模型 chip 显示偏好默认 moonshot/kimi-k3
    await makeSidebarPO(app.user).newThread();
    await screen.findByText("新会话为草稿：发送首条消息后才会出现在会话列表");
    await screen.findByRole("button", { name: "Kimi K3" });

    const settings = await openModelsSettings(app);
    const dialog = settings.dialog();
    const select = (await within(dialog).findByLabelText("全局默认模型")) as HTMLSelectElement;
    expect(select.value).toBe(JSON.stringify({ providerId: "moonshot", modelId: "kimi-k3" }));

    // 切换全局默认模型（下拉选项值 = ModelRef JSON，与后端 preferences 契约同形）
    await app.user.selectOptions(select, JSON.stringify({ providerId: "deepseek-local", modelId: "deepseek-v3.2" }));
    await waitFor(() => expect(select.value).toBe(JSON.stringify({ providerId: "deepseek-local", modelId: "deepseek-v3.2" })));

    // 现状语义（两档模型策略 A6 之前，仅记录）：已选草稿模型仍在列表时，偏好变化不覆盖当前选择
    await settings.close();
    expect(makeComposerPO(app.user).noModelChip()).toBeNull();
    expect(screen.getByRole("button", { name: "Kimi K3" })).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("PROV-04: 默认模型指向未配置凭据模型——设置页出现中文提示，草稿保持未选择", async () => {
  const base = new MockDataSource();
  injected.current = overrideSource(base, {
    getPreferences: () =>
      Promise.resolve({
        defaults: { model: { providerId: "openai", modelId: "gpt-5.2" }, thinkingLevel: "medium", toolMode: "read-only" },
      }),
  });
  const app = await renderApp();
  try {
    await makeSidebarPO(app.user).newThread();
    await screen.findByText("新会话为草稿：发送首条消息后才会出现在会话列表");
    // 偏好默认不可用（openai 未配置凭据）→ 不静默回退到首个已配置模型
    await screen.findByRole("button", { name: "选择模型" });

    const settings = await openModelsSettings(app);
    const dialog = settings.dialog();
    expect(
      await within(dialog).findByText("当前默认模型 openai/gpt-5.2 未配置凭据或已不在列表中。"),
    ).toBeTruthy();
  } finally {
    injected.current = null;
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
});

it("SET-05: 关于页——版本与连接信息（无桥 dev/离线 mock；有桥显示主进程版本与更新区）", async () => {
  // 阶段一：无更新桥（浏览器 dev 等价态）→ 版本显示 dev，数据源为 mock 离线
  const app = await renderApp();
  try {
    const sidebar = makeSidebarPO(app.user);
    const settings = makeSettingsPO(app.user);
    await sidebar.openSettings();
    await settings.switchCategory("关于");
    const dialog = settings.dialog();
    expect(within(dialog).getByText("桌面端")).toBeTruthy();
    expect(within(dialog).getByText("dev")).toBeTruthy();
    expect(within(dialog).getByText("离线 · mock 数据")).toBeTruthy();
    expect(within(dialog).getByText("未连接")).toBeTruthy();
  } finally {
    app.consoleTracker.restore();
  }
  app.consoleTracker.expectNoErrors();
  app.unmount();

  // 阶段二：注入与 preload 桥同形的 desktopUpdate stub → 版本来自主进程上报，渲染更新区
  const bridgeState: DesktopUpdateState = {
    status: "unsupported",
    currentVersion: "9.9.9-l5",
    newVersion: null,
    progressPercent: null,
    message: null,
    checkedAt: null,
  };
  Object.defineProperty(window, "desktopUpdate", {
    configurable: true,
    value: {
      getState: () => Promise.resolve(bridgeState),
      check: () => Promise.resolve(bridgeState),
      download: () => Promise.resolve(bridgeState),
      install: () => undefined,
      onStateChanged: () => () => undefined,
    },
  });
  const second = await renderApp();
  try {
    const sidebar = makeSidebarPO(second.user);
    const settings = makeSettingsPO(second.user);
    await sidebar.openSettings();
    await settings.switchCategory("关于");
    const dialog = settings.dialog();
    expect(within(dialog).getByText("9.9.9-l5 · Electron · React · Vite")).toBeTruthy();
    expect(within(dialog).getByText("开发模式不提供更新检查")).toBeTruthy();
    expect(within(dialog).getByText("打包安装的正式版本支持应用内更新")).toBeTruthy();
  } finally {
    Reflect.deleteProperty(window, "desktopUpdate");
    second.consoleTracker.restore();
  }
  second.consoleTracker.expectNoErrors();
});
