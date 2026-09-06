import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket as UpstreamWebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";

import { PLATFORM_VERSION } from "../index.js";
import type { ProcessController } from "./process-controller.js";
import type { SupervisorStatusResponse } from "./types.js";
import { createTrustBoundaryMiddleware, generateServerToken } from "../server/trust-boundary.js";

export interface SupervisorAppOptions {
  readonly controller: ProcessController;
  readonly supervisorPort: number;
  readonly agentServerPort: number;
  readonly webDistDir?: string;
  /**
   * P0-1 信任边界：与 Agent Server 共享同一令牌来源（env > <runtime>/server-token）。
   * startSupervisor 注入；缺省（测试/内联装配）时生成随机临时令牌并经 result.token 暴露。
   */
  readonly trustBoundary?: {
    readonly token: string;
  };
}

export interface SupervisorAppResult {
  readonly app: Hono;
  readonly nodeWebSocket: ReturnType<typeof createNodeWebSocket>;
  /** 本实例的访问令牌（转发上游注入 / 测试接线用；绝不写入日志） */
  readonly token: string;
}

function sanitizeLogContent(content: string): string {
  return content
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "sk-***")
    .replace(/(Authorization|authorization)[:=]\s*\S+/g, "$1: ***")
    .replace(/(api[-_]?key)[:=]\s*\S+/gi, "$1=***");
}

function createSafeProxyBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch {
        // 客户端主动关闭 SSE/HTTP 流时，吞掉上游 ECONNRESET 并结束代理流。
        controller.close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // 上游已经断开。
      }
    },
  });
}

export function createSupervisorApp(options: SupervisorAppOptions): SupervisorAppResult {
  const app = new Hono();
  const nodeWebSocket = createNodeWebSocket({ app });
  const { controller, supervisorPort, agentServerPort } = options;
  const startedAt = Date.now();
  const trustToken = options.trustBoundary?.token ?? generateServerToken();

  // ── P0-1 信任边界（origin-guard 模式）：先于一切路由 ──
  // Host（DNS-rebinding）+ 写请求「有效令牌 或 本机 Origin」+ WS 握手规则。
  // 不做令牌强校验：浏览器经 Supervisor 同源访问时不持有令牌（数据面的令牌
  // 强校验在 Agent Server；本代理只向已通过本层校验的请求注入令牌）。
  app.use("*", createTrustBoundaryMiddleware({ token: trustToken, mode: "origin-guard" }));

  // --- Supervisor API ---

  app.get("/api/supervisor/status", async (context) => {
    const agentStatus = await controller.getAgentServerStatus();
    const response: SupervisorStatusResponse = {
      status: agentStatus === "online"
        ? "online"
        : agentStatus === "stopped"
          ? "stopped"
          : agentStatus === "starting"
            ? "starting"
            : agentStatus === "stopping"
              ? "stopping"
              : agentStatus === "error"
                ? "error"
                : "degraded",
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
        watchdog: controller.getWatchdogStatus(),
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

  app.get("/api/supervisor/logs", async (context) => {
    const limitParam = context.req.query("limit");
    const limit = limitParam === undefined ? undefined : Math.max(1, Math.min(2000, Number.parseInt(limitParam, 10)));
    const since = context.req.query("since") ?? null;
    const levelParam = context.req.query("level") ?? "all";
    const level: "all" | "info" | "warn" | "error" =
      levelParam === "info" || levelParam === "warn" || levelParam === "error" ? levelParam : "all";
    const query = context.req.query("query") ?? undefined;

    const result = controller.readLogTail({
      ...(limit !== undefined ? { limit } : {}),
      since,
      level,
      ...(query !== undefined ? { query } : {}),
    });
    const logs = "logs" in result ? result.logs : "";
    const truncated = result.truncated;
    const nextCursor = "nextCursor" in result ? result.nextCursor : null;
    const status = await controller.getAgentServerStatus();

    return context.json({
      logs: sanitizeLogContent(logs),
      truncated,
      nextCursor,
      status,
    });
  });

  // Agent Server 地址发现（WS 与直连场景）
  app.get("/api/supervisor/agent-server", (context) => {
    return context.json({
      url: `http://127.0.0.1:${agentServerPort}`,
      port: agentServerPort,
      wsUrl: `ws://127.0.0.1:${agentServerPort}/ws`,
    });
  });

  // --- WS 代理到 Agent Server ---
  app.get("/ws", nodeWebSocket.upgradeWebSocket(() => ({
    onOpen(_evt, clientWs) {
      // P0-1：上游握手无 Origin（Node 端 ws 客户端），必须携带 ?token= 通过
      // Agent Server 的 WS 信任边界；该 URL 不落任何日志。
      const upstreamUrl = new URL(`ws://127.0.0.1:${agentServerPort}/ws`);
      upstreamUrl.searchParams.set("token", trustToken);
      const upstream = new UpstreamWebSocket(upstreamUrl);
      const pending: string[] = [];
      let upstreamOpen = false;

      upstream.on("open", () => {
        upstreamOpen = true;
        for (const message of pending.splice(0)) upstream.send(message);
      });
      upstream.on("message", (data) => {
        try {
          clientWs.send(typeof data === "string" ? data : data.toString());
        } catch { /* client gone */ }
      });
      upstream.on("close", () => {
        try { clientWs.close(); } catch { /* already closed */ }
      });
      upstream.on("error", () => {
        try { clientWs.close(); } catch { /* already closed */ }
      });

      clientWs.raw?.addEventListener("message", (evt) => {
        const raw = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer);
        if (upstreamOpen) {
          upstream.send(raw);
        } else {
          pending.push(raw);
        }
      });
      clientWs.raw?.addEventListener("close", () => {
        upstream.close();
      });
    },
  })));

  // --- HTTP/SSE 代理：非 Supervisor 的 /api 请求转发到 Agent Server ---
  app.all("/api/*", async (context) => {
    const requestUrl = new URL(context.req.url);
    const target = `http://127.0.0.1:${agentServerPort}${requestUrl.pathname}${requestUrl.search}`;

    const headers = new Headers();
    for (const [name, value] of context.req.raw.headers.entries()) {
      if (["host", "connection", "content-length"].includes(name.toLowerCase())) continue;
      headers.set(name, value);
    }
    // P0-1：向已通过本层信任边界（令牌或本机 Origin）的请求注入服务令牌——
    // 数据面的令牌强校验在 Agent Server；客户端已自带令牌时不覆盖。
    if (!headers.has("authorization") && !headers.has("x-oc-token")) {
      headers.set("authorization", `Bearer ${trustToken}`);
    }

    const method = context.req.method;
    const hasBody = !["GET", "HEAD"].includes(method);

    let response: Response;
    try {
      response = await fetch(target, {
        method,
        headers,
        ...(hasBody ? { body: await context.req.raw.clone().text() } : {}),
        redirect: "manual",
      });
    } catch {
      return context.json(
        { code: "AGENT_UNREACHABLE", message: "Agent Server 未运行或不可达", retryable: true },
        502,
      );
    }

    const responseHeaders = new Headers();
    for (const [name, value] of response.headers.entries()) {
      if (["connection", "transfer-encoding", "content-length", "content-encoding"].includes(name.toLowerCase())) continue;
      responseHeaders.set(name, value);
    }

    return new Response(createSafeProxyBody(response.body), {
      status: response.status,
      headers: responseHeaders,
    });
  });

  // --- 生产模式托管 Web 静态资源 ---
  const webDistDir = options.webDistDir;
  if (webDistDir && fs.existsSync(webDistDir)) {
    app.use("/assets/*", serveStatic({ root: webDistDir }));
    app.get("*", (context) => {
      const indexPath = path.join(webDistDir, "index.html");
      if (fs.existsSync(indexPath)) {
        return context.html(fs.readFileSync(indexPath, "utf8"));
      }
      return context.notFound();
    });
  }

  app.notFound((context) =>
    context.json({ code: "NOT_FOUND", message: "资源不存在" }, 404),
  );

  return { app, nodeWebSocket, token: trustToken };
}
