/**
 * L6 Desktop Electron 真链测试配置（desktop-test-conventions §二）。
 *
 * 运行命令：npx playwright test --config desktop/tests/e2e/playwright.config.ts
 * CI 冒烟：追加 `--grep @smoke` 仅跑真链最小冒烟链。
 *
 * 证据：失败时 trace/截图落 desktop/test-artifacts/pw-output/（该目录已加入 .gitignore）；
 * fixture 另将引导日志与目录清单留档 desktop/test-artifacts/。
 */
import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// desktop/tests/e2e → desktop/test-artifacts（约定 §六：证据统一写 desktop/test-artifacts/）
const artifactsDir = path.resolve(here, "..", "..", "test-artifacts");

export default defineConfig({
  testDir: here,
  testMatch: "**/*.truechain.spec.ts",
  // 真链用例共享 fixture 后端且断言含流式时序：强制串行（与 L4 web E2E 同一约定）
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: path.join(artifactsDir, "pw-output"),
  reporter: process.env.CI
    ? [["list"], ["html", { outputDir: path.join(artifactsDir, "pw-report"), open: "never" }]]
    : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
