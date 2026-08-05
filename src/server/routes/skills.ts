import type { Hono } from "hono";

import { type Static, Type } from "typebox";
import Value from "typebox/value";

import { createApiError } from "../../contracts/api-error.js";
import { SkillRefSchema } from "../../contracts/skill-protocol.js";
import type { SkillCoreService } from "../../runtime/skills/core/skill-core-service.js";
import {
  SkillInstallSourceKindSchema,
  SkillManageArgsSchema,
  SkillSearchArgsSchema,
  type SkillInstallResult,
} from "../../runtime/skills/core/skill-core-service.js";
import { extractReasonCode } from "../../runtime/skills/core/skill-core-service.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 Skill Server API（plans/phase-13.md §14.1 / §18.5）
//
// - 只做解析/校验/调用与状态码，业务在 SkillCoreService（工具与 API 同一 Service）；
// - 所有输入 TypeBox 显式校验（fail-closed），非法输入 → 400 不进入领域层；
// - API 不接受正文作为安装输入（sourceRef 只是完整 package 来源标识）；
//   不接受客户端任意绝对路径（local/archive 必须落在信任根内，
//   session-file 必须已登记 fileKey）；
// - 安装结果四态：installed → 201 / confirmation_required → 202 /
//   rejected → 403 / failed → 400（details.reasonCode 稳定诊断）；
// - 确认审批：POST /api/skills/confirmation/:tokenId/approve。
// ═══════════════════════════════════════════════════════════════

export interface SkillRouteDeps {
  readonly core: SkillCoreService;
}

function parseJsonBody(context: { req: { json(): Promise<unknown> } }, fallback: unknown): Promise<unknown> {
  return context.req.json().catch(() => fallback);
}

// ── 请求体 Schema（跨边界 TypeBox）─────────────────────────────

const SearchBodySchema = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 256 })),
    scope: Type.Optional(
      Type.Union([
        Type.Literal("bound"),
        Type.Literal("managed"),
        Type.Literal("workspace"),
        Type.Literal("plugin"),
        Type.Literal("remote"),
        Type.Literal("all"),
      ]),
    ),
  },
  { additionalProperties: false },
);
type SearchBody = Static<typeof SearchBodySchema>;

const InspectBodySchema = Type.Object(
  {
    sourceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    kind: Type.Optional(SkillInstallSourceKindSchema),
    skillRef: Type.Optional(SkillRefSchema),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
type InspectBody = Static<typeof InspectBodySchema>;

const InstallBodySchema = Type.Object(
  {
    sourceRef: Type.String({ minLength: 1, maxLength: 512 }),
    kind: SkillInstallSourceKindSchema,
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    /** 用户确认后的一次性确认令牌 */
    confirmationToken: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
type InstallBody = Static<typeof InstallBodySchema>;

const ApproveBodySchema = Type.Object(
  {
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
type ApproveBody = Static<typeof ApproveBodySchema>;

const AgentSkillsBodySchema = Type.Object(
  {
    action: SkillManageArgsSchema.properties.action,
    skillRef: Type.Optional(SkillRefSchema),
    skillRefKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    selection: Type.Optional(
      Type.Union([Type.Literal("implicit"), Type.Literal("explicit-only"), Type.Literal("disabled")]),
    ),
    confirmationToken: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
type AgentSkillsBody = Static<typeof AgentSkillsBodySchema>;

const SessionSkillsBodySchema = Type.Object(
  {
    skillRef: SkillRefSchema,
    selection: Type.Optional(
      Type.Union([Type.Literal("implicit"), Type.Literal("explicit-only"), Type.Literal("disabled")]),
    ),
    ttlMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400_000 })),
  },
  { additionalProperties: false },
);
type SessionSkillsBody = Static<typeof SessionSkillsBodySchema>;

function rejectDetails(reasonCode: string, reason: string): { reasonCode: string; reason: string } {
  return { reasonCode, reason };
}

/**
 * Phase 13 Skill 路由。deps 由 T10 组合根注入（app.ts 条件接线：
 * skillCoreService 存在时才注册）。
 */
export function registerSkillRoutes(app: Hono, deps: SkillRouteDeps): void {
  const { core } = deps;

  // ── 目录 / 详情 ─────────────────────────────────────────────

  app.get("/api/skills", (context) => {
    try {
      const url = new URL(context.req.url);
      const sourceKind = url.searchParams.get("sourceKind");
      const query = url.searchParams.get("query");
      const result = core.listCatalog({
        ...(sourceKind !== null && sourceKind.length > 0
          ? { sourceKind: sourceKind as import("../../contracts/skill-protocol.js").SkillSourceKind }
          : {}),
        ...(query !== null && query.length > 0 ? { query } : {}),
      });
      return context.json(result);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Skill 列表加载失败"), 500);
    }
  });

  app.get("/api/skills/:skillRefKey", (context) => {
    try {
      const skillRefKey = decodeURIComponent(context.req.param("skillRefKey"));
      const detail = core.getSkillDetail(skillRefKey);
      if (detail === null) {
        return context.json(createApiError("NOT_FOUND", "SkillRef 未在 Catalog 中"), 404);
      }
      return context.json(detail);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Skill 详情加载失败"), 500);
    }
  });

  // ── 搜索 / 检查 / 安装 / 确认 ───────────────────────────────

  app.post("/api/skills/search", async (context) => {
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(SearchBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "搜索参数非法（query/scope）"), 400);
    }
    try {
      const raw = body as SearchBody;
      return context.json(
        core.search({
          ...(raw.query !== undefined ? { query: raw.query } : {}),
          ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
        }),
      );
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Skill 搜索失败"), 500);
    }
  });

  app.post("/api/skills/inspect", async (context) => {
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(InspectBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "检查参数非法（sourceRef/kind/skillRef/sessionId）"), 400);
    }
    try {
      const raw = body as InspectBody;
      const result = await core.inspect({
        ...(raw.sourceRef !== undefined ? { sourceRef: raw.sourceRef } : {}),
        ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
        ...(raw.skillRef !== undefined ? { skillRef: raw.skillRef } : {}),
        ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : {}),
      });
      if (!result.ok) {
        return context.json(
          createApiError("INVALID_INPUT", result.reason ?? "来源检查失败", false, {
            reasonCode: result.reasonCode ?? "skill_operation_failed",
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          }),
          400,
        );
      }
      return context.json(result);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "来源检查失败"), 500);
    }
  });

  app.post("/api/skills/install", async (context) => {
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(InstallBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "安装参数非法（sourceRef/kind 必填）"), 400);
    }
    const raw = body as InstallBody;
    try {
      const result = core.install({
        sourceRef: raw.sourceRef,
        kind: raw.kind,
        ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : {}),
        ...(raw.agentId !== undefined ? { agentId: raw.agentId } : {}),
        ...(raw.confirmationToken !== undefined ? { confirmationToken: raw.confirmationToken } : {}),
      });
      // 安装结果四态 → HTTP 状态码（结构化四态，前端按 status 判断，不看模糊文本）
      switch (result.status) {
        case "installed":
          return context.json(result, 201);
        case "confirmation_required":
          return context.json(result, 202);
        case "rejected":
          return context.json(
            createApiError("UNAUTHORIZED", result.reason ?? "安装被拒绝", false, {
              reasonCode: result.reasonCode ?? "skill_agent_unauthorized",
              ...(result.reason !== undefined ? { reason: result.reason } : {}),
            }),
            403,
          );
        case "failed":
          return context.json(
            createApiError("INVALID_INPUT", result.reason ?? "安装失败", false, {
              reasonCode: result.reasonCode ?? "skill_operation_failed",
              ...(result.reason !== undefined ? { reason: result.reason } : {}),
            }),
            400,
          );
      }
    } catch (error) {
      return context.json(
        createApiError("INVALID_INPUT", error instanceof Error ? error.message : "安装失败", false, {
          reasonCode: extractReasonCode(error),
        }),
        400,
      );
    }
  });

  app.post("/api/skills/confirmation/:tokenId/approve", async (context) => {
    const token = decodeURIComponent(context.req.param("tokenId"));
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(ApproveBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "确认参数非法（agentId/sessionId）"), 400);
    }
    const raw = body as ApproveBody;
    try {
      const result = core.approveConfirmation({
        token,
        ...(raw.agentId !== undefined ? { agentId: raw.agentId } : {}),
        ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : {}),
      });
      if (result.status === "rejected") {
        if (result.reasonCode === "skill_confirmation_target_mismatch" && result.reason.includes("不存在")) {
          return context.json(createApiError("NOT_FOUND", result.reason), 404);
        }
        return context.json(createApiError("CONFLICT", result.reason, false, rejectDetails(result.reasonCode, result.reason)), 409);
      }
      return context.json({ status: "approved" });
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "确认失败"), 500);
    }
  });

  // ── Agent Skill 绑定 / 选择 ─────────────────────────────────

  app.get("/api/agents/:agentId/skills", (context) => {
    try {
      const agentId = context.req.param("agentId");
      const result = core.manageSkills({ action: "list", agentId });
      if (result.status !== "ok") {
        return context.json(createApiError("INTERNAL_ERROR", result.reason ?? "Agent Skill 列表加载失败"), 500);
      }
      return context.json(result);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Agent Skill 列表加载失败"), 500);
    }
  });

  app.put("/api/agents/:agentId/skills", async (context) => {
    const agentId = context.req.param("agentId");
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(AgentSkillsBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "Agent Skill 参数非法"), 400);
    }
    const raw = body as AgentSkillsBody;
    try {
      const result = core.manageSkills({
        action: raw.action,
        agentId,
        ...(raw.skillRef !== undefined ? { skillRef: raw.skillRef } : {}),
        ...(raw.skillRefKey !== undefined ? { skillRefKey: raw.skillRefKey } : {}),
        ...(raw.selection !== undefined ? { selection: raw.selection } : {}),
        ...(raw.confirmationToken !== undefined ? { confirmationToken: raw.confirmationToken } : {}),
      });
      return context.json(result);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Agent Skill 变更失败"), 500);
    }
  });

  // ── Session 临时绑定 ────────────────────────────────────────

  app.get("/api/sessions/:sessionId/skills", (context) => {
    try {
      const view = core.listSessionSkills(context.req.param("sessionId"));
      return context.json(view);
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Session Skill 列表加载失败"), 500);
    }
  });

  app.post("/api/sessions/:sessionId/skills", async (context) => {
    const sessionId = context.req.param("sessionId");
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(SessionSkillsBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "Session Skill 参数非法（skillRef 必填）"), 400);
    }
    const raw = body as SessionSkillsBody;
    try {
      const result = core.bindTemporarySessionSkill(sessionId, {
        skillRef: raw.skillRef,
        ...(raw.selection !== undefined ? { selection: raw.selection } : {}),
        ...(raw.ttlMs !== undefined ? { ttlMs: raw.ttlMs } : {}),
      });
      return context.json(result, 201);
    } catch (error) {
      return context.json(
        createApiError("INVALID_INPUT", error instanceof Error ? error.message : "Session 临时绑定失败", false, {
          reasonCode: extractReasonCode(error),
        }),
        400,
      );
    }
  });
}
