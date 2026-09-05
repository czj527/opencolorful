/**
 * A4b lane · Playwright fixture 组合（与共享 fixtures/harness.ts 同语义，绑定 lane 后端）。
 *
 * 生命周期：用例开始 → 拉起隔离 lane 后端（临时 OPENCOLORFUL_HOME + 可切换 stub + circuit proxy + 真实 Agent Server）；
 * 用例结束 → 通过：删除临时目录并自检清理干净；失败：保留现场并把证据写入 desktop/test-artifacts/。
 */
import { test as base, expect } from "@playwright/test";

import { LaneBackendHarness } from "./backend.js";

export interface LaneHarnessFixtures {
  /** 已就绪的隔离 lane 后端（serverUrl/appUrl/stubUrl/homeDir/userDataDir 可用） */
  lane: LaneBackendHarness;
}

export const test = base.extend<LaneHarnessFixtures>({
  lane: async ({ }, use, testInfo) => {
    const lane = new LaneBackendHarness(sanitizeLabel(testInfo.title));
    try {
      await lane.start();
      await use(lane);
    } finally {
      const started = lane.started;
      const retain = testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus;
      const result = await lane.dispose(!started || retain);
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
