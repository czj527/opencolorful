import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import { normalizePreferences } from "../../contracts/preferences.js";
import { THINKING_LEVELS, TOOL_MODES } from "../../contracts/session-settings.js";
import type { PreferencesStore } from "../../config/preferences-store.js";
import type { ModelService } from "../../runtime/model-service.js";

/**
 * 全局偏好路由。
 *
 * - GET 返回已归一化的偏好文档；
 * - PUT 只接受 `defaults`、`layout` 子树 patch，每次先归一化再校验；
 * - 当 patch 含 `defaults.model` 时调用 `ModelService.resolveModel` 验证模型，
 *   不可用返回 400 且不修改磁盘文档（保留上一次合法值）。
 */
export function registerSettingsRoutes(
  app: Hono,
  preferencesStore: PreferencesStore,
  modelService?: ModelService,
): void {
  app.get("/api/settings/preferences", (context) => {
    return context.json(preferencesStore.get());
  });

  app.put("/api/settings/preferences", async (context) => {
    const body = (await context.req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      return context.json(createApiError("INVALID_INPUT", "偏好请求体无效"), 400);
    }

    const hasDefaults = body.defaults !== undefined;
    const hasLayout = body.layout !== undefined;
    const hasAppearance = body.appearance !== undefined;
    const rawDefaults = hasDefaults ? (body.defaults as Record<string, unknown>) : undefined;
    const rawLayout = hasLayout ? (body.layout as Record<string, unknown>) : undefined;
    const rawAppearance = hasAppearance ? (body.appearance as Record<string, unknown>) : undefined;

    const previous = preferencesStore.get();
    // 深合并 patch 与已有值：请求只提交变化的字段，缺失字段保留上一次值。
    const mergedDefaults = rawDefaults !== undefined
      ? { ...previous.defaults, ...rawDefaults }
      : previous.defaults;
    const mergedLayout = rawLayout !== undefined
      ? { ...previous.layout, ...rawLayout }
      : previous.layout;
    const mergedAppearance = rawAppearance !== undefined
      ? { ...previous.appearance, ...rawAppearance }
      : previous.appearance;
    const candidate = normalizePreferences({
      version: 1,
      defaults: mergedDefaults,
      layout: mergedLayout,
      appearance: mergedAppearance,
    });

    // 显式校验原始请求字段：非法枚举返回 400 而不是静默回退。
    if (rawDefaults !== undefined) {
      if (Object.prototype.hasOwnProperty.call(rawDefaults, "toolMode")) {
        const mode = rawDefaults.toolMode;
        if (typeof mode !== "string" || !(TOOL_MODES as readonly string[]).includes(mode)) {
          return context.json(createApiError("INVALID_INPUT", "toolMode 不合法"), 400);
        }
        if (mode === "all") {
          return context.json(
            createApiError("INVALID_INPUT", "完整工具权限必须在具体会话中确认工作目录"),
            400,
          );
        }
      }
      if (Object.prototype.hasOwnProperty.call(rawDefaults, "thinkingLevel")) {
        const level = rawDefaults.thinkingLevel;
        if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
          return context.json(createApiError("INVALID_INPUT", "thinkingLevel 不合法"), 400);
        }
      }
      if (
        rawDefaults.model !== undefined &&
        rawDefaults.model !== null &&
        (typeof rawDefaults.model !== "object" ||
          typeof (rawDefaults.model as { providerId?: unknown }).providerId !== "string" ||
          typeof (rawDefaults.model as { modelId?: unknown }).modelId !== "string")
      ) {
        return context.json(createApiError("INVALID_INPUT", "model 引用无效"), 400);
      }
    }

    if (rawAppearance !== undefined) {
      if (Object.prototype.hasOwnProperty.call(rawAppearance, "theme")) {
        const theme = rawAppearance.theme;
        if (theme !== "dark" && theme !== "light") {
          return context.json(createApiError("INVALID_INPUT", "theme 必须是 dark 或 light"), 400);
        }
      }
    }

    // 模型可用性校验：拒绝写入不可 resolve 的默认模型。
    if (
      rawDefaults?.model !== undefined &&
      rawDefaults.model !== null &&
      modelService !== undefined
    ) {
      const model = candidate.defaults.model;
      if (model !== null) {
        try {
          modelService.resolveModel(model.providerId, model.modelId);
        } catch {
          return context.json(
            createApiError("INVALID_INPUT", "默认模型不存在或凭据不可用", false, {
              providerId: model.providerId,
              modelId: model.modelId,
            }),
            400,
          );
        }
      }
    }

    const updated = preferencesStore.update(candidate);
    return context.json(updated);
  });
}
