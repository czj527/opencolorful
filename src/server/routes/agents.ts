import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import type { AgentStore } from "../../config/agent-store.js";
import type { SessionService } from "../../runtime/session-service.js";

export function registerAgentRoutes(
  app: Hono,
  agentStore: AgentStore,
  sessionService?: SessionService,
): void {
  app.get("/api/agents", (context) => {
    try {
      return context.json(agentStore.list());
    } catch (error) {
      return context.json(
        createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Agent 列表加载失败"),
        500,
      );
    }
  });

  app.post("/api/agents", async (context) => {
    try {
      const body = (await context.req.json()) as {
        id?: unknown;
        type?: unknown;
        name?: unknown;
      };
      if (typeof body.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.id)) {
        return context.json(createApiError("INVALID_INPUT", "Agent ID 格式无效"), 400);
      }
      if (body.type !== "assistant" && body.type !== "coding" && body.type !== "work") {
        return context.json(createApiError("INVALID_INPUT", "Agent type 必须为 assistant/coding/work"), 400);
      }
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return context.json(createApiError("INVALID_INPUT", "Agent name 不能为空"), 400);
      }

      const identity = agentStore.create({
        id: body.id,
        type: body.type,
        name: body.name.trim(),
      });
      return context.json(agentStore.load(identity.id), 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "创建失败";
      if (msg.includes("已存在")) {
        return context.json(createApiError("CONFLICT", msg), 409);
      }
      return context.json(createApiError("INVALID_INPUT", msg), 400);
    }
  });

  app.get("/api/agents/:id", (context) => {
    try {
      return context.json(agentStore.load(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.put("/api/agents/:id", async (context) => {
    try {
      const body = (await context.req.json()) as { type?: unknown; name?: unknown };
      const patch: { type?: "assistant" | "coding" | "work"; name?: string } = {};

      if (body.type !== undefined) {
        if (body.type !== "assistant" && body.type !== "coding" && body.type !== "work") {
          return context.json(createApiError("INVALID_INPUT", "type 不合法"), 400);
        }
        patch.type = body.type;
      }
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
          return context.json(createApiError("INVALID_INPUT", "name 不能为空"), 400);
        }
        patch.name = body.name.trim();
      }

      const identity = agentStore.updateIdentity(context.req.param("id"), patch);
      return context.json(agentStore.load(identity.id));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.get("/api/agents/:id/profile", (context) => {
    try {
      const profile = agentStore.getProfile(context.req.param("id"));
      return context.json(profile ?? {});
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.put("/api/agents/:id/profile", async (context) => {
    try {
      const body = (await context.req.json()) as {
        persona?: unknown;
        personality?: unknown;
        replyStyle?: unknown;
      };
      const patch: {
        persona?: string;
        personality?: string[];
        replyStyle?: string;
      } = {};

      if (body.persona !== undefined) {
        if (typeof body.persona !== "string") {
          return context.json(createApiError("INVALID_INPUT", "persona 必须是字符串"), 400);
        }
        patch.persona = body.persona;
      }
      if (body.personality !== undefined) {
        if (!Array.isArray(body.personality) || body.personality.some((p) => typeof p !== "string")) {
          return context.json(createApiError("INVALID_INPUT", "personality 必须是字符串数组"), 400);
        }
        patch.personality = body.personality as string[];
      }
      if (body.replyStyle !== undefined) {
        if (typeof body.replyStyle !== "string") {
          return context.json(createApiError("INVALID_INPUT", "replyStyle 必须是字符串"), 400);
        }
        patch.replyStyle = body.replyStyle;
      }

      agentStore.saveProfile(context.req.param("id"), patch);
      return context.json(agentStore.load(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.post("/api/agents/:id/archive", (context) => {
    try {
      agentStore.archive(context.req.param("id"));
      return context.json({ status: "archived" });
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  if (sessionService !== undefined) {
    app.get("/api/agents/:id/sessions", (context) => {
      try {
        const agentId = context.req.param("id");
        return context.json(sessionService.listByAgent(agentId));
      } catch {
        return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
      }
    });
  }
}
