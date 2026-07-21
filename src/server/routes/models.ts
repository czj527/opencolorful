import type { Hono } from "hono";

import type { ModelService } from "../../runtime/model-service.js";

export function registerModelRoutes(app: Hono, modelService: ModelService): void {
  app.get("/api/models", (context) => context.json(modelService.listModels()));
}
