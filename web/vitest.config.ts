import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/**"],
    testTimeout: 10_000,
    // 本机 shell 可能带 NODE_ENV=production：React 19 的 act 仅存在于 development
    // 构建，不固定会导致本机 web 测试全量挂掉（与 desktop/vitest.config.ts 同一修复）
    env: { NODE_ENV: "test" },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("test"),
  },
});
