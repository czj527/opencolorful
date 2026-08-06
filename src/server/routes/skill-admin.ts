import type { Hono } from "hono";

import { type Static, Type } from "typebox";
import Value from "typebox/value";

import { createApiError } from "../../contracts/api-error.js";
import { SkillRefSchema } from "../../contracts/skill-protocol.js";
import type { SkillCoreService } from "../../runtime/skills/core/skill-core-service.js";
import { SourceConfigPatchSchema, type SkillAdminService } from "../../runtime/skills/core/skill-admin-service.js";
import { extractReasonCode } from "../../runtime/skills/core/skill-core-service.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Skill 管理路由（plans/phase-13.md §14.1 / §14.4）
//
// 补充 T6 路由之外的"管理面"端点（来源信任配置 / Linked Source 只读 /
// Bundle 列表与版本化 / 文件树 / 详情正文受控读取 / 学习策略）：
// - 全部输入 TypeBox 显式校验（fail-closed），非法输入 → 400；
// - 领域操作（create-version / 学习策略）委托 SkillCoreService /
//   SkillAdminService（同一 Service 实例，禁止平行逻辑）；
// - 文件树与 Linked Source 状态只返回元数据（路径/大小/哈希），不含正文；
// - 正文读取经 core.inspect 的 loadHandle 路径（绑定 sessionId）。
// ═══════════════════════════════════════════════════════════════

export interface SkillAdminRouteDeps {
  readonly core: SkillCoreService;
  readonly admin: SkillAdminService;
}

const CreateBundleBodySchema = Type.Object(
  {
    bundleId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    items: Type.Array(
      Type.Object(
        {
          skillRef: SkillRefSchema,
          selection: Type.Optional(
            Type.Union([Type.Literal("implicit"), Type.Literal("explicit-only"), Type.Literal("disabled")]),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 256 },
    ),
  },
  { additionalProperties: false },
);
type CreateBundleBody = Static<typeof CreateBundleBodySchema>;

const SkillDetailBodySchema = Type.Object(
  {
    skillRefKey: Type.String({ minLength: 1, maxLength: 512 }),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
type SkillDetailBody = Static<typeof SkillDetailBodySchema>;

const SetPolicyBodySchema = Type.Object(
  {
    policy: Type.Union([Type.Literal("disabled"), Type.Literal("ask-always"), Type.Literal("ask-on-risk")]),
    confirmed: Type.Boolean(),
  },
  { additionalProperties: false },
);
type SetPolicyBody = Static<typeof SetPolicyBodySchema>;

export function registerSkillAdminRoutes(app: Hono, deps: SkillAdminRouteDeps): void {
  const { core, admin } = deps;

  // ── 来源与信任配置（兼容目录默认关闭的信任开关）────────────────

  app.get("/api/skill-sources", (context) => {
    try {
      return context.json(admin.getSourceConfigView());
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "来源配置加载失败"), 500);
    }
  });

  app.put("/api/skill-sources", async (context) => {
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(SourceConfigPatchSchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "来源信任配置补丁非法"), 400);
    }
    try {
      return context.json(admin.updateSourceConfig(body));
    } catch (error) {
      return context.json(
        createApiError("INVALID_INPUT", error instanceof Error ? error.message : "来源配置更新失败", false, {
          reasonCode: extractReasonCode(error),
        }),
        400,
      );
    }
  });

  // ── Linked Source 只读状态（登记/注销仅 CLI）──────────────────

  app.get("/api/skills/linked-sources", (context) => {
    try {
      return context.json(admin.listLinkedSources());
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Linked Source 列表加载失败"), 500);
    }
  });

  // ── Bundle 列表与版本化（§14.1）──────────────────────────────

  app.get("/api/skills/bundles", (context) => {
    try {
      const bundleId = context.req.query("bundleId");
      return context.json(
        admin.listBundles(bundleId !== undefined && bundleId.length > 0 ? bundleId : undefined),
      );
    } catch (error) {
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "Bundle 列表加载失败"), 500);
    }
  });

  app.post("/api/skills/bundles", async (context) => {
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(CreateBundleBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "Bundle 参数非法（name/items 必填）"), 400);
    }
    const raw = body as CreateBundleBody;
    if (raw.bundleId === undefined || raw.bundleId === "") {
      return context.json(createApiError("INVALID_INPUT", "bundleId 必填"), 400);
    }
    try {
      const result = core.manageBundle({
        action: "create-version",
        bundleId: raw.bundleId,
        name: raw.name,
        items: raw.items.map((item) => ({
          skillRef: item.skillRef,
          ...(item.selection !== undefined ? { selection: item.selection } : {}),
        })),
      });
      return context.json(result, result.status === "ok" ? 201 : 200);
    } catch (error) {
      return context.json(
        createApiError("INVALID_INPUT", error instanceof Error ? error.message : "Bundle 版本化失败", false, {
          reasonCode: extractReasonCode(error),
        }),
        400,
      );
    }
  });

  app.post("/api/skills/bundles/:bundleId/versions", async (context) => {
    const bundleId = decodeURIComponent(context.req.param("bundleId"));
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(CreateBundleBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "Bundle 参数非法（name/items 必填）"), 400);
    }
    const raw = body as CreateBundleBody;
    try {
      const result = core.manageBundle({
        action: "create-version",
        bundleId,
        name: raw.name,
        items: raw.items.map((item) => ({
          skillRef: item.skillRef,
          ...(item.selection !== undefined ? { selection: item.selection } : {}),
        })),
      });
      return context.json(result, result.status === "ok" ? 201 : 200);
    } catch (error) {
      return context.json(
        createApiError("INVALID_INPUT", error instanceof Error ? error.message : "Bundle 版本化失败", false, {
          reasonCode: extractReasonCode(error),
        }),
        400,
      );
    }
  });

  // ── 文件树（仅路径/大小，不含正文）────────────────────────────

  app.get("/api/skills/:skillRefKey/files", (context) => {
    try {
      const skillRefKeyOf = decodeURIComponent(context.req.param("skillRefKey"));
      return context.json(admin.getSkillFiles(skillRefKeyOf));
    } catch (error) {
      if (extractReasonCode(error) === "skill_unknown_skillref") {
        return context.json(createApiError("NOT_FOUND", error instanceof Error ? error.message : "Skill 未在 Catalog 中"), 404);
      }
      return context.json(createApiError("INTERNAL_ERROR", error instanceof Error ? error.message : "文件树加载失败"), 500);
    }
  });

  // ── 详情正文（受控读取；绑定 sessionId）───────────────────────

  app.post("/api/skills/detail", async (context) => {
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(SkillDetailBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "详情参数非法（skillRefKey 必填）"), 400);
    }
    const raw = body as SkillDetailBody;
    try {
      return context.json(
        admin.inspectDetail({
          skillRefKey: raw.skillRefKey,
          ...(raw.sessionId !== undefined ? { sessionId: raw.sessionId } : {}),
        }),
      );
    } catch (error) {
      if (extractReasonCode(error) === "skill_unknown_skillref") {
        return context.json(createApiError("NOT_FOUND", error instanceof Error ? error.message : "Skill 未在 Catalog 中"), 404);
      }
      return context.json(
        createApiError("INVALID_INPUT", error instanceof Error ? error.message : "详情读取失败", false, {
          reasonCode: extractReasonCode(error),
        }),
        400,
      );
    }
  });

  // ── 学习策略（UI 内确认流程；同一 AgentSkillService）──────────

  app.put("/api/agents/:agentId/skills/policy", async (context) => {
    const agentId = context.req.param("agentId");
    const body = (await parseJsonBody(context, {})) as unknown;
    if (!Value.Check(SetPolicyBodySchema, body)) {
      return context.json(createApiError("INVALID_INPUT", "学习策略参数非法（policy/confirmed 必填）"), 400);
    }
    const raw = body as SetPolicyBody;
    try {
      const result = admin.setLearningPolicy({ agentId, policy: raw.policy, confirmed: raw.confirmed });
      return context.json(result, result.status === "confirmation_required" ? 202 : 200);
    } catch (error) {
      return context.json(
        createApiError("INVALID_INPUT", error instanceof Error ? error.message : "学习策略更新失败", false, {
          reasonCode: extractReasonCode(error),
        }),
        400,
      );
    }
  });
}

// ── 路由级补丁 Schema 复用 admin 服务的 TypeBox 契约（单一事实） ──

function parseJsonBody(context: { req: { json(): Promise<unknown> } }, fallback: unknown): Promise<unknown> {
  return context.req.json().catch(() => fallback);
}
