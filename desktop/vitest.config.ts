import { defineConfig } from "vitest/config";

/**
 * L5（Desktop Mock）测试配置（docs/testing/desktop-test-conventions.md §二）。
 *
 * - environment 用 happy-dom：无 Electron、无后端，MockDataSource 驱动全部状态。
 * - 收集 desktop/src 下的 *.test.ts(x)（Mock 渲染层）与 desktop/tests/unit 下的
 *   夹具单测（如凭据环境剥离）；tests/e2e 与 tests/fixtures 本身不含 test()，
 *   不进入收集范围（L6 走独立 Playwright 配置）。
 * - 不复用 vite.config.ts（构建配置含 electron 目标），测试配置独立成文件。
 */
export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/unit/**/*.test.ts"],
    testTimeout: 10_000,
    // 本机 shell 可能带 NODE_ENV=production（React 19 的 act 仅存在于 development
    // 构建）；测试进程固定为 test，保证 RTL 的 act 路径可用。
    env: { NODE_ENV: "test" },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("test"),
  },
});
