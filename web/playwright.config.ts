import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: 0,
  // 复审 P2：各 spec 的 freePort() 是"先探测后绑定"的 TOCTOU 分配——
  // 并行 worker 下两个 spec 可能拿到同一端口（并行 42/45，串行 45/45），
  // 串行执行是确定性的，故强制 workers: 1
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1",
    headless: true,
  },
});
