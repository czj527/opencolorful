import { defineConfig } from "@playwright/test";

// ── P0-1 信任边界 ──
// Web E2E 里 spec 既驱动浏览器（同源访问 Supervisor，走本机 Origin 规则），
// 也用 page.request（Playwright APIRequestContext，Node 侧、无 Origin）直连
// Supervisor 做种子写入。后者必须携带服务令牌：这里固定一枚 E2E 令牌注入
// process.env（Supervisor 与其拉起的 Agent Server 经 env 优先级取到同一枚），
// 并经 extraHTTPHeaders 附加到所有 APIRequestContext 请求上，走真实校验路径。
const E2E_TOKEN = process.env.OPENCOLORFUL_SERVER_TOKEN?.trim() || "oc-web-e2e-local-token";
process.env.OPENCOLORFUL_SERVER_TOKEN = E2E_TOKEN;

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
    extraHTTPHeaders: {
      "x-oc-token": E2E_TOKEN,
    },
    // CI 间歇失败诊断：失败时保留 trace 与截图，经 workflow 的 artifact 上传回收
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
