/**
 * L6 真链冒烟 · Playwright fixture 组合。
 *
 * 生命周期：用例开始 → 拉起隔离后端（临时 OPENCOLORFUL_HOME + stub Provider + 真实 Agent Server）；
 * 用例结束 → 通过：删除临时目录并自检清理干净；失败：保留现场并把证据写入 desktop/test-artifacts/。
 * （fixture 生命周期细节 = agent-delegated；隔离边界与矩阵范围 = human-fixed，不放宽）
 */
import { test as base, expect } from "@playwright/test";

import { BackendHarness } from "./backend.js";

export interface HarnessFixtures {
  /** 已就绪的隔离后端（serverUrl/stubUrl/homeDir/userDataDir 可用） */
  harness: BackendHarness;
}

export const test = base.extend<HarnessFixtures>({
  harness: async ({ }, use, testInfo) => {
    const harness = new BackendHarness(sanitizeLabel(testInfo.title));
    try {
      await harness.start();
      await use(harness);
    } finally {
      // start 失败（含重试耗尽）也走 retain 留证路径
      const started = harness.started;
      const retain = testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus;
      const result = await harness.dispose(!started || retain);
      // 清理自检：通过路径下临时目录必须被删除干净（验收项：teardown 后无残留）
      if (started && !retain) {
        expect(result.cleaned, "teardown 后临时运行根目录应被删除干净").toBe(true);
      }
    }
  },
});

function sanitizeLabel(title: string): string {
  return title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "") || "case";
}
