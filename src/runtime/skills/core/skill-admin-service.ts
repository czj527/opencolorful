import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { type Static, Type } from "typebox";
import Value from "typebox/value";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceKind } from "../../../contracts/skill-protocol.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import { skillRefKey } from "../../../contracts/skill-protocol.js";
import { SkillError } from "../errors.js";
import { walkSafeFiles } from "../path-safety.js";
import { SkillSourceTrustStore, type SkillSourcesConfig } from "../sources/trust-config.js";
import { workspaceCompatibilityRoots } from "../sources/workspace-roots.js";
import { LinkedSourceRegistry, type LinkedSourceStatus } from "../sources/linked-source-registry.js";
import type { SkillCoreService, SkillInspectResult } from "./skill-core-service.js";
import type { AgentSkillService } from "../binding/skill-binding-service.js";
import type { SkillBundleService } from "../bundles/skill-bundle-service.js";
import type { SkillLearningPolicy } from "../agent/agent-skill-config.js";
import { SKILL_LEARNING_POLICIES } from "../agent/agent-skill-config.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Skill 管理 Service（plans/phase-13.md §14.1 / §14.4）
//
// 管理页（Web /skills）与 CLI doctor 的管理只读/配置视图编排层。原则：
// - 领域操作（安装/绑定/解绑/选择/迁移）一律委托 SkillCoreService /
//   AgentSkillService / SkillBundleService（同一实例，禁止平行逻辑）；
// - 本服务只新增"管理面"能力：来源信任配置读写、Linked Source 只读状态、
//   Bundle 列表、Skill 文件树（仅路径/大小，不含内容）、详情正文受控读取、
//   学习策略设置（UI 内确认流程，§14.4 允许，不引入第二套确认令牌）；
// - 跨边界输入/输出过 TypeBox（fail-closed）。
// ═══════════════════════════════════════════════════════════════

// ── 管理面 Schema ──────────────────────────────────────────────

export const SourceConfigPatchSchema = Type.Object(
  {
    trustedRoots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64 })),
    disabledKinds: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("builtin"),
          Type.Literal("managed"),
          Type.Literal("plugin"),
          Type.Literal("workspace"),
          Type.Literal("external"),
        ]),
        { maxItems: 8 },
      ),
    ),
    trustedSourceIds: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 512 }), Type.Literal(true), { maxProperties: 128 }),
    ),
  },
  { additionalProperties: false },
);
export type SourceConfigPatch = Static<typeof SourceConfigPatchSchema>;

export const CompatibilityRootViewSchema = Type.Object(
  {
    root: Type.String({ minLength: 1, maxLength: 1024 }),
    exists: Type.Boolean(),
    trusted: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CompatibilityRootView = Static<typeof CompatibilityRootViewSchema>;

export const SourceConfigViewSchema = Type.Object(
  {
    config: Type.Object(
      {
        version: Type.Literal(1),
        trustedRoots: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64 }),
        disabledKinds: Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 8 }),
        trustedSourceIds: Type.Record(Type.String({ minLength: 1, maxLength: 512 }), Type.Boolean(), { maxProperties: 128 }),
      },
      { additionalProperties: false },
    ),
    compatibilityRoots: Type.Array(CompatibilityRootViewSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** 管理面来源配置视图（TypeBox 输出契约见 SourceConfigViewSchema；本接口保持 readonly）。 */
export interface SourceConfigView {
  readonly config: SkillSourcesConfig;
  readonly compatibilityRoots: readonly CompatibilityRootView[];
}

export const LinkedSourceStatusSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 256 }),
    rootPath: Type.String({ minLength: 1, maxLength: 1024 }),
    linkedAt: Type.String({ minLength: 1, maxLength: 64 }),
    valid: Type.Boolean(),
    skillName: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    version: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    contentHash: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    sizeBytes: Type.Integer({ minimum: 0 }),
    fileCount: Type.Integer({ minimum: 0 }),
    errors: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type LinkedSourceStatusView = Static<typeof LinkedSourceStatusSchema>;

export const SkillFileEntrySchema = Type.Object(
  {
    rel: Type.String({ minLength: 1, maxLength: 512 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SkillFileTreeSchema = Type.Object(
  {
    skillRefKey: Type.String({ minLength: 1, maxLength: 512 }),
    files: Type.Array(SkillFileEntrySchema, { maxItems: 4096 }),
  },
  { additionalProperties: false },
);
export type SkillFileTree = Static<typeof SkillFileTreeSchema>;

export const SkillDetailResultSchema = Type.Object(
  {
    view: Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Unknown(), { maxProperties: 64 }),
    body: Type.Optional(Type.String({ maxLength: 262144 })),
    truncated: Type.Optional(Type.Boolean()),
    bodyUnavailable: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type SkillDetailResult = Static<typeof SkillDetailResultSchema>;

export const BundleAdminViewSchema = Type.Object(
  {
    bundleId: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    versions: Type.Array(
      Type.Object(
        {
          version: Type.String({ minLength: 1, maxLength: 64 }),
          contentHash: Type.String({ minLength: 1, maxLength: 64 }),
          createdAt: Type.String({ minLength: 1, maxLength: 64 }),
          itemCount: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 256 },
    ),
  },
  { additionalProperties: false },
);
export type BundleAdminView = Static<typeof BundleAdminViewSchema>;

export const BundleListSchema = Type.Object(
  {
    bundles: Type.Array(BundleAdminViewSchema, { maxItems: 256 }),
  },
  { additionalProperties: false },
);
export type BundleList = Static<typeof BundleListSchema>;

export const SetLearningPolicyInputSchema = Type.Object(
  {
    policy: Type.Union([Type.Literal("disabled"), Type.Literal("ask-always"), Type.Literal("ask-on-risk")]),
    /** UI 内确认流程（§14.4）：用户确认后置 true，服务端按确认后路径执行 */
    confirmed: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SetLearningPolicyInput = Static<typeof SetLearningPolicyInputSchema>;

export interface SkillAdminServiceDeps {
  readonly paths: RuntimePaths;
  readonly trustStore: SkillSourceTrustStore;
  readonly linkedSources: LinkedSourceRegistry;
  readonly core: SkillCoreService;
  readonly agentService: AgentSkillService;
  readonly bundleService: SkillBundleService;
  readonly catalog: SkillCatalog;
  readonly db?: import("better-sqlite3").Database;
}

export class SkillAdminService {
  constructor(private readonly deps: SkillAdminServiceDeps) {}

  // ── 来源与信任配置（兼容目录默认关闭；信任开关）───────────────

  getSourceConfigView(): SourceConfigView {
    const config = this.deps.trustStore.load();
    const roots = workspaceCompatibilityRoots(process.cwd(), this.deps.paths.home).map((root) => ({
      root,
      exists: directoryExists(root),
      trusted: this.deps.trustStore.load().trustedRoots.some((trusted) => isWithin(root, trusted)),
    }));
    return { config, compatibilityRoots: roots };
  }

  /** 合并更新信任配置（只接受白名单字段；写回同一配置文档）。 */
  updateSourceConfig(input: unknown): SourceConfigView {
    if (!Value.Check(SourceConfigPatchSchema, input)) {
      throw new SkillError("skill_operation_failed", "来源信任配置补丁非法（trustedRoots/disabledKinds/trustedSourceIds）");
    }
    const patch = input as SourceConfigPatch;
    const current = this.deps.trustStore.load();
    const next: SkillSourcesConfig = {
      version: 1,
      trustedRoots:
        patch.trustedRoots !== undefined
          ? [...new Set(patch.trustedRoots.map((root) => path.resolve(root)))]
          : [...current.trustedRoots],
      disabledKinds:
        patch.disabledKinds !== undefined
          ? [...new Set(patch.disabledKinds)]
          : [...current.disabledKinds],
      trustedSourceIds:
        patch.trustedSourceIds !== undefined
          ? { ...current.trustedSourceIds, ...patch.trustedSourceIds }
          : { ...current.trustedSourceIds },
    };
    this.deps.trustStore.save(next);
    return this.getSourceConfigView();
  }

  // ── Linked Source 只读状态（登记/注销仅 CLI）──────────────────

  listLinkedSources(): readonly LinkedSourceStatusView[] {
    return this.deps.linkedSources.list().map(toLinkedSourceView);
  }

  // ── Skill 文件树（仅路径/大小，不返回内容）────────────────────

  getSkillFiles(skillRefKeyInput: string): SkillFileTree {
    const registered = this.deps.catalog.list({}).find((skill) => skillRefKey(skill.skillRef) === skillRefKeyInput);
    if (registered === undefined) {
      throw new SkillError("skill_unknown_skillref", `SkillRef 未在 Catalog 中：${skillRefKeyInput}`);
    }
    const entries = walkSafeFiles(registered.rootPath);
    return {
      skillRefKey: skillRefKeyInput,
      files: entries.map((entry) => ({ rel: entry.rel, sizeBytes: entry.sizeBytes })),
    };
  }

  // ── Skill 详情（正文受控读取：经 core.inspect 的 loadHandle 路径）──

  inspectDetail(input: { readonly skillRefKey: string; readonly sessionId?: string }): SkillDetailResult {
    const registered = this.deps.catalog.list({}).find((skill) => skillRefKey(skill.skillRef) === input.skillRefKey);
    if (registered === undefined) {
      throw new SkillError("skill_unknown_skillref", `SkillRef 未在 Catalog 中：${input.skillRefKey}`);
    }
    const detail = this.deps.core.getSkillDetail(input.skillRefKey);
    if (detail === null) {
      throw new SkillError("skill_unknown_skillref", `SkillRef 未在 Catalog 中：${input.skillRefKey}`);
    }
    const bodyUnavailable = input.sessionId === undefined || input.sessionId.trim() === ""
      ? "正文读取需要在会话上下文内进行（loadHandle 绑定 sessionId）"
      : undefined;
    let body: string | undefined;
    let truncated: boolean | undefined;
    if (bodyUnavailable === undefined) {
      const inspected: SkillInspectResult = this.deps.core.inspect({
        skillRef: registered.skillRef,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        readBody: true,
      }) as unknown as SkillInspectResult;
      if (inspected.ok && inspected.body !== undefined) {
        body = inspected.body;
        truncated = inspected.truncated;
      }
    }
    const result: SkillDetailResult = {
      view: detail as unknown as Record<string, unknown>,
      ...(body !== undefined ? { body } : {}),
      ...(truncated !== undefined ? { truncated } : {}),
      ...(bodyUnavailable !== undefined ? { bodyUnavailable } : {}),
    };
    return result;
  }

  // ── Bundle 列表（管理页）────────────────────────────────────

  listBundles(bundleId?: string): BundleList {
    const ids = this.collectBundleIds(bundleId);
    const bundles: BundleAdminView[] = ids.map((id) => {
      const versions = this.deps.bundleService.listBundleVersions(id);
      const latest = versions[versions.length - 1];
      return {
        bundleId: id,
        name: latest?.name ?? id,
        versions: versions.map((record) => ({
          version: record.version,
          contentHash: record.contentHash,
          createdAt: record.createdAt,
          itemCount: record.items.length,
        })),
      };
    });
    bundles.sort((a, b) => (a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0));
    return { bundles };
  }

  // ── 学习策略（UI 内确认流程；同一 AgentSkillService 单一事实）──

  setLearningPolicy(input: { readonly agentId: string; readonly policy: SkillLearningPolicy; readonly confirmed: boolean }): { readonly status: "changed" | "confirmation_required"; readonly agentId: string; readonly policy?: SkillLearningPolicy; readonly reason?: string } {
    if (!SKILL_LEARNING_POLICIES.includes(input.policy)) {
      throw new SkillError("skill_operation_failed", `不支持的学习策略：${String(input.policy)}`);
    }
    const result = this.deps.agentService.setLearningPolicy({
      agentId: input.agentId,
      policy: input.policy,
      confirmed: input.confirmed,
      actor: { kind: "user", id: "skills-admin-ui" },
    });
    if (result.status === "confirmation_required") {
      return { status: "confirmation_required", agentId: input.agentId, reason: result.reason };
    }
    return { status: "changed", agentId: input.agentId, policy: result.policy };
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private collectBundleIds(bundleId: string | undefined): readonly string[] {
    if (bundleId !== undefined && bundleId !== "") {
      return [bundleId];
    }
    if (this.deps.db === undefined) {
      return [];
    }
    const rows = this.deps.db.prepare("SELECT DISTINCT bundle_id AS id FROM skill_bundles ORDER BY bundle_id").all() as readonly { readonly id: string }[];
    return rows.map((row) => row.id);
  }
}

// ── 模块级辅助 ─────────────────────────────────────────────────

function toLinkedSourceView(entry: LinkedSourceStatus): LinkedSourceStatusView {
  return {
    sourceId: entry.sourceId,
    rootPath: entry.rootPath,
    linkedAt: entry.linkedAt,
    valid: entry.valid,
    skillName: entry.skillName,
    version: entry.version,
    contentHash: entry.contentHash,
    sizeBytes: entry.sizeBytes,
    fileCount: entry.fileCount,
    errors: [...entry.errors],
  };
}

function directoryExists(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
