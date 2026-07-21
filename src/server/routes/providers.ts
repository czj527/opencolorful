import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import {
  parseProviderUpdateRequest,
  ProviderSettingsValidationError,
} from "../../contracts/provider-settings.js";
import type { ModelService } from "../../runtime/model-service.js";

export function registerProviderRoutes(app: Hono, modelService: ModelService): void {
  app.get("/api/settings/providers", (context) => context.json(modelService.listProviders()));

  app.put("/api/settings/providers", async (context) => {
    try {
      const request = parseProviderUpdateRequest(await context.req.json());
      return context.json(await modelService.upsert(request.provider, request.apiKey));
    } catch (error) {
      const message =
        error instanceof ProviderSettingsValidationError ? error.message : "Provider 设置保存失败";
      return context.json(createApiError("INVALID_INPUT", message), 400);
    }
  });
}
