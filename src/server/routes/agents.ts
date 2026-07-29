import crypto from "node:crypto";

import type { Hono } from "hono";

import { createApiError } from "../../contracts/api-error.js";
import { BASE_COLOR_TEMPLATES } from "../../contracts/base-color-templates.js";
import type { SandboxCapabilities } from "../../contracts/sandbox.js";
import type { AgentStore } from "../../config/agent-store.js";
import type { SessionService } from "../../runtime/session-service.js";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((p) => typeof p === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

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
        createApiError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "Agent 列表加载失败",
        ),
        500,
      );
    }
  });

  // 模板路由必须在 :id 路由之前注册，避免 templates 被当成 agentId
  app.get("/api/agents/templates", (context) => {
    return context.json(BASE_COLOR_TEMPLATES);
  });

  app.post("/api/agents", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (!isRecord(rawBody) || !hasOnlyKeys(rawBody, ["id", "name", "baseColor", "defaultCwd", "sandbox"])) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      // id 可选：提供时校验格式，未提供时服务端生成 UUID
      let agentId: string;
      if (body.id !== undefined) {
        if (typeof body.id !== "string" || !AGENT_ID_PATTERN.test(body.id)) {
          return context.json(createApiError("INVALID_INPUT", "Agent ID 格式无效"), 400);
        }
        agentId = body.id;
      } else {
        agentId = crypto.randomUUID();
      }
      if (
        typeof body.name !== "string" ||
        body.name.trim().length === 0 ||
        body.name.trim().length > 100
      ) {
        return context.json(
          createApiError("INVALID_INPUT", "Agent name 长度必须为 1-100 个字符"),
          400,
        );
      }

      // baseColor 必需（至少是空对象，空白底色合法）
      if (
        body.baseColor === undefined ||
        body.baseColor === null ||
        typeof body.baseColor !== "object" ||
        Array.isArray(body.baseColor)
      ) {
        return context.json(createApiError("INVALID_INPUT", "baseColor 必须是对象"), 400);
      }
      const bc = body.baseColor as Record<string, unknown>;
      if (!hasOnlyKeys(bc, ["persona", "personality", "replyStyle", "innerSetting"])) {
        return context.json(createApiError("INVALID_INPUT", "baseColor 包含不支持的字段"), 400);
      }
      const baseColorInput = {
        persona: typeof bc.persona === "string" ? bc.persona : "",
        personality: isStringArray(bc.personality) ? bc.personality : [],
        replyStyle: typeof bc.replyStyle === "string" ? bc.replyStyle : "",
        innerSetting: typeof bc.innerSetting === "string" ? bc.innerSetting : "",
      };

      // defaultCwd 可选
      let defaultCwd: string | null | undefined;
      if (body.defaultCwd !== undefined) {
        if (body.defaultCwd === null) {
          defaultCwd = null;
        } else if (typeof body.defaultCwd === "string") {
          if (body.defaultCwd.includes("..")) {
            return context.json(
              createApiError("INVALID_INPUT", "defaultCwd 不允许包含 .. 路径"),
              400,
            );
          }
          defaultCwd = body.defaultCwd.trim() === "" ? null : body.defaultCwd;
        } else {
          return context.json(
            createApiError("INVALID_INPUT", "defaultCwd 必须是字符串或 null"),
            400,
          );
        }
      }

      // sandbox 可选
      let sandbox: { extraReadPaths?: string[]; protectedPaths?: string[] } | undefined;
      if (body.sandbox !== undefined) {
        const sb = body.sandbox as Record<string, unknown>;
        sandbox = {};
        if (sb.extraReadPaths !== undefined) {
          if (!isStringArray(sb.extraReadPaths)) {
            return context.json(createApiError("INVALID_INPUT", "sandbox.extraReadPaths 必须是字符串数组"), 400);
          }
          sandbox.extraReadPaths = sb.extraReadPaths as string[];
        }
        if (sb.protectedPaths !== undefined) {
          if (!isStringArray(sb.protectedPaths)) {
            return context.json(createApiError("INVALID_INPUT", "sandbox.protectedPaths 必须是字符串数组"), 400);
          }
          sandbox.protectedPaths = sb.protectedPaths as string[];
        }
      }

      agentStore.create({
        id: agentId,
        name: body.name.trim(),
        baseColor: baseColorInput,
        ...(defaultCwd !== undefined ? { defaultCwd } : {}),
        ...(sandbox ? { sandbox } : {}),
      });
      return context.json(agentStore.load(agentId), 201);
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

  // identity 只能改 name（id/createdAt/version 不可变）
  app.put("/api/agents/:id", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (!isRecord(rawBody) || !hasOnlyKeys(rawBody, ["name"])) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      const patch: { name?: string } = {};
      if (body.name !== undefined) {
        if (
          typeof body.name !== "string" ||
          body.name.trim().length === 0 ||
          body.name.trim().length > 100
        ) {
          return context.json(
            createApiError("INVALID_INPUT", "name 长度必须为 1-100 个字符"),
            400,
          );
        }
        patch.name = body.name.trim();
      }
      if (Object.keys(patch).length === 0) {
        return context.json(createApiError("INVALID_INPUT", "没有可更新的字段"), 400);
      }
      const identity = agentStore.updateIdentity(context.req.param("id"), patch);
      return context.json(agentStore.load(identity.id));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.get("/api/agents/:id/base-color", (context) => {
    try {
      return context.json(agentStore.getBaseColor(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.put("/api/agents/:id/base-color", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (
        !isRecord(rawBody) ||
        !hasOnlyKeys(rawBody, ["persona", "personality", "replyStyle", "innerSetting"])
      ) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      const patch: {
        persona?: string;
        personality?: string[];
        replyStyle?: string;
        innerSetting?: string;
      } = {};

      if (body.persona !== undefined) {
        if (typeof body.persona !== "string") {
          return context.json(createApiError("INVALID_INPUT", "persona 必须是字符串"), 400);
        }
        patch.persona = body.persona;
      }
      if (body.personality !== undefined) {
        if (!isStringArray(body.personality)) {
          return context.json(
            createApiError("INVALID_INPUT", "personality 必须是字符串数组"),
            400,
          );
        }
        patch.personality = body.personality;
      }
      if (body.replyStyle !== undefined) {
        if (typeof body.replyStyle !== "string") {
          return context.json(createApiError("INVALID_INPUT", "replyStyle 必须是字符串"), 400);
        }
        patch.replyStyle = body.replyStyle;
      }
      if (body.innerSetting !== undefined) {
        if (typeof body.innerSetting !== "string") {
          return context.json(
            createApiError("INVALID_INPUT", "innerSetting 必须是字符串"),
            400,
          );
        }
        patch.innerSetting = body.innerSetting;
      }

      agentStore.saveBaseColor(context.req.param("id"), patch);
      return context.json(agentStore.load(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.get("/api/agents/:id/settings", (context) => {
    try {
      return context.json(agentStore.getSettings(context.req.param("id")));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Agent 不存在"), 404);
    }
  });

  app.put("/api/agents/:id/settings", async (context) => {
    try {
      const rawBody = await context.req.json() as unknown;
      if (
        !isRecord(rawBody) ||
        !hasOnlyKeys(rawBody, ["defaultCwd", "extraReadPaths", "protectedPaths"])
      ) {
        return context.json(createApiError("INVALID_INPUT", "请求包含不支持的字段"), 400);
      }
      const body = rawBody;
      const patch: {
        defaultCwd?: string | null;
        sandbox?: SandboxCapabilities;
      } = {};

      // 读取现有 sandbox 避免更新一个字段时清空另一个
      let existingSandbox: SandboxCapabilities | undefined;
      try {
        const s = agentStore.getSettings(context.req.param("id"));
        existingSandbox = s.sandbox;
      } catch { /* 读取失败使用空默认 */ }

      if (body.defaultCwd !== undefined) {
        if (body.defaultCwd === null) {
          patch.defaultCwd = null;
        } else if (typeof body.defaultCwd === "string") {
          if (body.defaultCwd.includes("..")) {
            return context.json(
              createApiError("INVALID_INPUT", "defaultCwd 不允许包含 .. 路径"),
              400,
            );
          }
          patch.defaultCwd = body.defaultCwd.trim() === "" ? null : body.defaultCwd;
        } else {
          return context.json(
            createApiError("INVALID_INPUT", "defaultCwd 必须是字符串或 null"),
            400,
          );
        }
      }

      // sandbox extraReadPaths
      if (body.extraReadPaths !== undefined) {
        if (!isStringArray(body.extraReadPaths)) {
          return context.json(
            createApiError("INVALID_INPUT", "extraReadPaths 必须是字符串数组"),
            400,
          );
        }
        // 拒绝包含 .. 的路径
        if (body.extraReadPaths.some((p: string) => p.includes(".."))) {
          return context.json(
            createApiError("INVALID_INPUT", "extraReadPaths 不允许包含 .. 路径"),
            400,
          );
        }
        patch.sandbox = {
          workspaceAccess: "rw" as const,
          extraReadPaths: body.extraReadPaths as string[],
          protectedPaths: existingSandbox?.protectedPaths ?? [],
        };
      }

      // sandbox protectedPaths
      if (body.protectedPaths !== undefined) {
        if (!isStringArray(body.protectedPaths)) {
          return context.json(
            createApiError("INVALID_INPUT", "protectedPaths 必须是字符串数组"),
            400,
          );
        }
        if (body.protectedPaths.some((p: string) => p.includes(".."))) {
          return context.json(
            createApiError("INVALID_INPUT", "protectedPaths 不允许包含 .. 路径"),
            400,
          );
        }
        patch.sandbox = {
          workspaceAccess: "rw" as const,
          extraReadPaths: existingSandbox?.extraReadPaths ?? [],
          protectedPaths: body.protectedPaths as string[],
        };
      }

      if (Object.keys(patch).length === 0) {
        return context.json(createApiError("INVALID_INPUT", "没有可更新的字段"), 400);
      }
      agentStore.saveSettings(context.req.param("id"), patch);
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
