import { Hono } from "hono";

import { PLATFORM_VERSION } from "../index.js";
import type { ProcessController } from "./process-controller.js";
import type { SupervisorStatusResponse } from "./types.js";

export interface SupervisorAppOptions {
  readonly controller: ProcessController;
  readonly supervisorPort: number;
  readonly agentServerPort: number;
}

export function createSupervisorApp(options: SupervisorAppOptions): Hono {
  const app = new Hono();
  const { controller, supervisorPort, agentServerPort } = options;
  const startedAt = Date.now();

  app.get("/api/supervisor/status", async (context) => {
    const agentStatus = await controller.getAgentServerStatus();
    const response: SupervisorStatusResponse = {
      status: agentStatus === "online" ? "online" : agentStatus === "stopped" ? "stopped" : "degraded",
      supervisor: {
        pid: process.pid,
        port: supervisorPort,
        version: PLATFORM_VERSION,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      },
      agentServer: {
        status: agentStatus,
        pid: controller.agentServerPid,
        port: agentStatus !== "stopped" ? agentServerPort : null,
        version: PLATFORM_VERSION,
      },
    };
    return context.json(response);
  });

  app.post("/api/supervisor/start", async (context) => {
    try {
      const result = await controller.startAgentServer();
      return context.json({ status: "started", pid: result.pid, port: result.port }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "启动失败";
      if (message.includes("已在运行") || message.includes("already")) {
        return context.json({ status: "already_running" }, 200);
      }
      return context.json({ status: "error", message }, 500);
    }
  });

  app.post("/api/supervisor/stop", async (context) => {
    try {
      await controller.stopAgentServer();
      return context.json({ status: "stopped" });
    } catch (error) {
      return context.json(
        { status: "error", message: error instanceof Error ? error.message : "停止失败" },
        500,
      );
    }
  });

  app.post("/api/supervisor/restart", async (context) => {
    try {
      const result = await controller.restartAgentServer();
      return context.json({ status: "restarted", pid: result.pid, port: result.port });
    } catch (error) {
      return context.json(
        { status: "error", message: error instanceof Error ? error.message : "重启失败" },
        500,
      );
    }
  });

  app.get("/api/supervisor/logs", (context) => {
    const { logs, truncated } = controller.readLogTail();
    return context.json({ logs, truncated });
  });

  app.notFound((context) =>
    context.json({ code: "NOT_FOUND", message: "资源不存在" }, 404),
  );

  return app;
}
