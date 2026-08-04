// ═══════════════════════════════════════════════════════════════
// Phase 12 插件系统 Web 端镜像类型
//
// 与 @opencolorful/plugin-protocol（packages/plugin-protocol）及
// plans/phase-12.md §十八 API 契约对齐。Web 运行时不得 import 协议包，
// 本文件是 Server 协议在 Web 端的唯一镜像来源。
//
// 约定：
// - Manifest / Compatibility / Grant / Binding 字段与协议包保持一致；
// - 面向 API 的响应类型（PluginInstallView 等）按 §十八 契约语义定义，
//   字段尽可能宽松（readonly + 合理缺省），Server 端点缺失时 UI 走降级空态。
// ═══════════════════════════════════════════════════════════════

// ── Manifest / 信任 / 运行形态 ─────────────────────────────────
export type PluginTrust = "restricted" | "full-access";
export type PluginRuntimeKind = "bundle" | "mcp" | "node-process" | "python-process";
export type PluginSourceType = "local" | "zip" | "git" | "npm" | "openclaw" | "hermes" | "mcp";

export type PluginStatus =
  | "discovered"
  | "staged"
  | "installed"
  | "enabled"
  | "degraded"
  | "disabled"
  | "failed"
  | "removed";

export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

export interface PluginManifestCompatibility {
  readonly opencolorful: string;
  readonly pluginApi: 1;
}

export interface PluginManifestRuntime {
  readonly kind: PluginRuntimeKind;
  /** 代码插件的入口文件（相对插件根）；bundle/mcp 可省略 */
  readonly entry?: string;
}

export interface PluginManifestDev {
  readonly sourceDir?: string;
  readonly engines?: Record<string, string>;
}

// ── 权限 ───────────────────────────────────────────────────────
export type PluginCapabilityKind =
  | "filesystem.read"
  | "filesystem.write"
  | "network.connect"
  | "process.spawn"
  | "secret.read-own"
  | "provider.register"
  | "tool.register"
  | "route.register"
  | "ui.surface"
  | "ui.host.external-open"
  | "ui.host.clipboard"
  | "resource.open"
  | "resource.pick"
  | "background.run"
  | "hook.register"
  | "activity.emit";

export interface PluginPermissionRequest {
  readonly capability: PluginCapabilityKind;
  readonly reason?: string;
}

// ── 扩展点（§八 10 类 + skill-bundle 登记） ─────────────────────
export type ContributionKind =
  | "tool"
  | "command"
  | "provider"
  | "route"
  | "page"
  | "widget"
  | "chat-surface"
  | "background"
  | "hook"
  | "config"
  | "secret"
  | "context-attachment"
  | "custom-activity"
  | "skill-bundle";

export interface ContributionBase {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly requiredCapabilities?: readonly string[];
}

export interface ToolContribution extends ContributionBase {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly riskLevel?: "low" | "medium" | "high";
}

export interface CommandContribution extends ContributionBase {
  readonly argumentsSchema?: unknown;
}

export interface ProviderContribution extends ContributionBase {
  readonly configSchema?: unknown;
  readonly kind?: string;
}

export interface RouteContribution extends ContributionBase {
  readonly path: string;
  readonly methods?: readonly string[];
}

export interface SurfaceContribution extends ContributionBase {
  /** 静态资源入口（相对插件根），由受控 asset route 托管 */
  readonly entry?: string;
  readonly hostCapabilities?: readonly string[];
}

export type PageContribution = SurfaceContribution;
export type WidgetContribution = SurfaceContribution;
export type ChatSurfaceContribution = SurfaceContribution;

export interface BackgroundContribution extends ContributionBase {
  readonly maxConcurrency?: number;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export interface HookContribution extends ContributionBase {
  readonly point: string;
  readonly behavior?: "block" | "observe";
}

export interface ConfigContribution extends ContributionBase {
  readonly schema?: unknown;
}

export interface SecretContribution extends ContributionBase {
  readonly secretName: string;
  readonly purpose?: string;
}

export interface ContextAttachmentContribution extends ContributionBase {
  readonly schema?: unknown;
}

export interface CustomActivityContribution extends ContributionBase {
  readonly eventNamespace: string;
  readonly payloadSchema?: unknown;
}

export interface SkillBundleContribution extends ContributionBase {
  readonly skillsDir?: string;
}

export interface PluginContributions {
  readonly tool?: readonly ToolContribution[];
  readonly command?: readonly CommandContribution[];
  readonly provider?: readonly ProviderContribution[];
  readonly route?: readonly RouteContribution[];
  readonly page?: readonly PageContribution[];
  readonly widget?: readonly WidgetContribution[];
  readonly "chat-surface"?: readonly ChatSurfaceContribution[];
  readonly background?: readonly BackgroundContribution[];
  readonly hook?: readonly HookContribution[];
  readonly config?: readonly ConfigContribution[];
  readonly secret?: readonly SecretContribution[];
  readonly "context-attachment"?: readonly ContextAttachmentContribution[];
  readonly "custom-activity"?: readonly CustomActivityContribution[];
  readonly "skill-bundle"?: readonly SkillBundleContribution[];
}

// ── Manifest v1 ────────────────────────────────────────────────
export interface PluginManifestV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: PluginAuthor;
  readonly license?: string;
  readonly compatibility: PluginManifestCompatibility;
  readonly trust: PluginTrust;
  readonly runtime: PluginManifestRuntime;
  readonly permissions: readonly PluginPermissionRequest[];
  readonly contributions: PluginContributions;
  readonly config?: unknown;
  readonly dev?: PluginManifestDev;
}

// ── 来源与校验 ─────────────────────────────────────────────────
export interface PluginSourceRef {
  readonly sourceType: PluginSourceType;
  /** 来源地址/路径/包名（不保存 Secret） */
  readonly ref: string;
  readonly version?: string;
  readonly lock?: string;
}

export interface ArtifactVerification {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly provenance?: unknown;
}

export interface NormalizedPluginSource {
  readonly sourceRef: PluginSourceRef;
  readonly verification: ArtifactVerification;
  readonly provenance?: unknown;
}

export interface NormalizedPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: PluginAuthor;
  readonly license?: string;
  readonly compatibility: PluginManifestCompatibility;
  readonly trust: PluginTrust;
  readonly runtime: PluginManifestRuntime;
  readonly permissions: readonly PluginPermissionRequest[];
  readonly contributions: PluginContributions;
  readonly config?: unknown;
  readonly source: NormalizedPluginSource;
  readonly normalizedAt: string;
}

// ── 兼容性报告 ─────────────────────────────────────────────────
export type CompatibilityLevel = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
/** 不兼容项三色状态：unsupported / degraded / blocked */
export type CompatibilityItemStatus = "supported" | "unsupported" | "degraded" | "blocked";

export interface CompatibilityContributionItem {
  readonly id: string;
  readonly kind: string;
  readonly status: CompatibilityItemStatus;
  readonly reason?: string;
}

export interface CompatibilityReport {
  readonly pluginId: string;
  readonly version: string;
  readonly level: CompatibilityLevel;
  readonly supported: boolean;
  readonly missingCapabilities: readonly string[];
  readonly contributions: readonly CompatibilityContributionItem[];
  readonly blockedReasons: readonly string[];
  readonly requiresFullAccess: boolean;
  readonly requiresRuntime?: string;
}

// ── Grant 与 Agent Binding ─────────────────────────────────────
export type GrantDecision = "allowed" | "denied";

export interface PluginGrant {
  readonly pluginId: string;
  readonly capability: PluginCapabilityKind;
  readonly decision: GrantDecision;
  readonly revision: number;
  readonly grantedAt: string;
  readonly grantedBy: string;
}

export interface AgentPluginBinding {
  readonly agentId: string;
  readonly pluginId: string;
  /** 允许该 Agent 使用的 contribution id 列表（空 = 全部启用） */
  readonly contributions: readonly string[];
  readonly grantRevision: number;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly revision: number;
}

// ── 健康与诊断 ─────────────────────────────────────────────────
export type PluginHealth = "unknown" | "ok" | "degraded" | "error";

export interface PluginDiagnosticCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly message?: string;
}

export interface PluginRecentEvent {
  readonly recordedAt: string;
  readonly eventName: string;
  readonly status: string | null;
  readonly errorCode: string | null;
}

export interface PluginDiagnostics {
  readonly pluginId: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly status: PluginStatus;
  readonly health: PluginHealth;
  readonly checks: readonly PluginDiagnosticCheck[];
  readonly lastError: string | null;
  readonly recentEvents: readonly PluginRecentEvent[];
}

// ── 已安装插件视图（GET /api/plugins）───────────────────────────
export interface PluginInstallView {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  /** 当前激活版本；多版本共存时与 version 可能不同 */
  readonly activeVersion: string | null;
  readonly status: PluginStatus;
  readonly health: PluginHealth;
  readonly trust: PluginTrust;
  readonly runtimeKind: PluginRuntimeKind;
  readonly sourceType: PluginSourceType;
  /** 存在可更新版本时为其版本号，否则 null */
  readonly updateAvailable: string | null;
  readonly rollbackAvailable: boolean;
  readonly installedAt: string;
  readonly enabled: boolean;
  readonly hasSecrets: boolean;
  readonly requiresFullAccess: boolean;
  readonly boundAgentCount?: number;
}

// ── 插件详情（GET /api/plugins/:id）─────────────────────────────
export interface PluginSurfaceInfo {
  readonly contributionId: string;
  readonly name: string;
  /** 受控 asset route 地址；Server asset route 未接线时为 null */
  readonly assetUrl: string | null;
}

export interface PluginRuntimeInfo {
  readonly runtimeKind: PluginRuntimeKind;
  readonly runtimeInstanceId: string | null;
  readonly startedAt: string | null;
  readonly healthy: boolean;
  readonly lastError: string | null;
}

export interface PluginSecretStatus {
  readonly name: string;
  readonly configured: boolean;
}

export interface PluginDetail extends PluginInstallView {
  readonly manifest: NormalizedPluginManifest | null;
  readonly compatibility: CompatibilityReport | null;
  readonly grants: readonly PluginGrant[];
  readonly agentBindings: readonly AgentPluginBinding[];
  readonly secretStatus: readonly PluginSecretStatus[];
  readonly surfaces: readonly PluginSurfaceInfo[];
  readonly runtime: PluginRuntimeInfo | null;
  /** 当前配置值（不含 Secret 原文） */
  readonly configValues?: Readonly<Record<string, unknown>>;
}

// ── 来源管理（GET /api/plugin-sources）──────────────────────────
export type PluginSourceTrustLevel = "none" | "restricted" | "full-access";

export interface PluginSource {
  readonly id: string;
  readonly name: string;
  readonly sourceType: PluginSourceType;
  readonly ref: string;
  readonly trusted: boolean;
  readonly trustLevel: PluginSourceTrustLevel;
  readonly description?: string;
}

export interface PluginSourceSearchQuery {
  readonly query: string;
  readonly sourceId?: string;
  readonly sourceType?: PluginSourceType;
  readonly ref?: string;
}

export interface PluginSourceSearchResult {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly sourceRef: PluginSourceRef;
  readonly compatibility: CompatibilityReport;
}

// ── inspect / install（POST /api/plugins/inspect|install）───────
export interface PluginInspectInput {
  readonly sourceRef: PluginSourceRef;
}

export interface PluginInspectResult {
  readonly manifest: NormalizedPluginManifest;
  readonly compatibility: CompatibilityReport;
}

export interface PluginInstallPermission {
  readonly capability: PluginCapabilityKind;
  readonly decision: GrantDecision;
}

export interface PluginInstallInput {
  readonly sourceRef: PluginSourceRef;
  readonly permissions?: readonly PluginInstallPermission[];
}

export interface PluginInstallResult {
  readonly pluginId: string;
  readonly version: string;
  readonly status: PluginStatus;
}

// ── Agent 绑定（PUT/DELETE /api/agents/:agentId/plugins/:pluginId）
export interface AgentPluginBindingInput {
  /** 允许的 contribution id 列表；缺省/空 = 全部启用 */
  readonly contributions?: readonly string[];
  readonly enabled: boolean;
}

// ── 开发态（/api/plugins/dev/*，占位 + dev API client）──────────
export interface PluginDevInstallInput {
  readonly sourceDir: string;
  readonly fullAccess?: boolean;
  readonly sourceType?: PluginSourceType;
}

export interface PluginDevState {
  readonly pluginId: string;
  readonly devRunId: string;
  readonly status: PluginStatus;
  readonly sourceDir: string;
  readonly runtimeKind: PluginRuntimeKind;
  readonly healthy: boolean;
  readonly lastError: string | null;
  readonly scenarios: readonly string[];
  readonly surfaces: readonly string[];
}

export interface PluginDevInvokeToolInput {
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface PluginDevScenarioInput {
  readonly scenarioName: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly destructive?: boolean;
}

export interface PluginDevInvokeResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}
