import { Hono } from "hono";

import { PLATFORM_VERSION } from "../index.js";
import type { ModelService } from "../runtime/model-service.js";
import type { SessionService } from "../runtime/session-service.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSessionRoutes } from "./routes/sessions.js";

export interface ServerAppOptions {
  readonly version?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly modelService?: ModelService;
  readonly sessionService?: SessionService;
}

export function createServerApp(options: ServerAppOptions = {}): Hono {
  const version = options.version ?? PLATFORM_VERSION;
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? Date.now();
  const app = new Hono();

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

  app.notFound((context) => context.json({ code: "NOT_FOUND", message: "资源不存在" }, 404));
  return app;
}
