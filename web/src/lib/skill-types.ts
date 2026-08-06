// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Skill Web 类型（plans/phase-13.md §14.1 / §14.4）
//
// 与 Server /api/skills*、/api/skill-sources、/api/agents/:id/skills
// 契约一一对应；跨边界数据在 Server 侧过 TypeBox（此处为展示类型）。
// ═══════════════════════════════════════════════════════════════

export type SkillSourceKind = "builtin" | "managed" | "plugin" | "workspace" | "external";

export interface SkillRef {
  readonly skillId: string;
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  readonly version: string;
  readonly contentHash: string;
}

export type SkillValidity = "valid" | "invalid";
export type SkillTrust = "trusted" | "untrusted";
export type SkillReadiness = "ready" | "degraded" | "blocked" | "incompatible";
export type SkillSelectionMode = "implicit" | "explicit-only" | "disabled" | "shadowed";

export interface SkillStatus {
  readonly validity: SkillValidity;
  readonly trust: SkillTrust;
  readonly readiness: SkillReadiness;
  readonly selection: SkillSelectionMode;
  readonly blockedReason?: string;
}

export interface SkillCompatibilityReport {
  readonly level: "native" | "pi-compatible" | "openclaw" | "hermes" | "metadata-only" | "unsupported";
  readonly missing: readonly string[];
  readonly degradation?: string;
  readonly requiresManualMigration: boolean;
}

export interface SkillProvenance {
  readonly sourceRef: string;
  readonly fetchedAt: string;
  readonly originalUrl?: string;
  readonly license?: string;
}

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

export interface SkillRiskMarker {
  readonly code: "scripts" | "binary" | "unknown-file-type";
  readonly message: string;
  readonly path?: string;
}

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
  readonly installHint?: { readonly sourceRef: string; readonly kind: string };
}

export interface SkillSearchResult {
  readonly layers: readonly string[];
  readonly hits: readonly SkillSearchHit[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  readonly remote: { readonly available: boolean; readonly note: string };
}

export interface SkillInspectManifest {
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
}

export interface SkillInspectResult {
  readonly ok: boolean;
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly sourceRef: string;
  readonly kind?: string;
  readonly skillId?: string;
  readonly skillRefKey?: string;
  readonly version?: string;
  readonly contentHash?: string;
  readonly sizeBytes?: number;
  readonly fileCount?: number;
  readonly manifest?: SkillInspectManifest;
  readonly compatibility?: SkillCompatibilityReport | null;
  readonly risks?: readonly SkillRiskMarker[];
  readonly provenance?: SkillProvenance | null;
  readonly status?: SkillStatus;
  readonly readiness?: SkillReadiness;
  readonly body?: string;
  readonly truncated?: boolean;
  readonly fileHash?: string;
}

export interface SkillConfirmationView {
  readonly token: string;
  readonly expiresAt: string;
  readonly operationType: string;
  readonly reason: string;
  readonly riskLevel?: "low" | "medium" | "high";
}

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
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly confirmation?: SkillConfirmationView;
  readonly risks?: readonly SkillRiskMarker[];
}

export interface SkillManageResult {
  readonly status: "ok" | "confirmation_required" | "rejected" | "failed";
  readonly action: string;
  readonly agentId: string;
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly confirmation?: SkillConfirmationView;
  readonly result?: Record<string, unknown>;
  readonly view?: AgentSkillsViewData;
}

export interface AgentSkillEntry {
  readonly skillRefKey: string;
  readonly skillId: string;
  readonly displayName: string;
  readonly version: string;
  readonly pinned?: boolean;
  readonly selection?: string;
  readonly readiness?: string;
  readonly blockedReason?: string;
}

export interface AgentSkillsViewData {
  readonly visible: readonly AgentSkillEntry[];
  readonly shadowed: readonly AgentSkillEntry[];
  readonly disabled: readonly AgentSkillEntry[];
  readonly gated: readonly AgentSkillEntry[];
  readonly diagnostics: readonly { readonly skillId: string; readonly code: string; readonly message: string }[];
  readonly learningPolicy: "disabled" | "ask-always" | "ask-on-risk";
  readonly bundleBindings: readonly { readonly bundleId: string; readonly version: string; readonly pinned: boolean }[];
  readonly overrides: Readonly<Record<string, string>>;
}

export interface SkillBundleResult {
  readonly status: "ok" | "confirmation_required" | "rejected" | "failed";
  readonly action: string;
  readonly agentId?: string;
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly confirmation?: SkillConfirmationView;
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

export interface BundleAdminView {
  readonly bundleId: string;
  readonly name: string;
  readonly versions: readonly {
    readonly version: string;
    readonly contentHash: string;
    readonly createdAt: string;
    readonly itemCount: number;
  }[];
}

export interface BundleListResult {
  readonly bundles: readonly BundleAdminView[];
}

export interface CompatibilityRootView {
  readonly root: string;
  readonly exists: boolean;
  readonly trusted: boolean;
}

export interface SourceConfigDocument {
  readonly version: 1;
  readonly trustedRoots: readonly string[];
  readonly disabledKinds: readonly SkillSourceKind[];
  readonly trustedSourceIds: Readonly<Record<string, boolean>>;
}

export interface SourceConfigView {
  readonly config: SourceConfigDocument;
  readonly compatibilityRoots: readonly CompatibilityRootView[];
}

export interface LinkedSourceStatusView {
  readonly sourceId: string;
  readonly rootPath: string;
  readonly linkedAt: string;
  readonly valid: boolean;
  readonly skillName: string | null;
  readonly version: string | null;
  readonly contentHash: string | null;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly errors: readonly string[];
}

export interface SkillFileEntry {
  readonly rel: string;
  readonly sizeBytes: number;
}

export interface SkillFileTree {
  readonly skillRefKey: string;
  readonly files: readonly SkillFileEntry[];
}

export interface SkillDetailResult {
  readonly view: SafeSkillView;
  readonly body?: string;
  readonly truncated?: boolean;
  readonly bodyUnavailable?: string;
}

export type SkillLearningPolicy = "disabled" | "ask-always" | "ask-on-risk";

export interface SetLearningPolicyResult {
  readonly status: "changed" | "confirmation_required";
  readonly agentId: string;
  readonly policy?: SkillLearningPolicy;
  readonly reason?: string;
}
