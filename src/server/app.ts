import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";

import { PLATFORM_VERSION } from "../index.js";
import type { RuntimePaths } from "../config/paths.js";
import type { EventReplayStore } from "../runtime/event-replay-store.js";
import type { ModelService } from "../runtime/model-service.js";
import type { SessionService } from "../runtime/session-service.js";
import type { PromptService } from "../runtime/prompt-service.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { ClientRegistry } from "./ws/client-registry.js";
import { SessionHandler } from "./ws/session-handler.js";

export interface ServerAppOptions {
  readonly version?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly paths?: RuntimePaths;
  readonly modelService?: ModelService;
  readonly sessionService?: SessionService;
  readonly promptService?: PromptService;
  readonly replayStore?: EventReplayStore;
  readonly wsRegistry?: ClientRegistry;
  readonly wsPromptService?: PromptService;
  readonly wsReplayStore?: EventReplayStore;
}

export interface ServerAppResult {
  readonly app: Hono;
  readonly nodeWebSocket: ReturnType<typeof createNodeWebSocket>;
}

export function createServerApp(options: ServerAppOptions = {}): ServerAppResult {
  const version = options.version ?? PLATFORM_VERSION;
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? Date.now();
  const app = new Hono();

  const nodeWebSocket = createNodeWebSocket({ app });

  app.get("/api/health", (context) =>
    context.json({
      status: "ok",
      version,
      pid,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    }),
  );

  if (options.modelService !== undefined) {
    registerProviderRoutes(app, options.modelService);
    registerModelRoutes(app, options.modelService);
  }
  if (options.sessionService !== undefined) {
    registerSessionRoutes(app, options.sessionService);
  }
  if (options.promptService !== undefined) {
    registerMessageRoutes(app, {
      promptService: options.promptService,
      ...(options.sessionService !== undefined ? { sessionService: options.sessionService } : {}),
      ...(options.replayStore !== undefined ? { replayStore: options.replayStore } : {}),
      ...(options.paths !== undefined ? { paths: options.paths } : {}),
    });
  }
  if (options.replayStore !== undefined && options.promptService !== undefined) {
    registerEventRoutes(app, options.replayStore, options.promptService, options.sessionService);
  }

  // WebSocket 路由
  const wsRegistry = options.wsRegistry;
  const wsPromptService = options.wsPromptService;
  const wsReplayStore = options.wsReplayStore;
  if (wsRegistry !== undefined && wsPromptService !== undefined && wsReplayStore !== undefined) {
    app.get("/ws", nodeWebSocket.upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        const clientId = `ws-${crypto.randomUUID()}`;
        const handler = new SessionHandler(
          ws,
          clientId,
          wsRegistry,
          wsPromptService,
          wsReplayStore,
          options.sessionService,
        );
        wsRegistry.register(clientId, ws);

        const unsubscribe = wsReplayStore.subscribe((event) => {
          if (event.sessionId === null) return;
          if (wsRegistry.isSubscribed(clientId, event.sessionId)) {
            ws.send(JSON.stringify({ type: "event", payload: event }));
          }
        });

        ws.raw?.addEventListener("message", (evt) => {
          const raw = typeof evt.data === "string"
            ? evt.data
            : new TextDecoder().decode(evt.data as ArrayBuffer);
          handler.handleMessage(raw);
        });

        ws.raw?.addEventListener("close", () => {
          unsubscribe();
          handler.handleClose();
        });
      },
    })));
  }

  app.notFound((context) => context.json({ code: "NOT_FOUND", message: "资源不存在" }, 404));
  return { app, nodeWebSocket };
}
