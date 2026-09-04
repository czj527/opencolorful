/**
 * L5 · ONB（Onboarding 首启引导）Mock 渲染层回归。
 * 矩阵行：ONB-03（引导退出与重进）/ ONB-04（校验错误与模板失败兜底）。
 * A4a 追加：ONB-05 L5 侧（无 desktopShell 桥时「浏览…」静默 null 回退，不崩、不阻塞手输）。
 * ONB-03 需注入"无助理/无会话"状态（Mock fixture 注入表：empty），其余用生产 Mock。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { App } from "./App.js";
import { OnboardingPage } from "./components/OnboardingPage.js";
import { MockDataSource } from "./data/mock-source.js";
import type { DesktopDataSource } from "./data/source.js";
import { trackConsoleErrors } from "../tests/fixtures/console.js";
import { overrideSource } from "../tests/fixtures/override-source.js";
import { makeOnboardingPO } from "../tests/fixtures/pages/onboarding.js";

/* App 级注入：App 内部经 createDataSource() 建源，测试文件局部 mock 该模块以注入 fixture 状态 */
const injected = vi.hoisted(() => ({ current: null as DesktopDataSource | null }));
vi.mock("./data/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data/source.js")>();
  return {
    ...actual,
    createDataSource: () =>
      injected.current !== null ? Promise.resolve(injected.current) : actual.createDataSource(),
  };
});

/** 空态注入：无助理 + 无会话（首启派生 → first-run；退出后空态给出「开始引导」） */
function emptyWorkspaceSource(): DesktopDataSource {
  const base = new MockDataSource();
  return overrideSource(base, {
    listAgents: () => Promise.resolve([]),
    listThreads: () => Promise.resolve([]),
    listArchivedThreads: () => Promise.resolve([]),
  });
}

it("ONB-03: 引导中「稍后再说」退出到空态，可经「开始引导」重新进入", async () => {
  injected.current = emptyWorkspaceSource();
  const consoleTracker = trackConsoleErrors();
  const user = userEvent.setup();
  try {
    render(<App />);
    // 首启检测（无助理）→ 自动进入四步引导
    await screen.findByRole("heading", { name: "给你的助理起个名字" });
    await user.click(screen.getByRole("button", { name: "稍后再说" }));

    // 退出进空态（无助理 → 引导入口空态）
    const emptyHeading = await screen.findByRole("heading", { name: "还没有可用的助理" });
    expect(emptyHeading).toBeTruthy();

    // 空态可重进引导
    await user.click(screen.getByRole("button", { name: "开始引导" }));
    expect(screen.getByRole("heading", { name: "给你的助理起个名字" })).toBeTruthy();
  } finally {
    consoleTracker.restore();
    injected.current = null;
  }
  consoleTracker.expectNoErrors();
});

/* ---- ONB-04：组件级渲染，直接注入 source（校验错误不写后端） ---- */

function renderOnboarding(source: DesktopDataSource) {
  const consoleTracker = trackConsoleErrors();
  const user = userEvent.setup();
  const onExit = vi.fn();
  const completedAgentIds: string[] = [];
  const onComplete = vi.fn((agentId: string) => {
    completedAgentIds.push(agentId);
  });
  render(<OnboardingPage source={source} onExit={onExit} onComplete={onComplete} />);
  return { po: makeOnboardingPO(user), user, onExit, completedAgentIds, consoleTracker };
}

it("ONB-04: 第 1 步空名点下一步 → 内联中文错误（role=alert）且不推进", async () => {
  const t = renderOnboarding(new MockDataSource());
  try {
    await t.po.next();
    expect(t.po.errorText()).toBe("先给助理起个名字");
    expect(screen.getByRole("heading", { name: "给你的助理起个名字" })).toBeTruthy();
    expect(t.po.stepIsCurrent("创建助理")).toBe(true);

    await t.po.typeName("小澄");
    await t.po.next();
    expect(screen.getByRole("heading", { name: "接入模型" })).toBeTruthy();
    expect(t.po.stepIsCurrent("配置模型")).toBe(true);
  } finally {
    t.consoleTracker.restore();
  }
  t.consoleTracker.expectNoErrors();
});

it("ONB-04: 第 2 步空 Key / 非法 URL 被拦，校验失败期间不调用 upsertProvider", async () => {
  const base = new MockDataSource();
  const upsertCalls: string[] = [];
  const source = overrideSource(base, {
    upsertProvider: (input, apiKey) => {
      upsertCalls.push(input.providerId);
      void apiKey;
      return base.upsertProvider(input, apiKey);
    },
  });
  const t = renderOnboarding(source);
  try {
    await t.po.typeName("小澄");
    await t.po.next();
    expect(screen.getByRole("heading", { name: "接入模型" })).toBeTruthy();

    // 空 Key
    await t.po.next();
    expect(t.po.errorText()).toBe("请粘贴 API Key");

    // 错 Key 形态之外：非法 URL（非 http(s)）
    await t.po.fillApiKey("sk-fixture-not-a-real-key");
    await t.po.fillBaseUrl("ftp://api.example.com/v1");
    await t.po.next();
    expect(t.po.errorText()).toBe("Base URL 需以 http(s):// 开头");
    expect(upsertCalls).toEqual([]); // 校验失败不写后端

    // 修正后放行到第 3 步，Provider 恰好保存一次，且明确配置的模型成为 primary 默认
    await t.po.fillBaseUrl("https://api.example.com/v1");
    await t.po.next();
    expect(screen.getByRole("heading", { name: "选一个工作目录" })).toBeTruthy();
    expect(upsertCalls).toEqual(["deepseek"]);
    await expect(base.getPreferences()).resolves.toMatchObject({
      defaults: { model: { providerId: "deepseek", modelId: "deepseek-chat" } },
    });
  } finally {
    t.consoleTracker.restore();
  }
  t.consoleTracker.expectNoErrors();
});

it("ONB-04: 模板接口失败 → 渲染兜底空白模板不崩，创建流程仍可用", async () => {
  const base = new MockDataSource();
  const source = overrideSource(base, {
    listAgentTemplates: () => Promise.reject(new Error("模板服务不可达")),
  });
  const t = renderOnboarding(source);
  try {
    // 兜底空白模板仍然渲染（组件静默降级，无 console.error）
    await waitFor(() => {
      expect(t.po.templateGroup().textContent).toContain("空白");
    });
    expect(t.po.templateGroup().textContent).not.toContain("蓝色");

    // 四步推进到底（模板失败不影响创建链路）
    await t.po.typeName("小澄");
    await t.po.next();
    await t.po.fillApiKey("sk-fixture-not-a-real-key");
    await t.po.next();
    await t.po.next(); // 第 3 步工作目录可留空
    await t.po.finish();
    await waitFor(() => expect(t.completedAgentIds).toHaveLength(1));
  } finally {
    t.consoleTracker.restore();
  }
  t.consoleTracker.expectNoErrors();
});

/* ---- ONB-05（L5 侧）：无 desktopShell 桥（纯浏览器/happy-dom）时「浏览…」静默回退 ---- */

it("ONB-05(L5): 无桥环境点「浏览…」静默返回 null → 不崩、手输路径保留、创建链路不受阻", async () => {
  // happy-dom 无 window.desktopShell → pickDirectory() 返回 null（desktop/src/data/pick-directory.ts）
  expect((window as { desktopShell?: unknown }).desktopShell).toBeUndefined();
  const t = renderOnboarding(new MockDataSource());
  try {
    await t.po.typeName("小澄");
    await t.po.next();
    await t.po.fillApiKey("sk-fixture-not-a-real-key");
    await t.po.next();
    expect(screen.getByRole("heading", { name: "选一个工作目录" })).toBeTruthy();

    // 先手输路径，再点「浏览…」：无桥 → 静默 null → 输入框原样保留（回退手输）
    const directory = screen.getByPlaceholderText("例如 D:\\Projects\\notes") as HTMLInputElement;
    await t.user.type(directory, "D:\\oc-l5\\manual-cwd");
    await t.user.click(screen.getByRole("button", { name: "浏览…" }));
    await waitFor(() => expect(directory.value).toBe("D:\\oc-l5\\manual-cwd"));

    // 引导可正常走完（兜底路径不阻塞创建）
    await t.po.next();
    await t.po.finish();
    await waitFor(() => expect(t.completedAgentIds).toHaveLength(1));
  } finally {
    t.consoleTracker.restore();
  }
  t.consoleTracker.expectNoErrors();
});
