/**
 * A5 lane · 诊断关联端到端佐证（@a5）。
 *
 * 覆盖 plan A5 acceptance："A real Electron failure can be followed from UI message
 * to IPC and Server/runtime records"——以 CHAT-06 的 Provider 401 场景为失败源：
 * 1. 真链会话中 stub 切 error-401 → 发消息 → turn.failed → 聊天时间线出现「运行错误」
 *    事件行，行内出现 A5 诊断引用（code[title]=完整 traceId）；
 * 2. 点「在日志中查看」→ 跳转日志页活动 tab，traceId 过滤被预填 + 焦点横幅可见；
 * 3. 服务端真值对照（只读）：GET /api/observability/activity?traceId=<引用中的 id>
 *    命中 ≥1 条记录（含 failed 状态）——UI 消息 → IPC → 服务端记录链路闭合；
 * 4. 脱敏自查：错误行与日志页可见文本不含 stub 假 Key。
 *
 * 复用 lane-a4b 的可切换 stub（mode: error-401）与隔离后端 fixture（只读 import，
 * 不修改其文件）；L5 侧用例在 observability.mock.test.tsx / chat.mock.test.tsx。
 */
import { expect } from "@playwright/test";

import { firstWindow, launchApp, closeApp } from "./fixtures/app.js";
import { test } from "./fixtures/lane-a4b/harness.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

const FAST_REPLY = "oc-e2e-lane回复：A4b 真链回归的完整回复，用于验证定稿与持久化。";
const TRIGGER = "oc-e2e-a5-触发 Provider 401 的消息";

test.describe("@a5 诊断关联端到端", () => {
  test("Provider 失败 → 错误行诊断引用 → 日志页预填定位 → 服务端 activity 真值命中", async ({ lane }) => {
    const runId = Date.now().toString(36);
    let currentApp: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      currentApp = await launchApp({
        serverUrl: lane.serverUrl,
        homeDir: lane.homeDir,
        userDataDir: lane.userDataDir,
      });
      const page = await firstWindow(currentApp);

      /* ---- 引导建助理（Provider 指向 lane stub）---- */
      const onboarding = new OnboardingPO(page);
      await onboarding.expectStepAssistantVisible();
      await onboarding.completeAllSteps({
        name: `oc-e2e-助理-${runId}`,
        apiKey: lane.fakeApiKey,
        baseUrl: lane.stubUrl,
        modelId: "oc-e2e-model",
      });

      /* ---- 首条消息成功（建立真实会话，stub 默认 fast）---- */
      const chat = new ChatPO(page);
      await chat.fill(`oc-e2e-a5-首条-${runId}`);
      await chat.send();
      await chat.expectMessageVisible(FAST_REPLY, 30_000);

      /* ---- Provider 401 → turn.failed → 错误行 + A5 诊断引用 ---- */
      await lane.setStub({ mode: "error-401" });
      await chat.fill(TRIGGER);
      await chat.send();
      const errorRow = page.locator("article.event", { hasText: "运行错误" }).first();
      await expect(errorRow, "401 应渲染运行错误事件行").toBeVisible({ timeout: 30_000 });
      const referenceCode = errorRow.locator("code", { hasText: "诊断引用" });
      await expect(referenceCode, "错误行应出现 A5 诊断引用").toBeVisible({ timeout: 15_000 });
      const traceId = await referenceCode.getAttribute("title");
      expect(traceId, "完整 traceId 应在 title 中可复制").toBeTruthy();
      expect(traceId!, "traceId 不得包含 stub 假 Key").not.toContain(lane.fakeApiKey);

      /* ---- 「在日志中查看」→ 日志页预填 traceId 过滤 ---- */
      await errorRow.getByRole("button", { name: "在日志中查看" }).click();
      const traceInput = page.getByRole("searchbox", { name: "traceId 过滤" });
      await expect(traceInput, "日志页应按诊断引用预填 traceId 过滤").toHaveValue(traceId!, { timeout: 15_000 });
      await expect(
        page.getByText(/已按诊断引用预填 traceId 过滤/),
        "预填来源横幅应可见",
      ).toBeVisible();
      const activitySection = page.getByRole("region", { name: "活动事件" });
      await expect(
        activitySection.locator("tbody tr").first(),
        "预填后活动表应命中该 trace 的记录",
      ).toBeVisible({ timeout: 15_000 });

      /* ---- 服务端真值对照（只读）：引用中的 traceId 在服务端记录可查 ---- */
      const activity = await lane.apiGet<{ items: Array<{ traceId?: string; status?: string }> }>(
        `/api/observability/activity?traceId=${encodeURIComponent(traceId!)}&limit=20`,
      );
      expect(activity.items.length, "activity?traceId 应命中 ≥1 条服务端记录").toBeGreaterThanOrEqual(1);
      expect(
        activity.items.some((row) => row.status === "failed"),
        "命中记录应包含 failed 状态（turn 失败链路）",
      ).toBe(true);
      expect(
        JSON.stringify(activity.items),
        "服务端记录不得包含 stub 假 Key（脱敏红线）",
      ).not.toContain(lane.fakeApiKey);
    } finally {
      if (currentApp !== null) {
        await closeApp(currentApp).catch(() => undefined);
      }
    }
  });
});
