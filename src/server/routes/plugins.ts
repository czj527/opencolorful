import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { PluginSourceType } from "../../contracts/plugin-protocol.js";
import { assertPluginSourceRef } from "../../runtime/plugins/sources/source-adapter.js";
import type { PluginFacade } from "../../platform/plugin-facade.js";
import type { GrantChangeRequest } from "../../runtime/plugins/grants/grant-service.js";

export interface PluginRouteDeps {
  readonly facade: PluginFacade;
}

function parseJsonBody(context: { req: { json(): Promise<unknown> } }, fallback: unknown): Promise<unknown> {
  return context.req.json().catch(() => fallback);
}

/**
 * Phase 12 插件中心路由（plans/phase-12.md §十八）。
 * 只做解析/校验/调用与状态码，业务在 PluginFacade；错误统一 ApiError（中文、不含敏感输入）。
 */
export function registerPluginRoutes(app: Hono, deps: PluginRouteDeps): void {
  const { facade } = deps;

  app.get("/api/plugins", (context) => {
    try {
      return context.json(facade.list());
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "插件列表加载失败"), 500);
    }
  });

  app.get("/api/plugins/:id", (context) => {
    try {
      const detail = facade.getDetail(context.req.param("id"));
      if (detail === undefined) {
        return context.json(createApiError("NOT_FOUND", "插件未安装"), 404);
      }
      return context.json(detail);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "插件详情加载失败"), 500);
    }
  });

  app.post("/api/plugins/inspect", async (context) => {
    const body = (await parseJsonBody(context, {})) as { sourceRef?: unknown };
    if (body.sourceRef === undefined) {
      return context.json(createApiError("INVALID_INPUT", "需要 sourceRef"), 400);
    }
    try {
      const sourceRef = assertPluginSourceRef(body.sourceRef);
      return context.json(facade.inspect(sourceRef));
    } catch (error) {
      return context.json(createApiError("INVALID_INPUT", error instanceof Error ? error.message : "来源检查失败"), 400);
    }
  });

  app.post("/api/plugins/install", async (context) => {
    const body = (await parseJsonBody(context, {})) as { sourceRef?: unknown; grants?: unknown };
    if (body.sourceRef === undefined) {
      return context.json(createApiError("INVALID_INPUT", "需要 sourceRef"), 400);
    }
    try {
      const sourceRef = assertPluginSourceRef(body.sourceRef);
      const grants = (Array.isArray(body.grants) ? body.grants : []) as GrantChangeRequest[];
      const result = await facade.install(sourceRef, grants);
      return context.json(result, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : "安装失败";
      if (message.includes("不兼容")) {
        return context.json(createApiError("INVALID_INPUT", message), 400);
      }
      return context.json(createApiError("INTERNAL_ERROR", message), 500);
    }
  });

  app.post("/api/plugins/:id/enable", async (context) => {
    try { await facade.enable(context.req.param("id")); return context.json({ status: "enabled" }); }
    catch (error) { return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "启用失败"), 500); }
  });

  app.post("/api/plugins/:id/disable", async (context) => {
    try { await facade.disable(context.req.param("id")); return context.json({ status: "disabled" }); }
    catch (error) { return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "禁用失败"), 500); }
  });

  app.post("/api/plugins/:id/update", async (context) => {
    const body = (await parseJsonBody(context, {})) as { sourceRef?: unknown };
    if (body.sourceRef === undefined) {
      return context.json(createApiError("INVALID_INPUT", "需要 sourceRef"), 400);
    }
    try {
      const sourceRef = assertPluginSourceRef(body.sourceRef);
      return context.json(await facade.update(context.req.param("id"), sourceRef));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "更新失败"), 500);
    }
  });

  app.post("/api/plugins/:id/rollback", async (context) => {
    try { return context.json(await facade.rollback(context.req.param("id"))); }
    catch (error) { return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "回滚失败"), 500); }
  });

  app.delete("/api/plugins/:id", async (context) => {
    try { await facade.uninstall(context.req.param("id")); return context.json({ status: "removed" }); }
    catch (error) { return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "卸载失败"), 500); }
  });

  app.get("/api/plugins/:id/diagnostics", (context) => {
    try {
      const installation = facade.get(context.req.param("id"));
      if (installation === undefined) {
        return context.json(createApiError("NOT_FOUND", "插件未安装"), 404);
      }
      return context.json({
        pluginId: installation.pluginId,
        version: installation.version,
        status: installation.status,
        active: installation.active,
      });
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "诊断加载失败"), 500);
    }
  });

  app.get("/api/plugin-sources", (context) => {
    return context.json([
      { sourceType: "local", label: "本地目录", supported: true },
      { sourceType: "zip", label: "ZIP 包", supported: true },
      { sourceType: "git", label: "Git 仓库", supported: true },
      { sourceType: "npm", label: "npm 包", supported: true },
      { sourceType: "openclaw", label: "OpenClaw / ClawHub", supported: true },
      { sourceType: "hermes", label: "Hermes", supported: true },
      { sourceType: "mcp", label: "MCP 配置", supported: false },
    ]);
  });

  app.post("/api/plugin-sources/search", async (context) => {
    const body = (await parseJsonBody(context, {})) as { sourceType?: unknown; query?: unknown };
    try {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      const sourceType = typeof body.sourceType === "string" && body.sourceType.length > 0
        ? (body.sourceType as PluginSourceType)
        : undefined;
      return context.json(facade.search(query, sourceType));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "来源搜索失败"), 500);
    }
  });

  // ── Agent 绑定 ─────────────────────────────────────────────

  app.get("/api/agents/:agentId/plugins", (context) => {
    try {
      return context.json(facade.listAgentBindings(context.req.param("agentId")));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "绑定列表加载失败"), 500);
    }
  });

  app.put("/api/agents/:agentId/plugins/:pluginId", async (context) => {
    const body = (await parseJsonBody(context, {})) as { contributions?: unknown };
    try {
      facade.bind(
        context.req.param("agentId"),
        context.req.param("pluginId"),
        Array.isArray(body.contributions) ? body.contributions.map(String) : [],
      );
      return context.json({ status: "bound" });
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "绑定失败"), 500);
    }
  });

  app.delete("/api/agents/:agentId/plugins/:pluginId", async (context) => {
    try {
      facade.unbind(context.req.param("agentId"), context.req.param("pluginId"));
      return context.json({ status: "unbound" });
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "解绑失败"), 500);
    }
  });
}

/** Phase 12 开发态路由（plans/phase-12.md §十五） */
export function registerPluginDevRoutes(app: Hono, deps: PluginRouteDeps): void {
  const { facade } = deps;

  app.post("/api/plugins/dev/install", async (context) => {
    const body = (await parseJsonBody(context, {})) as { sourceDir?: unknown; fullAccess?: unknown };
    if (typeof body.sourceDir !== "string" || body.sourceDir.trim() === "") {
      return context.json(createApiError("INVALID_INPUT", "需要本地开发源码目录 sourceDir"), 400);
    }
    try {
      const state = await facade.devHost.install({
        sourceDir: body.sourceDir,
        sourceType: "local",
        fullAccess: body.fullAccess === true,
        actor: { kind: "user", id: "web" },
      });
      return context.json(state, 201);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "dev 安装失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/reload", async (context) => {
    const body = (await parseJsonBody(context, {})) as { devRunId?: unknown };
    try {
      const state = await facade.devHost.reload(context.req.param("pluginId"), String(body.devRunId ?? ""));
      return context.json(state);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "reload 失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/enable", async (context) => {
    const body = (await parseJsonBody(context, {})) as { devRunId?: unknown };
    try {
      return context.json(await facade.devHost.enable(context.req.param("pluginId"), String(body.devRunId ?? "")));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "enable 失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/disable", async (context) => {
    const body = (await parseJsonBody(context, {})) as { devRunId?: unknown };
    try {
      return context.json(await facade.devHost.disable(context.req.param("pluginId"), String(body.devRunId ?? "")));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "disable 失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/reset", async (context) => {
    const body = (await parseJsonBody(context, {})) as { devRunId?: unknown };
    try {
      return context.json(await facade.devHost.reset(context.req.param("pluginId"), String(body.devRunId ?? "")));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "reset 失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/uninstall", async (context) => {
    const body = (await parseJsonBody(context, {})) as { devRunId?: unknown };
    try {
      await facade.devHost.uninstall(context.req.param("pluginId"), String(body.devRunId ?? ""));
      return context.json({ status: "removed" });
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "dev 卸载失败"), 500);
    }
  });

  app.get("/api/plugins/dev/:pluginId/diagnostics", (context) => {
    try {
      return context.json(facade.devHost.diagnostics(context.req.param("pluginId")));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "诊断失败"), 500);
    }
  });

  app.get("/api/plugins/dev/surfaces", (context) => {
    try {
      return context.json(facade.listDevSurfaces());
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "surface 列表加载失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/describe-surface", async (context) => {
    const body = (await parseJsonBody(context, {})) as { surfaceId?: unknown };
    const surfaceId = body.surfaceId;
    if (typeof surfaceId !== "string" || surfaceId.trim() === "") {
      return context.json(createApiError("INVALID_INPUT", "需要 surfaceId"), 400);
    }
    try {
      return context.json(facade.describeDevSurface(context.req.param("pluginId"), surfaceId));
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "surface 描述失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/invoke-tool", async (context) => {
    const body = (await parseJsonBody(context, {})) as { devRunId?: unknown; toolName?: unknown; agentId?: unknown; args?: unknown };
    try {
      const result = await facade.invokeDevTool({
        pluginId: context.req.param("pluginId"),
        devRunId: String(body.devRunId ?? ""),
        agentId: String(body.agentId ?? ""),
        toolName: String(body.toolName ?? ""),
        ...(body.args !== undefined ? { args: (body.args ?? {}) as Record<string, unknown> } : {}),
      });
      return context.json(result);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "invoke 失败"), 500);
    }
  });

  app.post("/api/plugins/dev/:pluginId/run-scenario", async (context) => {
    const body = (await parseJsonBody(context, {})) as { devRunId?: unknown; scenarioName?: unknown; agentId?: unknown; destructiveApproved?: unknown };
    try {
      const result = await facade.runDevScenario({
        pluginId: context.req.param("pluginId"),
        devRunId: String(body.devRunId ?? ""),
        scenarioName: String(body.scenarioName ?? ""),
        ...(typeof body.agentId === "string" ? { agentId: body.agentId } : {}),
        approval: body.destructiveApproved === true,
      });
      return context.json(result);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "scenario 失败"), 500);
    }
  });
}
