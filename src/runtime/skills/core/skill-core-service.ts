import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type Static, Type } from "typebox";
import Value from "typebox/value";

import type { ActorRef, EventScope, ExecutorRef } from "../../../contracts/observability.js";
import {
  SKILL_ERROR_CODES,
  SkillCompatibilityReportSchema,
  SkillProvenanceSchema,
  SkillRefSchema,
  SkillStatusSchema,
  skillRefKey,
  type SkillCompatibilityReport,
  type SkillErrorCode,
  type SkillProvenance,
  type SkillReadiness,
  type SkillRef,
  type SkillSelectionMode,
  type SkillSourceKind,
  type SkillStatus,
} from "../../../contracts/skill-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import type { SkillCatalog, RegisteredSkill } from "../catalog/skill-catalog.js";
import type { AgentSkillService } from "../binding/skill-binding-service.js";
import type { SkillBundleService } from "../bundles/skill-bundle-service.js";
import { SkillError } from "../errors.js";
import { diagnoseReadiness } from "../readiness.js";
import type { SkillContentService } from "../content/skill-content-service.js";
import type { LoadHandleRegistry } from "../content/load-handle.js";
import type { SkillSnapshotService, SkillSnapshot } from "../snapshot/skill-snapshot.js";
import type { SkillInstaller } from "../installer/skill-installer.js";
import { type SkillInstallSourceKind } from "../installer/stager.js";
import { assessPackageRisks, type SkillRiskMarker } from "../installer/risk.js";
import type { SessionFileRegistry } from "../installer/session-file-registry.js";
import type { SkillSourceAdapter, SkillSourceInspection } from "../sources/skill-source-adapter.js";
import type { SkillTrustPolicy } from "../sources/trust-config.js";
import { WorkspaceSkillSource } from "../sources/workspace-source.js";
import { buildPiSkillsFromSnapshot } from "../../../pi-sdk/skill-loader.js";
import type { PiResourceSkills, SkillFileReadOutcome } from "../../../pi-sdk/types.js";
import type { SkillLearningPolicy } from "../agent/agent-skill-config.js";
import type { SessionSkillService } from "../session/session-skill-service.js";
import type { ConfirmationTarget } from "../confirmation/confirmation-token.js";
import { ConfirmationTokenRegistry, ConfirmationViewSchema, type ConfirmationView } from "../confirmation/confirmation-token.js";
import type { ReadinessEnvironment } from "../readiness.js";
import type { ResolutionDiagnostic } from "../resolver.js";

/**
 * T11（P1-7）：无 Agent Session 的快照 agentId 占位。
 * SkillSnapshot 契约拒绝空 agentId（§10.2 身份字段必填），无 Agent 会话
 * 以该哨兵值标识，语义为"会话未绑定 Agent"，不伪造任何真实 Agent 身份。
 */
export const ANONYMOUS_AGENT_ID = "@anonymous";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 Skill Core Service（plans/phase-13.md §11 / §14.2 / §13.3）
//
// 会话内五个 Core 工具与 Server API 共用的唯一编排层：
//   inspect → stage → validate → canonicalize/hash → safety review
//   → risk decision → one-time confirmation (if required)
//   → install immutable artifact → bind current Agent/Session
//   → activation grant overlay → loadHandle（当前 turn 受控读取）
//
// 安全承诺：
// - 工具/API 只接受完整 package 来源；session-file 必须已登记 fileKey；
// - local/archive 的 sourceRef 是服务端路径，必须落在信任根内（拒绝客户端
//   任意绝对路径）；git/http 是 URL，默认 untrusted 需确认；
// - 学习策略三档：disabled → 拒绝安装；ask-always → 必确认；
//   ask-on-risk（默认）→ 低风险可信来源直接装，其余确认；
// - 确认令牌一次性 + 绑定目标（sourceRef/version/contentHash/agent/session/
//   操作类型/过期），consume 失败返回稳定 reasonCode；
// - 搜索结果缺 Skill 绝不递归触发安装（搜索与安装是两个独立动作）；
// - 结果一律结构化（status 四态 + reasonCode），模型不能凭模糊文本推断成功；
// - 事件：skill.inspect.* / skill.install.confirmation_requested/confirmed/
//   rejected（activity），经 Phase 11 既有 SSE 链路投影（不新建广播机制）。
// ═══════════════════════════════════════════════════════════════

// ── 工具参数 Schema（跨边界 TypeBox；pi-sdk 与路由共用）────────────

export const SkillSearchScopeSchema = Type.Union([
  Type.Literal("bound"),
  Type.Literal("managed"),
  Type.Literal("workspace"),
  Type.Literal("plugin"),
  Type.Literal("remote"),
  Type.Literal("all"),
]);
export type SkillSearchScope = Static<typeof SkillSearchScopeSchema>;

export const SkillSearchArgsSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 256 })),
    scope: Type.Optional(SkillSearchScopeSchema),
  },
  { additionalProperties: false },
);
export type SkillSearchArgs = Static<typeof SkillSearchArgsSchema>;

export const SkillInstallSourceKindSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("archive"),
  Type.Literal("git"),
  Type.Literal("http"),
  Type.Literal("session-file"),
]);

export const SkillInspectArgsSchema = Type.Object(
  {
    sourceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    kind: Type.Optional(SkillInstallSourceKindSchema),
    skillRef: Type.Optional(SkillRefSchema),
    readBody: Type.Optional(Type.Boolean()),
    /**
     * T12（P0-2）：readBody=true 时优先消费的 loadHandle（会话内安装结果返回的
     * 一次性句柄）。提供时经 LoadHandleRegistry 消费后受控读取；未提供时维持
     * 原有路径（activation grant overlay 或按需签发）。安装返回的 loadHandle
     * 因此有明确消费链，不再成为无消费者的孤儿句柄。
     */
    loadHandle: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type SkillInspectArgs = Static<typeof SkillInspectArgsSchema>;

export const SkillInstallArgsSchema = Type.Object(
  {
    sourceRef: Type.String({ minLength: 1, maxLength: 512 }),
    kind: SkillInstallSourceKindSchema,
    /** 用户确认后的一次性确认令牌（重试安装时携带） */
    confirmationToken: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type SkillInstallArgs = Static<typeof SkillInstallArgsSchema>;

export const SkillManageActionSchema = Type.Union([
  Type.Literal("list"),
  Type.Literal("set-selection"),
  Type.Literal("bind"),
  Type.Literal("unbind"),
  Type.Literal("request-unbind"),
]);

export const SkillManageArgsSchema = Type.Object(
  {
    action: SkillManageActionSchema,
    skillRef: Type.Optional(SkillRefSchema),
    skillRefKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    selection: Type.Optional(
      Type.Union([Type.Literal("implicit"), Type.Literal("explicit-only"), Type.Literal("disabled")]),
    ),
    confirmationToken: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type SkillManageArgs = Static<typeof SkillManageArgsSchema>;

export const SkillBundleActionSchema = Type.Union([
  Type.Literal("list"),
  Type.Literal("create-version"),
  Type.Literal("bind"),
  Type.Literal("migrate"),
]);

export const SkillBundleManageArgsSchema = Type.Object(
  {
    action: SkillBundleActionSchema,
    bundleId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    items: Type.Optional(
      Type.Array(
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
    ),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    fromVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    toVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    confirmationToken: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type SkillBundleManageArgs = Static<typeof SkillBundleManageArgsSchema>;

// ── 结果 Schema（跨边界结构化输出；模型不能靠自由文本推断）──────────

export const SkillRiskMarkerSchema = Type.Object(
  {
    code: Type.Union([Type.Literal("scripts"), Type.Literal("binary"), Type.Literal("unknown-file-type")]),
    message: Type.String({ minLength: 1, maxLength: 512 }),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

/** 稳定 reasonCode 运行时 Schema（跨边界校验用；静态类型见 SkillErrorCode）。 */
export const SkillErrorCodeSchema = Type.Union(SKILL_ERROR_CODES.map((c) => Type.Literal(c)) as never);

export const SafeSkillViewSchema = Type.Object(
  {
    skillRef: SkillRefSchema,
    skillRefKey: Type.String({ minLength: 1, maxLength: 512 }),
    skillId: Type.String({ minLength: 1, maxLength: 128 }),
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 2048 })),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    sourceId: Type.String({ minLength: 1, maxLength: 1024 }),
    sourceKind: Type.Union([
      Type.Literal("builtin"),
      Type.Literal("managed"),
      Type.Literal("plugin"),
      Type.Literal("workspace"),
      Type.Literal("external"),
    ]),
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
    sizeBytes: Type.Integer({ minimum: 0 }),
    fileCount: Type.Integer({ minimum: 0 }),
    status: SkillStatusSchema,
    compatibility: Type.Union([SkillCompatibilityReportSchema, Type.Null()]),
    provenance: Type.Union([SkillProvenanceSchema, Type.Null()]),
    validityErrors: Type.Array(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);
export interface SafeSkillView {
  readonly skillRef: SkillRef;
  readonly skillRefKey: string;
  readonly skillId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly version: string;
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly status: SkillStatus;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly provenance: SkillProvenance | null;
  readonly validityErrors: readonly string[];
}

export const SkillSearchHitSchema = Type.Object(
  {
    layer: Type.Union([
      Type.Literal("bound"),
      Type.Literal("managed"),
      Type.Literal("workspace"),
      Type.Literal("plugin"),
      Type.Literal("remote"),
    ]),
    sourceKind: Type.Union([
      Type.Literal("builtin"),
      Type.Literal("managed"),
      Type.Literal("plugin"),
      Type.Literal("workspace"),
      Type.Literal("external"),
    ]),
    skillId: Type.String({ minLength: 1, maxLength: 128 }),
    skillRefKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 2048 })),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    sourceId: Type.String({ minLength: 1, maxLength: 1024 }),
    contentHash: Type.String({ minLength: 1, maxLength: 64 }),
    skillRef: Type.Optional(SkillRefSchema),
    pinned: Type.Optional(Type.Boolean()),
    status: Type.Optional(SkillStatusSchema),
    compatibility: Type.Optional(Type.Union([SkillCompatibilityReportSchema, Type.Null()])),
    readiness: Type.Optional(
      Type.Union([Type.Literal("ready"), Type.Literal("degraded"), Type.Literal("blocked"), Type.Literal("incompatible")]),
    ),
    risks: Type.Optional(Type.Array(SkillRiskMarkerSchema, { maxItems: 64 })),
    /** 已登记（可直接 bind）还是需要先 install */
    bindable: Type.Boolean(),
    installHint: Type.Optional(
      Type.Object(
        {
          sourceRef: Type.String({ minLength: 1, maxLength: 512 }),
          kind: SkillInstallSourceKindSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export interface SkillSearchHit {
  readonly layer: "bound" | "managed" | "workspace" | "plugin" | "remote";
  readonly sourceKind: SkillSourceKind;
  readonly skillId: string;
  readonly skillRefKey?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly version: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly skillRef?: SkillRef;
  readonly pinned?: boolean;
  readonly status?: SkillStatus;
  readonly compatibility?: SkillCompatibilityReport | null;
  readonly readiness?: SkillReadiness;
  readonly risks?: readonly SkillRiskMarker[];
  readonly bindable: boolean;
  readonly installHint?: { readonly sourceRef: string; readonly kind: SkillInstallSourceKind };
}

export const SkillSearchResultSchema = Type.Object(
  {
    layers: Type.Array(
      Type.Union([
        Type.Literal("bound"),
        Type.Literal("managed"),
        Type.Literal("workspace"),
        Type.Literal("plugin"),
        Type.Literal("remote"),
      ]),
    ),
    hits: Type.Array(SkillSearchHitSchema, { maxItems: 256 }),
    diagnostics: Type.Array(
      Type.Object(
        {
          code: SkillErrorCodeSchema,
          message: Type.String({ minLength: 1, maxLength: 512 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    remote: Type.Object(
      {
        available: Type.Boolean(),
        note: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export interface SkillSearchResult {
  readonly layers: readonly ("bound" | "managed" | "workspace" | "plugin" | "remote")[];
  readonly hits: readonly SkillSearchHit[];
  readonly diagnostics: readonly { readonly code: SkillErrorCode; readonly message: string }[];
  readonly remote: { readonly available: boolean; readonly note: string };
}

export const SkillInspectResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    reasonCode: Type.Optional(SkillErrorCodeSchema),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    sourceRef: Type.String({ minLength: 1, maxLength: 512 }),
    kind: Type.Optional(SkillInstallSourceKindSchema),
    skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    skillRefKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    contentHash: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    fileCount: Type.Optional(Type.Integer({ minimum: 0 })),
    manifest: Type.Optional(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 128 }),
          description: Type.Optional(Type.String({ maxLength: 2048 })),
          license: Type.Optional(Type.String({ maxLength: 256 })),
          disableModelInvocation: Type.Optional(Type.Boolean()),
          allowedTools: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 128 })),
          requires: Type.Optional(
            Type.Object(
              {
                plugins: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
                tools: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
                capabilities: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
                bins: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
                env: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
                os: Type.Optional(Type.Array(Type.String({ maxLength: 16 }), { maxItems: 3 })),
              },
              { additionalProperties: false },
            ),
          ),
          recommends: Type.Optional(
            Type.Object(
              {
                skills: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
                plugins: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
              },
              { additionalProperties: false },
            ),
          ),
          risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
        },
        { additionalProperties: false },
      ),
    ),
    compatibility: Type.Optional(Type.Union([SkillCompatibilityReportSchema, Type.Null()])),
    risks: Type.Optional(Type.Array(SkillRiskMarkerSchema, { maxItems: 64 })),
    provenance: Type.Optional(Type.Union([SkillProvenanceSchema, Type.Null()])),
    status: Type.Optional(SkillStatusSchema),
    readiness: Type.Optional(
      Type.Union([Type.Literal("ready"), Type.Literal("degraded"), Type.Literal("blocked"), Type.Literal("incompatible")]),
    ),
    /** readBody 请求时的受控正文（预算内；loadHandle 已消费） */
    body: Type.Optional(Type.String({ maxLength: 262144 })),
    truncated: Type.Optional(Type.Boolean()),
    fileHash: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);
export interface SkillInspectResult {
  readonly ok: boolean;
  readonly reasonCode?: SkillErrorCode;
  readonly reason?: string;
  readonly sourceRef: string;
  readonly kind?: SkillInstallSourceKind;
  readonly skillId?: string;
  readonly skillRefKey?: string;
  readonly version?: string;
  readonly contentHash?: string;
  readonly sizeBytes?: number;
  readonly fileCount?: number;
  readonly manifest?: {
    readonly name: string;
    readonly description?: string;
    readonly license?: string;
    readonly disableModelInvocation?: boolean;
    readonly allowedTools?: readonly string[];
    readonly requires?: {
      readonly plugins?: readonly string[];
      readonly tools?: readonly string[];
      readonly capabilities?: readonly string[];
      readonly bins?: readonly string[];
      readonly env?: readonly string[];
      readonly os?: readonly string[];
    };
    readonly recommends?: { readonly skills?: readonly string[]; readonly plugins?: readonly string[] };
    readonly risk?: "low" | "medium" | "high";
  };
  readonly compatibility?: SkillCompatibilityReport | null;
  readonly risks?: readonly SkillRiskMarker[];
  readonly provenance?: SkillProvenance | null;
  readonly status?: SkillStatus;
  readonly readiness?: SkillReadiness;
  readonly body?: string;
  readonly truncated?: boolean;
  readonly fileHash?: string;
}

export const SkillInstallResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("installed"),
      Type.Literal("confirmation_required"),
      Type.Literal("rejected"),
      Type.Literal("failed"),
    ]),
    skillRef: Type.Optional(SkillRefSchema),
    skillRefKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    idempotent: Type.Optional(Type.Boolean()),
    agentBinding: Type.Optional(
      Type.Union([Type.Literal("bound"), Type.Literal("session-only"), Type.Literal("unchanged")]),
    ),
    activationGrant: Type.Optional(Type.Union([Type.Literal("granted"), Type.Literal("unavailable")])),
    grantId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    loadHandle: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    reasonCode: Type.Optional(SkillErrorCodeSchema),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    confirmation: Type.Optional(ConfirmationViewSchema),
    risks: Type.Optional(Type.Array(SkillRiskMarkerSchema, { maxItems: 64 })),
  },
  { additionalProperties: false },
);
export interface SkillInstallResult {
  readonly status: "installed" | "confirmation_required" | "rejected" | "failed";
  readonly skillRef?: SkillRef;
  readonly skillRefKey?: string;
  readonly operationId?: string;
  readonly idempotent?: boolean;
  readonly agentBinding?: "bound" | "session-only" | "unchanged";
  readonly activationGrant?: "granted" | "unavailable";
  readonly grantId?: string;
  readonly loadHandle: string | null;
  readonly reasonCode?: SkillErrorCode;
  readonly reason?: string;
  readonly confirmation?: ConfirmationView;
  readonly risks?: readonly SkillRiskMarker[];
}

export const SkillManageResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("ok"),
      Type.Literal("confirmation_required"),
      Type.Literal("rejected"),
      Type.Literal("failed"),
    ]),
    action: SkillManageActionSchema,
    agentId: Type.String({ minLength: 1, maxLength: 128 }),
    reasonCode: Type.Optional(SkillErrorCodeSchema),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    confirmation: Type.Optional(ConfirmationViewSchema),
    result: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Unknown(), { maxProperties: 32 }),
    ),
    view: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Unknown(), { maxProperties: 64 }),
    ),
  },
  { additionalProperties: false },
);
export interface SkillManageResult {
  readonly status: "ok" | "confirmation_required" | "rejected" | "failed";
  readonly action: SkillManageArgs["action"];
  readonly agentId: string;
  readonly reasonCode?: SkillErrorCode;
  readonly reason?: string;
  readonly confirmation?: ConfirmationView;
  readonly result?: Record<string, unknown>;
  readonly view?: Record<string, unknown>;
}

export const SkillBundleResultSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("ok"),
      Type.Literal("confirmation_required"),
      Type.Literal("rejected"),
      Type.Literal("failed"),
    ]),
    action: SkillBundleActionSchema,
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    reasonCode: Type.Optional(SkillErrorCodeSchema),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    confirmation: Type.Optional(ConfirmationViewSchema),
    result: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Unknown(), { maxProperties: 32 })),
    bundles: Type.Optional(
      Type.Array(
        Type.Object(
          {
            bundleId: Type.String({ minLength: 1, maxLength: 128 }),
            version: Type.String({ minLength: 1, maxLength: 64 }),
            contentHash: Type.String({ minLength: 1, maxLength: 64 }),
            name: Type.String({ minLength: 1, maxLength: 128 }),
            createdAt: Type.String({ minLength: 1, maxLength: 64 }),
            itemCount: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 256 },
      ),
    ),
  },
  { additionalProperties: false },
);
export interface SkillBundleResult {
  readonly status: "ok" | "confirmation_required" | "rejected" | "failed";
  readonly action: SkillBundleManageArgs["action"];
  readonly agentId?: string;
  readonly reasonCode?: SkillErrorCode;
  readonly reason?: string;
  readonly confirmation?: ConfirmationView;
  readonly result?: Record<string, unknown>;
  readonly bundles?: readonly {
    readonly bundleId: string;
    readonly version: string;
    readonly contentHash: string;
    readonly name: string;
    readonly createdAt: string;
    readonly itemCount: number;
  }[];
}

export type ApproveConfirmationResult =
  | { readonly status: "approved"; readonly token: string }
  | { readonly status: "rejected"; readonly reasonCode: SkillErrorCode; readonly reason: string };

// ── Core Service ───────────────────────────────────────────────

export const SKILL_SEARCH_LAYERS = ["bound", "managed", "workspace", "plugin", "remote"] as const;
export type SkillSearchLayer = (typeof SKILL_SEARCH_LAYERS)[number];

export interface SkillCoreServiceDeps {
  readonly catalog: SkillCatalog;
  readonly installer: SkillInstaller;
  readonly agentService: AgentSkillService;
  readonly bundleService: SkillBundleService;
  readonly sessionService: SessionSkillService;
  readonly snapshots: SkillSnapshotService;
  /** 受控正文读取（readBody / loadHandle 路径；缺省则正文读取不可用） */
  readonly contentService?: SkillContentService;
  readonly loadHandles: LoadHandleRegistry;
  readonly confirmations: ConfirmationTokenRegistry;
  readonly sessionFiles: SessionFileRegistry;
  readonly environment: ReadinessEnvironment;
  /** 来源信任策略（local/archive/git/http 安装与 workspace 扫描判定） */
  readonly trust?: SkillTrustPolicy;
  /** workspace 扫描根（cwd/home；提供后才扫描 workspace 层） */
  readonly workspace?: { readonly cwd: string; readonly home: string };
  /** 来源适配器（当前仅用于能力诊断；搜索各层独立构建） */
  readonly adapters?: readonly SkillSourceAdapter[];
  /**
   * T11（P0-3）：插件 Skill 状态 overlay——插件启用/Agent 绑定/禁用/卸载的
   * 实时状态接入解析链（PluginSkillBridge 适配）。未启用/已禁用/已卸载的插件
   * Skill 从可见集剔除（fail-closed，不暴露给模型），正文读取同样 fail-closed。
   */
  readonly pluginOverlay?: {
    /** 插件 Skill 可读性检查（禁用/卸载 → 抛错拒绝读取） */
    assertReadable(skillRef: SkillRef): void;
    /** 插件 Skill 状态覆盖（readiness/selection 按插件当前状态；插件来源用） */
    overlayStatus(skill: RegisteredSkill, agentId?: string): SkillStatus;
    /**
     * T12（P0-3）：当前 Agent 已绑定且启用的插件贡献的 Catalog 插件 Skill
     * （精确 SkillRef）。解析时作为固定引用加入候选池——已绑定插件的 Skill
     * 必须可见（resolver 不再因"未固定"而 gated），叠加 overlayStatus 状态。
     */
    listAgentBoundPluginSkills(agentId: string): readonly RegisteredSkill[];
  };
  readonly actor?: ActorRef;
  readonly now?: () => Date;
  readonly activationGrantTtlMs?: number;
  readonly loadHandleTtlMs?: number;
  readonly confirmationTtlMs?: number;
}

const DEFAULT_ACTIVATION_GRANT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOAD_HANDLE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

const EXECUTOR: ExecutorRef = { kind: "service", id: "skill-core" };

export class SkillCoreService {
  private readonly now: () => Date;
  /**
   * T11（P0-2）：sessionId → 当前 turn 冻结的 Skill Snapshot。
   * buildPiSkillsForTurn 每 turn 覆盖写入；read 工具经 readSkillFileForSession
   * 用它做成员检查（哈希/预算由 SkillContentService 执行），保持 turn 冻结语义。
   */
  private readonly turnSnapshots = new Map<string, { readonly turnId: string; readonly snapshot: SkillSnapshot }>();

  constructor(private readonly deps: SkillCoreServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── Catalog 查询（API 管理页用）────────────────────────────────

  listCatalog(options: { readonly sourceKind?: SkillSourceKind; readonly query?: string } = {}): SafeSkillView[] {
    return this.deps.catalog.list(options).map(toSafeSkillView);
  }

  getSkillDetail(skillRefKeyInput: string): SafeSkillView | null {
    const found = this.deps.catalog.list({}).find((skill) => skillRefKey(skill.skillRef) === skillRefKeyInput);
    return found === undefined ? null : toSafeSkillView(found);
  }

  /** Session 可见 Skill（临时绑定；过期项单独列出）。 */
  listSessionSkills(sessionId: string): ReturnType<SessionSkillService["listSessionSkills"]> {
    return this.deps.sessionService.listSessionSkills(sessionId);
  }

  /**
   * T10：当前 Agent/Session 的 PI Skill pointer（元数据常驻注入 PI 系统提示）。
   * 每 turn 调用：resolveOutput（Agent 绑定 + Session 临时绑定 + 解析）→ 不可变
   * Skill Snapshot 冻结（含未消费激活授权摘要）→ buildPiSkillsFromSnapshot
   * （受控 filePath/baseDir）。
   * - 有 Agent：skills.json 持久绑定 + Session 临时绑定（P1-7 合并，extraPinnedRefs）；
   * - 无 Agent Session（§9.4）：不继承 Agent Bundle，pinnedRefs 只含 Session 临时
   *   绑定（active；skillRefKey → findByRefKey 解析为精确 SkillRef，失效进诊断
   *   fail-closed），builtin/workspace 全局可见由 Resolver 保证；
   * - 快照 agentId 用 ANONYMOUS_AGENT_ID 占位（Snapshot 契约拒绝空 agentId）；
   * - 快照构造失败抛错（fail-closed，不返回 undefined）；无可见 Skill 返回空列表。
   */
  buildPiSkillsForTurn(input: { readonly agentId?: string; readonly sessionId?: string; readonly turnId?: string }): PiResourceSkills {
    const { sessionId, turnId } = input;
    const agentId = input.agentId ?? "";
    if (sessionId !== undefined && sessionId !== "" && turnId !== undefined && turnId !== "") {
      this.deps.sessionService.beginTurn(sessionId, turnId);
    }
    // T13（P0-1）：冻结开始即移除旧快照——任何后续失败（view 解析/快照构造）
    // 都 fail-closed，不保留上一 Turn 的旧快照（否则 read 链路仍按旧可见集授权）
    if (sessionId !== undefined && sessionId !== "") {
      this.turnSnapshots.delete(sessionId);
    }
    // P1-7：Session 临时绑定（agent/无 agent 会话都合并；只取 active，过期项不进入）
    const bindings = sessionId !== undefined && sessionId !== "" ? this.resolveSessionBindings(sessionId) : { pinnedRefs: [] as SkillRef[], diagnostics: [] as ResolutionDiagnostic[] };
    const diagnostics: ResolutionDiagnostic[] = [...bindings.diagnostics];
    // T12（P0-3）：Agent 已绑定且启用插件的 Skill 贡献作为固定引用加入解析——
    // 绑定插件必须可见（resolver 不再因"未固定 plugin 候选"而 gated）
    let extraPinnedRefs: readonly SkillRef[] = bindings.pinnedRefs;
    if (agentId !== "" && this.deps.pluginOverlay !== undefined) {
      const boundPluginSkills = this.deps.pluginOverlay.listAgentBoundPluginSkills(agentId);
      if (boundPluginSkills.length > 0) {
        extraPinnedRefs = [...extraPinnedRefs, ...boundPluginSkills.map((skill) => skill.skillRef)];
      }
    }
    const view =
      agentId === ""
        ? this.deps.catalog.listByAgent({ agentId: ANONYMOUS_AGENT_ID, pinnedRefs: bindings.pinnedRefs, environment: this.deps.environment })
        : this.deps.agentService.listAgentSkills(agentId, this.deps.environment, this.deps.catalog, extraPinnedRefs);
    diagnostics.push(...view.diagnostics);
    // T11（P0-3）+ T12（P0-3）：插件 Skill overlay——未启用/禁用/卸载的插件 Skill
    // 从可见集剔除（fail-closed：不暴露给模型）；剔除项进 gated 并保留诊断。
    // 已绑定插件 Skill 的 readiness 用 overlayStatus(skill, agentId) 重算
    // （requires.plugins 按真实绑定；blocked 来源仍拦截）
    let visible = view.visible;
    const gated: import("../resolver.js").ResolvedSkill[] = [...view.gated];
    if (this.deps.pluginOverlay !== undefined) {
      const kept: import("../resolver.js").ResolvedSkill[] = [];
      for (const resolved of visible) {
        if (resolved.skillRef.sourceKind !== "plugin") {
          kept.push(resolved);
          continue;
        }
        let status = resolved.status;
        const registered = this.deps.catalog.findByRefKey(resolved.skillRefKey);
        if (registered !== undefined) {
          try {
            status = this.deps.pluginOverlay.overlayStatus(registered, agentId === "" ? undefined : agentId);
          } catch {
            // overlayStatus 失败不改变基线（assertReadable 兜底）
          }
        }
        if (status.readiness === "blocked" || status.readiness === "incompatible") {
          gated.push({ ...resolved, status });
          continue;
        }
        try {
          this.deps.pluginOverlay.assertReadable(resolved.skillRef);
          kept.push({ ...resolved, status });
        } catch (error) {
          gated.push({
            ...resolved,
            status: {
              ...status,
              readiness: "blocked",
              ...(error instanceof Error ? { blockedReason: error.message.slice(0, 200) } : {}),
            },
          });
        }
      }
      visible = kept;
    }
    const snapshot = this.deps.snapshots.createSkillSnapshot({
      agentId: agentId === "" ? ANONYMOUS_AGENT_ID : agentId,
      sessionId: sessionId ?? "",
      turnId: turnId ?? "",
      resolveOutput: {
        visible,
        shadowed: view.shadowed,
        disabled: view.disabled,
        gated,
        diagnostics,
      },
      // T13（P0-4）：activation grant 只附着签发它的 Turn——跨 Turn 不得带入
      // 后续快照（"一次消费、只附着当前 Turn、禁止跨 Turn 重放"）
      ...(sessionId !== undefined && turnId !== undefined
        ? {
            activationGrants: this.deps.sessionService
              .listActiveGrants(sessionId)
              .filter((grant) => grant.issuedTurnId === turnId),
          }
        : {}),
    });
    const loaded = buildPiSkillsFromSnapshot(snapshot);
    // T13（P0-1）：冻结成功后入槽（新 turn 覆盖旧 turn）——构造失败路径已在
    // 上方 createSkillSnapshot 抛错前删除旧槽（见下），fail-closed 不保留旧快照
    if (sessionId !== undefined && sessionId !== "") {
      this.turnSnapshots.set(sessionId, { turnId: turnId ?? "", snapshot });
    }
    return { skills: loaded.skills, diagnostics: loaded.diagnostics };
  }

  /**
   * T11（P0-2）+ T12（P0-1/P0-2）：read 工具路由——按绝对路径从当前 turn 的
   * 可见 Skill（冻结快照 entries + 当前 turn active grants，覆盖会话内安装）
   * 匹配，命中则经 SkillContentService 受控读取（成员/哈希/预算/超时校验）。
   * 三态结果：
   * - ok：受控读取的正文（SKILL.md 或支持文件；relativePath 由 rootPath 换算）；
   * - not-a-skill-file：Skill 系统未接入、或无冻结快照且路径不在任何已登记
   *   Skill 根内——调用方回退到普通沙箱读取（不改变普通文件行为）；
   * - denied：canonical 路径落在任意已登记 Skill 根，但不在当前 Turn 可见集/
   *   激活授权中（已解绑/停用/插件禁用），或受控读取被拒——fail-closed，
   *   调用方不得回退裸读（防 Junction 别名绕过哈希/清单/预算/审计）。
   */
  async readSkillFileForSession(input: { readonly sessionId: string; readonly absPath: string }): Promise<SkillFileReadOutcome> {
    const frozen = this.turnSnapshots.get(input.sessionId);
    const absPath = path.resolve(input.absPath);
    const absCanonical = canonicalResolve(absPath);
    const read = (rootPath: string, skillRef: SkillRef, origin: string): Promise<SkillFileReadOutcome> => {
      if (this.deps.contentService === undefined) {
        return Promise.resolve({ status: "not-a-skill-file" as const, reason: "SkillContentService 未就绪" });
      }
      const rel = path.relative(canonicalResolve(rootPath), absCanonical);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        return Promise.resolve({ status: "not-a-skill-file" as const, reason: `路径不在 ${origin} 根内` });
      }
      const snapshot =
        frozen !== undefined
          ? frozen.snapshot
          : undefined;
      // 无冻结快照（Skill 系统未接入 turn）→ 不作为 Skill 文件处理
      if (snapshot === undefined) {
        return Promise.resolve({ status: "not-a-skill-file" as const, reason: "当前 Session 无冻结 Skill 快照" });
      }
      const relativePath = rel.split(path.sep).join("/");
      return this.deps.contentService!.readSkillBody({ snapshot, skillRef, relativePath }).then(
        (result) => ({
          status: "ok" as const,
          body: result.body,
          truncated: result.truncated,
          skillRefKey: skillRefKey(skillRef),
          relativePath,
        }),
        (error) => ({
          status: "denied" as const,
          reasonCode: extractReasonCode(error),
          reason: error instanceof Error ? error.message.slice(0, 240) : "Skill 文件受控读取被拒绝",
        }),
      );
    };

    // 1. 当前 turn 可见/授权候选：冻结快照 entries + 当前 turn active grants
    //    （T12 P0-2：会话内安装后同一 turn 立即受控读取——grant 匹配精确 SkillRef；
    //     T13 P0-4：grant 只附着签发它的 Turn，issuedTurnId 与冻结 turnId 一致才纳入）
    const candidates: { readonly rootPath: string; readonly skillRef: SkillRef; readonly grantId?: string }[] = [];
    if (frozen !== undefined) {
      for (const entry of frozen.snapshot.entries) {
        candidates.push({ rootPath: entry.rootPath, skillRef: entry.skillRef });
      }
    }
    if (this.deps.sessionService !== undefined && frozen !== undefined) {
      for (const grant of this.deps.sessionService.listActiveGrants(input.sessionId)) {
        if (grant.issuedTurnId !== frozen.turnId) {
          continue; // 跨 Turn grant 不纳入（禁止跨 Turn 重放）
        }
        const registered = this.deps.catalog.findByRefKey(grant.skillRefKey);
        if (registered !== undefined) {
          candidates.push({ rootPath: registered.rootPath, skillRef: registered.skillRef, grantId: grant.grantId });
        }
      }
      for (const grant of this.deps.sessionService.listTurnOverlays(input.sessionId, frozen.turnId)) {
        const registered = this.deps.catalog.findByRefKey(grant.skillRefKey);
        if (registered !== undefined) {
          candidates.push({ rootPath: registered.rootPath, skillRef: registered.skillRef });
        }
      }
    }
    for (const candidate of candidates) {
      if (candidate.grantId !== undefined && frozen !== undefined && this.deps.sessionService !== undefined) {
        const rel = path.relative(canonicalResolve(candidate.rootPath), absCanonical);
        if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
          continue;
        }
        let activated: ReturnType<SessionSkillService["activateActivationGrant"]>;
        try {
          activated = this.deps.sessionService.activateActivationGrant({
            grantId: candidate.grantId,
            sessionId: input.sessionId,
            turnId: frozen.turnId,
            skillRef: candidate.skillRef,
            contentHash: candidate.skillRef.contentHash,
          });
        } catch (error) {
          return {
            status: "denied",
            reasonCode: "skill_activation_denied",
            reason: error instanceof Error ? error.message.slice(0, 240) : "激活授权拒绝",
          };
        }
        if (activated.status !== "consumed") {
          return { status: "denied", reasonCode: activated.reasonCode, reason: activated.reason };
        }
      }
      const outcome = await read(candidate.rootPath, candidate.skillRef, "当前 Turn 可见 Skill");
      if (outcome.status !== "not-a-skill-file") {
        return outcome;
      }
    }

    // 2. 未命中可见集，但 canonical 路径落在任意已登记 Skill 根内 → denied
    //    （T12 P0-1：上一轮可见、本轮解绑/停用/插件禁用；Junction 别名经
    //    canonical 化后同样命中——fail-closed，绝不回退裸读）
    if (this.deps.contentService !== undefined) {
      for (const skill of this.deps.catalog.list({})) {
        const rel = path.relative(canonicalResolve(skill.rootPath), absCanonical);
        if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
          return {
            status: "denied",
            reasonCode: "skill_not_in_snapshot",
            reason: "路径落在 Skill 存储区但不在当前 Turn 可见集（已解绑/停用/插件禁用），拒绝读取",
          };
        }
      }
    }

    return { status: "not-a-skill-file", reason: "路径不在任何 Skill 根内" };
  }

  /**
   * T11（P1-7）：把 Session 临时绑定解析为精确 SkillRef（active 项）。
   * 绑定只持久化 skillRefKey；经 Catalog.findByRefKey 找回完整 SkillRef
   * （含 contentHash）才能进入 pinnedRefs。绑定失效（已卸载/不存在）→
   * 诊断（skill_unknown_skillref，不静默回退）；过期项不进入。
   */
  private resolveSessionBindings(sessionId: string): { readonly pinnedRefs: readonly SkillRef[]; readonly diagnostics: readonly ResolutionDiagnostic[] } {
    const pinnedRefs: SkillRef[] = [];
    const diagnostics: ResolutionDiagnostic[] = [];
    const view = this.deps.sessionService.listSessionSkills(sessionId);
    for (const binding of view.active) {
      const candidate = this.deps.catalog.findByRefKey(binding.skillRefKey);
      if (candidate === undefined) {
        diagnostics.push({
          skillId: binding.skillRefKey.split("@")[0] ?? binding.skillRefKey,
          code: "skill_unknown_skillref",
          message: `Session 临时绑定无法解析到 Catalog（${binding.skillRefKey}），已排除且不静默回退`,
        });
        continue;
      }
      pinnedRefs.push(candidate.skillRef);
    }
    return { pinnedRefs, diagnostics };
  }

  /** 无 Agent Session 临时绑定（TTL 到期自动失效；不自动升级为持久绑定）。 */
  bindTemporarySessionSkill(    sessionId: string,
    input: { readonly skillRef: SkillRef; readonly selection?: SkillSelectionMode; readonly ttlMs?: number },
  ): ReturnType<SessionSkillService["bindTemporary"]> {
    return this.deps.sessionService.bindTemporary({
      sessionId,
      skillRef: input.skillRef,
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    });
  }

  // ── search_skills（§11.2 顺序：bound → managed → workspace → plugin → remote）──

  search(input: { readonly query?: string; readonly scope?: SkillSearchScope; readonly agentId?: string; readonly sessionId?: string }): SkillSearchResult {
    const needle = (input.query ?? "").trim().toLowerCase();
    const scopes = new Set<SkillSearchLayer>(
      input.scope === undefined || input.scope === "all"
        ? [...SKILL_SEARCH_LAYERS]
        : [input.scope],
    );
    const hits: SkillSearchHit[] = [];
    const diagnostics: { code: SkillErrorCode; message: string }[] = [];
    const seenKeys = new Set<string>();

    // ── 层 1：当前 Agent 已绑定（pinned 引用；未绑定的可见候选归 managed 层）──
    if (scopes.has("bound") && input.agentId !== undefined) {
      const view = this.deps.agentService.listAgentSkills(input.agentId, this.deps.environment);
      for (const skill of [...view.visible, ...view.shadowed, ...view.disabled, ...view.gated]) {
        if (!skill.pinned) {
          continue;
        }
        if (!matchesQuery(skill.displayName, skill.skillId, skill.description, needle)) {
          continue;
        }
        seenKeys.add(skill.skillRefKey);
        hits.push(toBoundHit(skill));
      }
      for (const diag of view.diagnostics) {
        diagnostics.push({ code: diag.code, message: diag.message });
      }
    }

    // ── 层 2：本地 Managed Store ──
    if (scopes.has("managed")) {
      for (const skill of this.deps.catalog.list({ sourceKind: "managed", ...(needle !== "" ? { query: needle } : {}) })) {
        const key = skillRefKey(skill.skillRef);
        if (seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        hits.push(toCatalogHit("managed", skill));
      }
    }

    // ── 层 3：当前工作区 / 可信兼容目录 ──
    if (scopes.has("workspace")) {
      if (this.deps.workspace === undefined || this.deps.trust === undefined) {
        diagnostics.push({ code: "skill_source_unsupported", message: "workspace 扫描未配置（缺少 cwd/home 或信任策略）" });
      } else {
        const adapter = new WorkspaceSkillSource({ cwd: this.deps.workspace.cwd, home: this.deps.workspace.home, trust: this.deps.trust });
        const registeredBySourceId = new Map(
          this.deps.catalog.list({ sourceKind: "workspace" }).map((skill) => [skill.sourceId, skill] as const),
        );
        for (const candidate of adapter.discover(needle === "" ? undefined : needle)) {
          let inspection: SkillSourceInspection;
          try {
            inspection = adapter.inspect(candidate.sourceId);
          } catch {
            diagnostics.push({ code: "skill_package_invalid", message: `workspace 候选检查失败：${candidate.displayName}` });
            continue;
          }
          const registered = registeredBySourceId.get(candidate.sourceId);
          const key = registered !== undefined ? skillRefKey(registered.skillRef) : "";
          if (key !== "" && seenKeys.has(key)) {
            continue;
          }
          if (key !== "") {
            seenKeys.add(key);
          }
          hits.push(toDiscoveredHit("workspace", candidate, inspection, registered));
        }
      }
    }

    // ── 层 4：已启用 Plugin Skill Bundle（Catalog 登记由 T7 接线）──
    if (scopes.has("plugin")) {
      const pluginCandidates = this.deps.catalog.list({ sourceKind: "plugin", ...(needle !== "" ? { query: needle } : {}) });
      if (pluginCandidates.length === 0 && this.deps.adapters !== undefined && this.deps.adapters.length > 0) {
        // 适配器存在但无登记：给出 T7 接线诊断，不假装已发现
        diagnostics.push({ code: "skill_source_unsupported", message: "Plugin Skill Bundle 登记由 T7 接线，当前 Catalog 无 plugin 来源候选" });
      }
      for (const skill of pluginCandidates) {
        const key = skillRefKey(skill.skillRef);
        if (seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        hits.push(toCatalogHit("plugin", skill));
      }
    }

    // ── 层 5：远程 / 市场（T9 接入；搜索与安装是两个独立动作）──
    if (scopes.has("remote")) {
      diagnostics.push({ code: "skill_source_unsupported", message: "远程来源搜索在 T9 接入，当前不可用；搜索结果缺 Skill 不会递归触发安装" });
    }

    return {
      layers: [...SKILL_SEARCH_LAYERS],
      hits,
      diagnostics,
      remote: { available: false, note: "远程来源搜索在 T9 接入，当前不可用" },
    };
  }

  // ── inspect_skill ─────────────────────────────────────────────

  async inspect(input: { readonly sourceRef?: string; readonly kind?: SkillInstallSourceKind; readonly skillRef?: SkillRef; readonly sessionId?: string; readonly readBody?: boolean; readonly agentId?: string; readonly turnId?: string; readonly loadHandle?: string }): Promise<SkillInspectResult> {
    const hasSkillRef = input.skillRef !== undefined;
    const hasSource = input.sourceRef !== undefined && input.sourceRef !== "";
    if (!hasSkillRef && !hasSource) {
      return failedInspect("skill_source_not_found", "必须提供 sourceRef 或 skillRef 之一", input.sourceRef ?? "", input.kind);
    }
    if (hasSkillRef && hasSource) {
      return failedInspect("skill_unknown_skillref", "sourceRef 与 skillRef 只能提供其一", input.sourceRef ?? "", input.kind);
    }

    let registered: RegisteredSkill | undefined;
    let inspection: SkillSourceInspection;
    let risks: readonly SkillRiskMarker[];
    let version: string;
    let sourceRef: string;

    if (hasSkillRef) {
      const ref = input.skillRef as SkillRef;
      try {
        registered = this.deps.catalog.resolveBySkillRef(ref);
      } catch (error) {
        return failedInspect(extractReasonCode(error), error instanceof Error ? error.message : "SkillRef 解析失败", ref.skillId, undefined);
      }
      sourceRef = registered.sourceId;
      version = registered.version;
      inspection = {
        sourceRef: registered.sourceId,
        packageRoot: registered.rootPath,
        manifest: registered.manifest,
        compatibility: registered.compatibility,
        contentHash: registered.contentHash,
        sizeBytes: registered.sizeBytes,
        fileCount: registered.fileCount,
        errors: [],
      };
      risks = registered.manifest === null ? [] : assessPackageRisks(registered.rootPath);
    } else {
      const sourceRefInput = input.sourceRef as string;
      const kind = input.kind;
      if (kind === undefined) {
        return failedInspect("skill_source_unsupported", "sourceRef 检查必须提供 kind", sourceRefInput, undefined);
      }
      const operationId = this.emit("skill.inspect.started", input.agentId, input.sessionId, { sourceRef: sourceRefInput.slice(0, 240), kind });
      try {
        const inspected = this.deps.installer.inspectSource({ sourceRef: sourceRefInput, kind, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) });
        inspection = inspected.inspection;
        risks = inspected.risks;
        version = inspected.version;
        sourceRef = sourceRefInput;
      } catch (error) {
        this.emit("skill.inspect.failed", input.agentId, input.sessionId, { sourceRef: sourceRefInput.slice(0, 240), reasonCode: extractReasonCode(error) }, operationId);
        return failedInspect(extractReasonCode(error), error instanceof Error ? error.message : "来源检查失败", sourceRefInput, kind);
      }
      this.emit("skill.inspect.completed", input.agentId, input.sessionId, { sourceRef: sourceRefInput.slice(0, 240), kind }, operationId);
    }

    const manifest = inspection.manifest;
    const readiness = manifest === null ? undefined : diagnoseReadiness(manifest, this.deps.environment).readiness;
    const result: SkillInspectResult = {
      ok: true,
      sourceRef,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(registered !== undefined ? { skillId: registered.skillId, skillRefKey: skillRefKey(registered.skillRef) } : {}),
      version,
      contentHash: inspection.contentHash,
      sizeBytes: inspection.sizeBytes,
      fileCount: inspection.fileCount,
      ...(manifest !== null
        ? {
            manifest: {
              name: manifest.name,
              ...(manifest.description !== undefined ? { description: manifest.description } : {}),
              ...(manifest.license !== undefined ? { license: manifest.license } : {}),
              ...(manifest.disableModelInvocation !== undefined ? { disableModelInvocation: manifest.disableModelInvocation } : {}),
              ...(manifest.allowedTools !== undefined ? { allowedTools: manifest.allowedTools } : {}),
              ...(manifest.opencolorful?.requires !== undefined ? { requires: manifest.opencolorful.requires } : {}),
              ...(manifest.opencolorful?.recommends !== undefined ? { recommends: manifest.opencolorful.recommends } : {}),
              ...(manifest.opencolorful?.risk !== undefined ? { risk: manifest.opencolorful.risk } : {}),
            },
          }
        : {}),
      compatibility: inspection.compatibility,
      risks,
      // provenance 只在 registered 且存在时输出（optional 字段不能显式带 undefined）
      ...(registered?.provenance !== undefined ? { provenance: registered.provenance } : {}),
      ...(registered !== undefined ? { status: registered.status } : {}),
      ...(readiness !== undefined ? { readiness } : {}),
    };

    // readBody：loadHandle 受控正文读取（经 SkillContentService；只支持已登记 skillRef）
    if (input.readBody === true) {
      if (registered === undefined) {
        return { ...result, ok: false, reasonCode: "skill_content_read_denied", reason: "正文读取需要已登记的 skillRef（先安装或绑定）" };
      }
      if (this.deps.contentService === undefined || input.sessionId === undefined) {
        return { ...result, ok: false, reasonCode: "skill_content_read_denied", reason: "正文读取未就绪（contentService/sessionId 缺失）" };
      }
      const turnId = input.turnId ?? this.resolveTurnId();
      try {
        const resolveOutput = this.deps.catalog.listByAgent({
          agentId: input.agentId ?? "anonymous",
          pinnedRefs: [registered.skillRef],
          environment: this.deps.environment,
        });
        const snapshot = this.deps.snapshots.createSkillSnapshot({
          agentId: input.agentId ?? "anonymous",
          sessionId: input.sessionId,
          turnId,
          resolveOutput,
        });
        // T12（P0-2）：readBody 优先消费调用方传入的 loadHandle（会话内安装结果
        // 返回的一次性句柄——否则安装返回的 loadHandle 没有读取消费者）；未提供
        // 时维持原有按需签发路径。
        let handle: { readonly skillRef: SkillRef; readonly contentHash: string };
        if (input.loadHandle !== undefined) {
          const consumed = this.deps.loadHandles.consumeLoadHandle({ handleId: input.loadHandle, turnId, sessionId: input.sessionId });
          if (consumed.status !== "granted") {
            return { ...result, ok: false, reasonCode: consumed.reasonCode, reason: consumed.reason };
          }
          handle = consumed.handle;
        } else {
          const issued = this.deps.loadHandles.issueLoadHandle({
            turnId,
            sessionId: input.sessionId,
            skillRef: registered.skillRef,
            contentHash: registered.contentHash,
            ttlMs: this.deps.loadHandleTtlMs ?? DEFAULT_LOAD_HANDLE_TTL_MS,
          });
          const consumed = this.deps.loadHandles.consumeLoadHandle({ handleId: issued.handleId, turnId, sessionId: input.sessionId });
          if (consumed.status !== "granted") {
            return { ...result, ok: false, reasonCode: consumed.reasonCode, reason: consumed.reason };
          }
          handle = consumed.handle;
        }
        const read = await this.deps.contentService.readSkillBody({ snapshot, skillRef: registered.skillRef, handle });
        return {
          ...result,
          body: read.body,
          truncated: read.truncated,
          fileHash: read.fileHash,
        };
      } catch (error) {
        return { ...result, ok: false, reasonCode: extractReasonCode(error), reason: error instanceof Error ? error.message : "正文读取失败" };
      }
    }
    return result;
  }

  // ── install_skill（四态：installed / confirmation_required / rejected / failed）──

  install(input: { readonly sourceRef: string; readonly kind: SkillInstallSourceKind; readonly confirmationToken?: string; readonly agentId?: string; readonly sessionId?: string; readonly turnId?: string }): SkillInstallResult {
    const { sourceRef, kind } = input;
    const sessionId = input.sessionId;
    const agentId = input.agentId;

    // 1. 输入防线：session-file 必须已登记 fileKey；local/archive 路径必须在信任根内
    try {
      this.assertInstallSource(sourceRef, kind, sessionId);
    } catch (error) {
      return failedInstall(extractReasonCode(error), error instanceof Error ? error.message : "安装来源被拒绝");
    }

    // 2. 学习策略门控
    const policy = agentId !== undefined ? this.deps.agentService.getLearningPolicy(agentId) : "ask-on-risk";
    if (policy === "disabled") {
      this.emit("skill.install.rejected", agentId, sessionId, {
        sourceRef: sourceRef.slice(0, 240),
        kind,
        reasonCode: "skill_agent_unauthorized",
        policy: "disabled",
      });
      return rejectedInstall("skill_agent_unauthorized", "当前 Agent 学习策略为 disabled，不能主动安装 Skill");
    }

    // 3. 预检（inspect → 版本/哈希/风险摘要）
    let inspection: SkillSourceInspection;
    let risks: readonly SkillRiskMarker[];
    let version: string;
    const inspectOperationId = this.emit("skill.inspect.started", agentId, sessionId, { sourceRef: sourceRef.slice(0, 240), kind });
    try {
      const inspected = this.deps.installer.inspectSource({ sourceRef, kind, ...(sessionId !== undefined ? { sessionId } : {}) });
      inspection = inspected.inspection;
      risks = inspected.risks;
      version = inspected.version;
    } catch (error) {
      this.emit("skill.inspect.failed", agentId, sessionId, { sourceRef: sourceRef.slice(0, 240), reasonCode: extractReasonCode(error) }, inspectOperationId);
      return failedInstall(extractReasonCode(error), error instanceof Error ? error.message : "安装前检查失败");
    }
    this.emit("skill.inspect.completed", agentId, sessionId, { sourceRef: sourceRef.slice(0, 240), kind }, inspectOperationId);

    // §8.4（T9 偏差②统一边界）：兼容失败不生成表面成功的空壳——
    // unsupported（无转换路径）与 metadata-only（正文为空）直接拒绝并给迁移建议，
    // 不因 local 路径绕过生态适配器的边界检查
    const compatibilityLevel = inspection.manifest?.compatibilityLevel;
    if (compatibilityLevel === "unsupported" || compatibilityLevel === "metadata-only") {
      const migration = inspection.manifest?.compatibilityReport?.requiresManualMigration === true
        ? "该 Skill 需要手工迁移后才能使用（见兼容报告）"
        : "该 Skill 仅有元数据或格式不兼容，无法执行";
      this.emit("skill.install.rejected", agentId, sessionId, {
        sourceRef: sourceRef.slice(0, 240),
        kind,
        reasonCode: "skill_source_unsupported",
        compatibilityLevel,
      });
      return rejectedInstall(
        "skill_source_unsupported",
        `Skill 兼容等级为 ${compatibilityLevel}，拒绝安装：${migration}`,
      );
    }

    // 4. 风险审查 + 学习策略决定是否确认
    const riskLevel = riskLevelOf(inspection.manifest, risks);
    const trusted = this.decideTrust(sourceRef, kind);
    const needConfirmation =
      policy === "ask-always" || (policy === "ask-on-risk" && (!trusted || riskLevel !== "low"));

    if (needConfirmation) {
      const target: ConfirmationTarget = {
        sourceRef,
        ...(inspection.contentHash !== "" ? { version, contentHash: inspection.contentHash } : { version }),
        agentId: agentId ?? "",
        ...(sessionId !== undefined ? { sessionId } : {}),
        operationType: "install",
      };
      if (input.confirmationToken === undefined) {
        const issued = this.deps.confirmations.issue({
          target,
          reason: riskReason(policy, trusted, riskLevel, risks),
          ...(riskLevel !== undefined ? { riskLevel } : {}),
          ttlMs: this.deps.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS,
        });
        this.emit("skill.install.confirmation_requested", agentId, sessionId, {
          sourceRef: sourceRef.slice(0, 240),
          kind,
          riskLevel,
          trusted: trusted ? 1 : 0,
          policy,
        });
        return {
          status: "confirmation_required",
          loadHandle: null,
          confirmation: {
            token: issued.token,
            expiresAt: issued.expiresAt,
            operationType: "install",
            reason: riskReason(policy, trusted, riskLevel, risks),
            ...(riskLevel !== undefined ? { riskLevel } : {}),
          },
          risks: [...risks],
        };
      }
      const outcome = this.deps.confirmations.consumeConfirmation({ token: input.confirmationToken, target });
      if (outcome.status === "rejected") {
        this.emit("skill.install.rejected", agentId, sessionId, {
          sourceRef: sourceRef.slice(0, 240),
          kind,
          reasonCode: outcome.reasonCode,
        });
        return rejectedInstall(outcome.reasonCode, outcome.reason);
      }
      this.emit("skill.install.confirmed", agentId, sessionId, { sourceRef: sourceRef.slice(0, 240), kind, version });
    }

    // 5. 安装不可变 Artifact（installer 内部发出 started/completed/failed + 严格审计）
    let installed: Awaited<ReturnType<SkillInstaller["install"]>>;
    try {
      installed = this.deps.installer.install({
        sourceRef,
        kind,
        trust: trusted,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    } catch (error) {
      return failedInstall(extractReasonCode(error), error instanceof Error ? error.message : "安装失败");
    }

    // 6. 绑定当前 Agent（或 Session-only / 不绑定）
    let agentBinding: "bound" | "session-only" | "unchanged" = "unchanged";
    try {
      if (agentId !== undefined) {
        const bound = this.deps.agentService.bindSkill({
          agentId,
          skillRef: installed.skillRef,
          actor: this.actorFor(agentId),
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
        agentBinding = bound.status === "bound" ? "bound" : "unchanged";
      } else if (sessionId !== undefined) {
        this.deps.sessionService.bindTemporary({ sessionId, skillRef: installed.skillRef });
        agentBinding = "session-only";
      }
    } catch (error) {
      return {
        status: "failed",
        skillRef: installed.skillRef,
        skillRefKey: installed.skillRefKey,
        operationId: installed.operationId,
        idempotent: installed.idempotent,
        agentBinding: "unchanged",
        loadHandle: null,
        reasonCode: "skill_operation_failed",
        reason: `安装已完成但绑定失败（${error instanceof Error ? error.message : "未知错误"}），可重试安装完成绑定`,
      };
    }

    // 7. 当前 turn 激活授权 overlay + loadHandle（仅会话内安装：sessionId + turnId）
    // T11（P1-9）：grant/loadHandle 签发失败不得静默 installed——安装与绑定已
    // 持久化，但当前 turn 的受控读取能力未建立；返回 failed（保留 skillRef/
    // operationId 与已安装事实，可重试完成授权），绝不假装已具备读取权。
    let activationGrant: "granted" | "unavailable" = "unavailable";
    let grantId: string | undefined;
    let loadHandle: string | null = null;
    if (sessionId !== undefined) {
      const turnId = input.turnId ?? this.resolveTurnId();
      try {
        const grant = this.deps.sessionService.issueActivationGrant({
          agentId: agentId ?? "",
          sessionId,
          skillRef: installed.skillRef,
          issuedTurnId: turnId,
          ttlMs: this.deps.activationGrantTtlMs ?? DEFAULT_ACTIVATION_GRANT_TTL_MS,
          reason: "session-install",
        });
        activationGrant = "granted";
        grantId = grant.grantId;
      } catch (error) {
        return {
          status: "failed",
          skillRef: installed.skillRef,
          skillRefKey: installed.skillRefKey,
          operationId: installed.operationId,
          idempotent: installed.idempotent,
          agentBinding,
          loadHandle: null,
          reasonCode: "skill_activation_denied",
          reason: `安装与绑定已完成，但激活授权签发失败（${error instanceof Error ? error.message : "未知错误"}），当前 turn 无法受控读取，可重试`,
        };
      }
      try {
        const handle = this.deps.loadHandles.issueLoadHandle({
          turnId,
          sessionId,
          skillRef: installed.skillRef,
          contentHash: installed.skillRef.contentHash,
          ttlMs: this.deps.loadHandleTtlMs ?? DEFAULT_LOAD_HANDLE_TTL_MS,
        });
        loadHandle = handle.handleId;
      } catch (error) {
        // T12（P1-2）：loadHandle 签发失败必须撤销刚签发的 activation grant——
        // 不得遗留"结果 failed 但当前 turn 授权仍有效"的不一致状态（补偿证据保留）
        if (grantId !== undefined) {
          try {
            this.deps.sessionService.revokeActivationGrant({ grantId, sessionId, reason: "load-handle-issue-failed" });
          } catch (revokeError) {
            // 撤销失败也要返回 failed（fail-closed：不假装成功）
            return {
              status: "failed",
              skillRef: installed.skillRef,
              skillRefKey: installed.skillRefKey,
              operationId: installed.operationId,
              idempotent: installed.idempotent,
              agentBinding,
              loadHandle: null,
              reasonCode: "skill_operation_failed",
              reason: `安装与绑定已完成，但 loadHandle 签发失败且授权补偿撤销失败（${revokeError instanceof Error ? revokeError.message : "未知错误"}）`,
            };
          }
        }
        return {
          status: "failed",
          skillRef: installed.skillRef,
          skillRefKey: installed.skillRefKey,
          operationId: installed.operationId,
          idempotent: installed.idempotent,
          agentBinding,
          loadHandle: null,
          reasonCode: "skill_operation_failed",
          reason: `安装与绑定已完成，但 loadHandle 签发失败（${error instanceof Error ? error.message : "未知错误"}），activation grant 已撤销，当前 turn 无法受控读取，可重试`,
        };
      }
    }

    const result: SkillInstallResult = {
      status: "installed",
      skillRef: installed.skillRef,
      skillRefKey: installed.skillRefKey,
      operationId: installed.operationId,
      idempotent: installed.idempotent,
      agentBinding,
      activationGrant,
      ...(grantId !== undefined ? { grantId } : {}),
      loadHandle,
      risks: [...installed.risks],
    };
    if (!Value.Check(SkillInstallResultSchema, result)) {
      throw new SkillError("skill_operation_failed", "安装结果不符合冻结契约 schema（fail-closed）");
    }
    return result;
  }

  // ── 确认审批（UI/命令入口）─────────────────────────────────────

  approveConfirmation(input: { readonly token: string; readonly agentId?: string; readonly sessionId?: string }): ApproveConfirmationResult {
    const outcome = this.deps.confirmations.approveSkillAction({
      token: input.token,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (outcome.status === "rejected") {
      return { status: "rejected", reasonCode: outcome.reasonCode, reason: outcome.reason };
    }
    if (outcome.record.target.operationType === "install") {
      this.emit("skill.install.confirmed", outcome.record.target.agentId === "" ? undefined : outcome.record.target.agentId, outcome.record.target.sessionId, {
        sourceRef: outcome.record.target.sourceRef.slice(0, 240),
        operationType: "install",
      });
    }
    return { status: "approved", token: input.token };
  }

  // ── manage_skills（只管理当前 Agent）───────────────────────────

  manageSkills(input: { readonly action: SkillManageArgs["action"]; readonly agentId: string; readonly sessionId?: string; readonly skillRef?: SkillRef; readonly skillRefKey?: string; readonly selection?: "implicit" | "explicit-only" | "disabled"; readonly confirmationToken?: string }): SkillManageResult {
    const { action, agentId } = input;
    const sessionId = input.sessionId;
    const actor = this.actorFor(agentId);
    try {
      return this.manageSkillsInner(input, action, agentId, sessionId, actor);
    } catch (error) {
      return manageFailed(action, agentId, extractReasonCode(error), error instanceof Error ? error.message : "操作失败");
    }
  }

  private manageSkillsInner(
    input: { readonly action: SkillManageArgs["action"]; readonly agentId: string; readonly sessionId?: string; readonly skillRef?: SkillRef; readonly skillRefKey?: string; readonly selection?: "implicit" | "explicit-only" | "disabled"; readonly confirmationToken?: string },
    action: SkillManageArgs["action"],
    agentId: string,
    sessionId: string | undefined,
    actor: ActorRef,
  ): SkillManageResult {
    switch (action) {
      case "list": {
        const view = this.deps.agentService.listAgentSkills(agentId, this.deps.environment);
        return {
          status: "ok",
          action,
          agentId,
          view: {
            visible: view.visible.map((skill) => ({ skillRefKey: skill.skillRefKey, skillId: skill.skillId, displayName: skill.displayName, version: skill.skillRef.version, pinned: skill.pinned, selection: skill.status.selection, readiness: skill.status.readiness })),
            shadowed: view.shadowed.map((skill) => ({ skillRefKey: skill.skillRefKey, skillId: skill.skillId, displayName: skill.displayName })),
            disabled: view.disabled.map((skill) => ({ skillRefKey: skill.skillRefKey, skillId: skill.skillId, displayName: skill.displayName })),
            gated: view.gated.map((skill) => ({ skillRefKey: skill.skillRefKey, skillId: skill.skillId, displayName: skill.displayName, blockedReason: skill.status.blockedReason ?? "" })),
            diagnostics: view.diagnostics,
            learningPolicy: view.bindings.learningPolicy,
            bundleBindings: view.bindings.bundleBindings,
            overrides: view.bindings.overrides,
          },
        };
      }
      case "bind": {
        if (input.skillRef === undefined) {
          return manageFailed(action, agentId, "skill_unknown_skillref", "bind 需要精确 skillRef");
        }
        try {
          const result = this.deps.agentService.bindSkill({
            agentId,
            skillRef: input.skillRef,
            actor,
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return {
            status: "ok",
            action,
            agentId,
            result: { status: result.status, skillRefKey: result.skillRefKey, ...(result.status === "bound" ? { selection: result.selection, configRevision: result.configRevision } : {}) },
          };
        } catch (error) {
          return manageFailed(action, agentId, extractReasonCode(error), error instanceof Error ? error.message : "绑定失败");
        }
      }
      case "set-selection": {
        const skillRefKeyOf = input.skillRefKey;
        const selection = input.selection;
        if (skillRefKeyOf === undefined || selection === undefined) {
          return manageFailed(action, agentId, "skill_unknown_skillref", "set-selection 需要 skillRefKey 与 selection");
        }
        let confirmed = selection !== "disabled";
        if (selection === "disabled" && input.confirmationToken !== undefined) {
          const outcome = this.deps.confirmations.consumeConfirmation({
            token: input.confirmationToken,
            target: { sourceRef: skillRefKeyOf, agentId, ...(sessionId !== undefined ? { sessionId } : {}), operationType: "set-selection-disabled" },
          });
          if (outcome.status === "rejected") {
            return manageFailed(action, agentId, outcome.reasonCode, outcome.reason);
          }
          confirmed = true;
        }
        try {
          const result = this.deps.agentService.setSelection({
            agentId,
            skillRefKey: skillRefKeyOf,
            selection,
            confirmed,
            actor,
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          if (result.status === "confirmation_required") {
            const confirmation = this.issueManageConfirmation({
              sourceRef: skillRefKeyOf,
              agentId,
              ...(sessionId !== undefined ? { sessionId } : {}),
              operationType: "set-selection-disabled",
              reason: result.reason,
            });
            return { status: "confirmation_required", action, agentId, confirmation };
          }
          return { status: "ok", action, agentId, result: { status: result.status, skillRefKey: result.skillRefKey, ...(result.status === "changed" ? { selection: result.selection, configRevision: result.configRevision } : {}) } };
        } catch (error) {
          return manageFailed(action, agentId, extractReasonCode(error), error instanceof Error ? error.message : "选择变更失败");
        }
      }
      case "unbind":
      case "request-unbind": {
        const skillRefKeyOf = input.skillRefKey;
        if (skillRefKeyOf === undefined) {
          return manageFailed(action, agentId, "skill_unknown_skillref", `${action} 需要 skillRefKey`);
        }
        let confirmed = false;
        if (input.confirmationToken !== undefined) {
          const outcome = this.deps.confirmations.consumeConfirmation({
            token: input.confirmationToken,
            target: { sourceRef: skillRefKeyOf, agentId, ...(sessionId !== undefined ? { sessionId } : {}), operationType: "unbind" },
          });
          if (outcome.status === "rejected") {
            return manageFailed(action, agentId, outcome.reasonCode, outcome.reason);
          }
          confirmed = true;
        }
        try {
          const result = this.deps.agentService.unbindSkill({
            agentId,
            skillRefKey: skillRefKeyOf,
            confirmed,
            actor,
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          if (result.status === "confirmation_required") {
            const confirmation = this.issueManageConfirmation({
              sourceRef: skillRefKeyOf,
              agentId,
              ...(sessionId !== undefined ? { sessionId } : {}),
              operationType: "unbind",
              reason: result.reason,
            });
            return { status: "confirmation_required", action, agentId, confirmation };
          }
          return { status: "ok", action, agentId, result: { status: result.status, skillRefKey: result.skillRefKey, ...(result.status === "unbound" ? { configRevision: result.configRevision } : {}) } };
        } catch (error) {
          return manageFailed(action, agentId, extractReasonCode(error), error instanceof Error ? error.message : "解绑失败");
        }
      }
    }
  }

  // ── manage_skill_bundle（版本化组合；不原地覆盖已发布 Bundle）───

  manageBundle(input: { readonly action: SkillBundleManageArgs["action"]; readonly agentId?: string; readonly sessionId?: string; readonly bundleId?: string; readonly name?: string; readonly items?: readonly { readonly skillRef: SkillRef; readonly selection?: "implicit" | "explicit-only" | "disabled" }[]; readonly version?: string; readonly fromVersion?: string; readonly toVersion?: string; readonly confirmationToken?: string }): SkillBundleResult {
    const { action } = input;
    const sessionId = input.sessionId;

    switch (action) {
      case "list": {
        if (input.bundleId === undefined || input.bundleId === "") {
          if (input.agentId === undefined) {
            return bundleFailed(action, "skill_unknown_skillref", "list 需要 bundleId 或 agentId");
          }
          const config = this.deps.agentService.getSkillsConfig(input.agentId);
          return {
            status: "ok",
            action,
            agentId: input.agentId,
            result: { bundleBindings: config.bundleBindings },
          };
        }
        const versions = this.deps.bundleService.listBundleVersions(input.bundleId);
        return {
          status: "ok",
          action,
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          bundles: versions.map((record) => ({
            bundleId: record.bundleId,
            version: record.version,
            contentHash: record.contentHash,
            name: record.name,
            createdAt: record.createdAt,
            itemCount: record.items.length,
          })),
        };
      }
      case "create-version": {
        if (input.bundleId === undefined || input.name === undefined || input.items === undefined || input.items.length === 0) {
          return bundleFailed(action, "skill_operation_failed", "create-version 需要 bundleId、name 与 items");
        }
        const actor = input.agentId !== undefined ? this.actorFor(input.agentId) : this.actorFor("bundle-owner");
        try {
          const record = this.deps.bundleService.createBundle({
            bundleId: input.bundleId,
            name: input.name,
            items: input.items.map((item) => ({ skillRef: item.skillRef, ...(item.selection !== undefined ? { selection: item.selection } : {}) })),
            sourceKind: "managed",
            sourceId: "agent-tool",
            actor,
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return {
            status: "ok",
            action,
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            result: { status: "created", bundleId: record.bundleId, version: record.version, contentHash: record.contentHash },
          };
        } catch (error) {
          return bundleFailed(action, extractReasonCode(error), error instanceof Error ? error.message : "Bundle 版本化失败");
        }
      }
      case "bind": {
        if (input.agentId === undefined || input.bundleId === undefined || input.version === undefined) {
          return bundleFailed(action, "skill_unknown_skillref", "bind 需要 agentId、bundleId 与 version");
        }
        try {
          const result = this.deps.bundleService.bindBundleToAgent({
            agentId: input.agentId,
            bundleId: input.bundleId,
            version: input.version,
            actor: this.actorFor(input.agentId),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return { status: "ok", action, agentId: input.agentId, result: { status: "bound", bundleId: result.bundleId, version: result.version, configRevision: result.configRevision } };
        } catch (error) {
          return bundleFailed(action, extractReasonCode(error), error instanceof Error ? error.message : "Bundle 绑定失败");
        }
      }
      case "migrate": {
        if (input.agentId === undefined || input.bundleId === undefined || input.fromVersion === undefined || input.toVersion === undefined) {
          return bundleFailed(action, "skill_unknown_skillref", "migrate 需要 agentId、bundleId、fromVersion 与 toVersion");
        }
        const target: ConfirmationTarget = {
          sourceRef: `bundle:${input.bundleId}@${input.fromVersion}`,
          version: input.toVersion,
          agentId: input.agentId,
          ...(sessionId !== undefined ? { sessionId } : {}),
          operationType: "bundle-migrate",
        };
        if (input.confirmationToken !== undefined) {
          const outcome = this.deps.confirmations.consumeConfirmation({ token: input.confirmationToken, target });
          if (outcome.status === "rejected") {
            return bundleFailed(action, outcome.reasonCode, outcome.reason);
          }
        } else {
          const confirmation = this.issueManageConfirmation({
            sourceRef: target.sourceRef,
            agentId: input.agentId,
            ...(sessionId !== undefined ? { sessionId } : {}),
            operationType: "bundle-migrate",
            reason: "固定版本迁移需要用户确认（Agent 不得无确认迁移自己的 Skill）",
          });
          return { status: "confirmation_required", action, agentId: input.agentId, confirmation };
        }
        try {
          const from = this.deps.bundleService.getBundle(input.bundleId, input.fromVersion);
          const to = this.deps.bundleService.getBundle(input.bundleId, input.toVersion);
          const result = this.deps.bundleService.migrateBundle({
            agentId: input.agentId,
            from: { bundleId: input.bundleId, version: input.fromVersion, contentHash: from?.contentHash ?? "" },
            to: { bundleId: input.bundleId, version: input.toVersion, contentHash: to?.contentHash ?? "" },
            actor: this.actorFor(input.agentId),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return { status: "ok", action, agentId: input.agentId, result: { status: "migrated", bundleId: result.bundleId, version: result.version, configRevision: result.configRevision } };
        } catch (error) {
          return bundleFailed(action, extractReasonCode(error), error instanceof Error ? error.message : "Bundle 迁移失败");
        }
      }
    }
  }

  // ── 内部辅助 ─────────────────────────────────────────────────

  private assertInstallSource(sourceRef: string, kind: SkillInstallSourceKind, sessionId: string | undefined): void {
    if (kind === "session-file") {
      if (sessionId === undefined || sessionId.trim() === "") {
        throw new SkillError("skill_content_read_denied", "SessionFile 安装必须提供 sessionId");
      }
      const registration = this.deps.sessionFiles.get(sourceRef);
      if (registration === undefined) {
        throw new SkillError("skill_content_read_denied", "SessionFile 未登记（fileKey 不存在），拒绝引用");
      }
      if (registration.sessionId !== sessionId) {
        throw new SkillError("skill_content_read_denied", "SessionFile 不属于当前会话，拒绝引用");
      }
      return;
    }
    if (kind === "local" || kind === "archive") {
      // 服务端路径：必须通过来源信任判定（拒绝客户端任意绝对路径）
      if (!this.isServerPathTrusted(sourceRef)) {
        throw new SkillError("skill_content_read_denied", "本地安装路径未登记且不在信任根内（不接受客户端任意绝对路径）");
      }
      return;
    }
    // git / http：sourceRef 是 URL，不涉及本地路径
  }

  /** 服务端路径信任判定：来源级 trusted 或落在用户显式信任根目录内。 */
  private isServerPathTrusted(sourceRef: string): boolean {
    if (this.deps.trust === undefined) {
      return false;
    }
    const decision = this.deps.trust.evaluate({ sourceKind: "external", sourceId: sourceRef, rootPath: sourceRef });
    if (decision.trusted) {
      return true;
    }
    return this.deps.trust.isRootTrusted(sourceRef);
  }

  private decideTrust(sourceRef: string, kind: SkillInstallSourceKind): boolean {
    if (kind === "session-file") {
      return true; // 服务端已登记 + 哈希校验
    }
    if (kind === "local" || kind === "archive") {
      return this.isServerPathTrusted(sourceRef);
    }
    const decision = this.deps.trust?.evaluate({ sourceKind: "external", sourceId: sourceRef });
    return decision?.trusted === true;
  }

  private issueManageConfirmation(input: { readonly sourceRef: string; readonly agentId: string; readonly sessionId?: string; readonly operationType: "unbind" | "set-selection-disabled" | "bundle-migrate"; readonly reason: string }): ConfirmationView {
    const issued = this.deps.confirmations.issue({
      target: {
        sourceRef: input.sourceRef,
        agentId: input.agentId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        operationType: input.operationType,
      },
      reason: input.reason,
      ttlMs: this.deps.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS,
    });
    return { token: issued.token, expiresAt: issued.expiresAt, operationType: input.operationType, reason: input.reason };
  }

  private actorFor(agentId: string): ActorRef {
    return this.deps.actor ?? { kind: "agent", id: agentId };
  }

  private resolveTurnId(): string {
    return `turn-${crypto.randomUUID()}`;
  }

  private emit(
    eventName: "skill.inspect.started" | "skill.inspect.completed" | "skill.inspect.failed" | "skill.install.confirmation_requested" | "skill.install.confirmed" | "skill.install.rejected",
    agentId: string | undefined,
    sessionId: string | undefined,
    attributes: Record<string, string | number | boolean>,
    operationId?: string,
  ): string | undefined {
    const resolvedOperationId = operationId ?? `skill-core-${crypto.randomUUID().slice(0, 8)}`;
    const scope: EventScope | undefined =
      agentId !== undefined
        ? { ownerAgentId: agentId, ...(sessionId !== undefined ? { sessionId } : {}) }
        : sessionId !== undefined
          ? { sessionId }
          : undefined;
    const status = eventName.endsWith(".started")
      ? ("started" as const)
      : eventName.endsWith(".failed")
        ? ("failed" as const)
        : eventName.endsWith(".completed")
          ? ("completed" as const)
          : undefined;
    instrument.activity({
      eventName,
      operationId: resolvedOperationId,
      ...(status !== undefined ? { status } : {}),
      actor: { kind: "system", id: "skill-core" },
      executor: EXECUTOR,
      ...(scope !== undefined ? { scope } : {}),
      payload: { summaryCode: eventName.replace(/\./g, "_"), attributes },
    });
    return resolvedOperationId;
  }
}

// ── 模块级辅助 ─────────────────────────────────────────────────

function toSafeSkillView(skill: RegisteredSkill): SafeSkillView {
  return {
    skillRef: skill.skillRef,
    skillRefKey: skillRefKey(skill.skillRef),
    skillId: skill.skillId,
    displayName: skill.displayName,
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    version: skill.version,
    sourceId: skill.sourceId,
    sourceKind: skill.sourceKind,
    contentHash: skill.contentHash,
    sizeBytes: skill.sizeBytes,
    fileCount: skill.fileCount,
    status: skill.status,
    compatibility: skill.compatibility,
    provenance: skill.provenance ?? null,
    validityErrors: [...skill.validityErrors],
  };
}

function toBoundHit(skill: { readonly skillRef: SkillRef; readonly skillRefKey: string; readonly skillId: string; readonly displayName: string; readonly description: string | undefined; readonly rootPath: string; readonly status: SkillStatus; readonly compatibility: SkillCompatibilityReport | null; readonly pinned: boolean }): SkillSearchHit {
  return {
    layer: "bound",
    sourceKind: skill.skillRef.sourceKind,
    skillId: skill.skillId,
    skillRefKey: skill.skillRefKey,
    displayName: skill.displayName,
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    version: skill.skillRef.version,
    sourceId: skill.skillRef.sourceId,
    contentHash: skill.skillRef.contentHash,
    skillRef: skill.skillRef,
    pinned: skill.pinned,
    status: skill.status,
    compatibility: skill.compatibility,
    readiness: skill.status.readiness,
    risks: [...assessPackageRisks(skill.rootPath)],
    bindable: true,
  };
}

function toCatalogHit(layer: "managed" | "plugin", skill: RegisteredSkill): SkillSearchHit {
  return {
    layer,
    sourceKind: skill.sourceKind,
    skillId: skill.skillId,
    skillRefKey: skillRefKey(skill.skillRef),
    displayName: skill.displayName,
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    version: skill.version,
    sourceId: skill.sourceId,
    contentHash: skill.contentHash,
    skillRef: skill.skillRef,
    status: skill.status,
    compatibility: skill.compatibility,
    readiness: skill.status.readiness,
    risks: [...assessPackageRisks(skill.rootPath)],
    bindable: true,
  };
}

function toDiscoveredHit(
  layer: "workspace",
  candidate: { readonly displayName: string; readonly description?: string; readonly version?: string; readonly sourceId: string },
  inspection: SkillSourceInspection,
  registered: RegisteredSkill | undefined,
): SkillSearchHit {
  const manifest = inspection.manifest;
  return {
    layer,
    sourceKind: "workspace",
    skillId: manifest?.name ?? candidate.displayName,
    ...(registered !== undefined ? { skillRefKey: skillRefKey(registered.skillRef) } : {}),
    displayName: candidate.displayName,
    ...(candidate.description !== undefined ? { description: candidate.description } : {}),
    version: candidate.version ?? "0.0.0",
    sourceId: candidate.sourceId,
    contentHash: inspection.contentHash,
    ...(registered !== undefined ? { skillRef: registered.skillRef } : {}),
    ...(registered !== undefined ? { status: registered.status, readiness: registered.status.readiness } : {}),
    compatibility: inspection.compatibility,
    risks: [...(inspection.risks ?? [])],
    bindable: registered !== undefined,
    installHint: { sourceRef: candidate.sourceId, kind: "local" },
  };
}

function matchesQuery(displayName: string, skillId: string, description: string | undefined, needle: string): boolean {
  if (needle === "") {
    return true;
  }
  return (
    displayName.toLowerCase().includes(needle) ||
    skillId.toLowerCase().includes(needle) ||
    (description ?? "").toLowerCase().includes(needle)
  );
}

function riskLevelOf(manifest: { readonly opencolorful?: { readonly risk?: "low" | "medium" | "high" } } | null, risks: readonly SkillRiskMarker[]): "low" | "medium" | "high" {
  const declared = manifest?.opencolorful?.risk;
  if (declared !== undefined) {
    return declared;
  }
  if (risks.some((risk) => risk.code === "scripts")) {
    return "high";
  }
  return "low";
}

function riskReason(policy: SkillLearningPolicy, trusted: boolean, riskLevel: "low" | "medium" | "high", risks: readonly SkillRiskMarker[]): string {
  if (policy === "ask-always") {
    return "学习策略为 ask-always：每次安装都需要用户确认";
  }
  if (!trusted) {
    return "来源未被信任，需要用户确认后才能安装";
  }
  if (riskLevel !== "low") {
    const riskNames = [...new Set(risks.map((risk) => risk.code))].join("、");
    return `风险等级 ${riskLevel}${riskNames !== "" ? `（${riskNames}）` : ""}，需要用户确认后才能安装`;
  }
  return "需要用户确认";
}

function failedInstall(reasonCode: SkillErrorCode, reason: string): SkillInstallResult {
  return { status: "failed", loadHandle: null, reasonCode, reason };
}

/** 策略/确认拒绝（rejected：不产生任何领域修改）。 */
function rejectedInstall(reasonCode: SkillErrorCode, reason: string): SkillInstallResult {
  return { status: "rejected", loadHandle: null, reasonCode, reason };
}

function failedInspect(reasonCode: SkillErrorCode, reason: string, sourceRef: string, kind: SkillInstallSourceKind | undefined): SkillInspectResult {
  return {
    ok: false,
    reasonCode,
    reason,
    sourceRef,
    ...(kind !== undefined ? { kind } : {}),
  };
}

function manageFailed(action: SkillManageArgs["action"], agentId: string, reasonCode: SkillErrorCode, reason: string): SkillManageResult {
  return { status: "failed", action, agentId, reasonCode, reason };
}

function bundleFailed(action: SkillBundleManageArgs["action"], reasonCode: SkillErrorCode, reason: string): SkillBundleResult {
  return { status: "failed", action, reasonCode, reason };
}

export function extractReasonCode(error: unknown): SkillErrorCode {
  if (error instanceof SkillError) {
    return error.code;
  }
  return "skill_operation_failed";
}

/**
 * T12（P0-1）：路径 canonical 化（消除符号链接/Junction），与 PathGuard 语义
 * 一致——路径存在 → realpath；不存在 → 向上遍历到最近存在的祖先拼接剩余
 * 相对路径。用于 Skill 根匹配，防止 Junction 别名绕过当前 Turn 快照检查。
 */
function canonicalResolve(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    let current = targetPath;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        return targetPath;
      }
      try {
        const realParent = fs.realpathSync.native(parent);
        return path.join(realParent, path.relative(parent, targetPath));
      } catch {
        current = parent;
      }
    }
  }
}
