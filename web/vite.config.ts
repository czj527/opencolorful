import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SUPERVISOR_PORT = process.env.PERSON_AGENT_SUPERVISOR_PORT ?? "4311";
const AGENT_PORT = process.env.PERSON_AGENT_PORT ?? "4310";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Supervisor 自身 API 走 Supervisor 端口
      "/api/supervisor": {
        target: `http://127.0.0.1:${SUPERVISOR_PORT}`,
        changeOrigin: true,
      },
      // 其余 Agent API（含 SSE）走 Agent Server 端口
      "/api": {
        target: `http://127.0.0.1:${AGENT_PORT}`,
        changeOrigin: true,
      },
      // WebSocket 走 Agent Server
      "/ws": {
        target: `ws://127.0.0.1:${AGENT_PORT}`,
        ws: true,
      },
    },
  },
});
