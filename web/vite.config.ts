import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const SUPERVISOR_PORT = process.env.OPENCOLORFUL_SUPERVISOR_PORT ?? "4311";
const AGENT_PORT = process.env.OPENCOLORFUL_PORT ?? "4310";

// ── P0-1 信任边界：vite dev 代理是受信本机客户端，为浏览器侧请求统一附加服务令牌
// （浏览器读不到 env/令牌文件；令牌绝不打进前端产物）。只读解析：env > 令牌文件，
// 带短 TTL 缓存，服务端重启换令牌后最多 2s 自愈。来源路径与 src/config/paths.ts 一致。
const TOKEN_ENV = "OPENCOLORFUL_SERVER_TOKEN";
const TOKEN_CACHE_TTL_MS = 2_000;
let tokenCache: { value: string | null; at: number } | null = null;

function resolveServerToken(): string | null {
  const fromEnv = (process.env[TOKEN_ENV] ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const now = Date.now();
  if (tokenCache !== null && now - tokenCache.at < TOKEN_CACHE_TTL_MS) return tokenCache.value;
  const override = (process.env.OPENCOLORFUL_HOME ?? "").trim();
  const home = override !== "" ? override : path.join(os.homedir(), ".opencolorful");
  let value: string | null = null;
  try {
    const raw = fs.readFileSync(path.join(home, "runtime", "server-token"), "utf8").trim();
    value = raw !== "" ? raw : null;
  } catch {
    value = null;
  }
  tokenCache = { value, at: now };
  return value;
}

/** 代理转发前注入 Authorization（客户端已带令牌时不覆盖） */
function attachToken(proxyOptions: ProxyOptions): ProxyOptions {
  return {
    ...proxyOptions,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq) => {
        const token = resolveServerToken();
        if (token !== null && proxyReq.getHeader("authorization") === undefined) {
          proxyReq.setHeader("authorization", `Bearer ${token}`);
        }
      });
      proxy.on("proxyReqWs", (proxyReq) => {
        const token = resolveServerToken();
        if (token !== null && proxyReq.getHeader("authorization") === undefined) {
          proxyReq.setHeader("authorization", `Bearer ${token}`);
        }
      });
      proxyOptions.configure?.(proxy);
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Supervisor 自身 API 走 Supervisor 端口
      "/api/supervisor": attachToken({
        target: `http://127.0.0.1:${SUPERVISOR_PORT}`,
        changeOrigin: true,
      }),
      // 其余 Agent API（含 SSE）走 Agent Server 端口
      "/api": attachToken({
        target: `http://127.0.0.1:${AGENT_PORT}`,
        changeOrigin: true,
      }),
      // WebSocket 走 Agent Server
      "/ws": attachToken({
        target: `ws://127.0.0.1:${AGENT_PORT}`,
        ws: true,
      }),
    },
  },
});
