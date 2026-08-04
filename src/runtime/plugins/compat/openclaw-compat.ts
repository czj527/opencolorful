import Value from "typebox/value";

import {
  CompatibilityReportSchema,
  COMPATIBILITY_LEVELS,
  NormalizedPluginManifestSchema,
  PLUGIN_ID_PATTERN,
  SEMVER_PATTERN,
  type CompatibilityItemStatus,
  type CompatibilityLevel,
  type Contributions,
  type PluginRuntimeKind,
  type PluginTrust,
  type ToolRiskLevel,
} from "../../../contracts/plugin-protocol.js";
import { satisfiesOpenColorfulRange } from "../installer/plugin-installer.js";
import {
  normalizeOpenClawAuthor,
  parseOpenClawManifest,
  type OpenClawCommand,
  type OpenClawManifest,
  type OpenClawSkill,
  type OpenClawTool,
} from "../sources/openclaw-source.js";
import type { ArtifactVerification, PluginSourceRef } from "../sources/source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// OpenClaw → OpenColorful 兼容转换（plans/phase-12.md §12.3）
//
// 输入：OpenClaw 原始包（openclaw.plugin.json + sourceRef + verification）；
// 输出：NormalizedPluginManifest + CompatibilityReport。
//
// 映射规则：
// - L1 名称/版本/作者/描述/来源/依赖（依赖进 provenance 与 metadata）；
// - L2 静态 Skills（只登记不激活）、commands、config；
// - L3 MCP 描述；
// - L4 工具 Schema 与调用适配（toToolContribution）；
// - OpenClaw 专属 Gateway / Channel / ACP / 专属 Hook / 内部 API
//   （@openclaw/* 依赖）→ blocked + 精确中文诊断；
// - OpenClaw 的 allow/deny 权限列表不被当作 OpenColorful 授权
//   （只作 degraded 提示，normalized.permissions 由本模块按映射能力推导）。
//
// 受支持的 Node 工具由兼容 worker（T9/T10 接线）执行，本模块只做映射与报告。
// ═══════════════════════════════════════════════════════════════

export class OpenClawCompatError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "OpenClawCompatError";
    this.reasonCode = reasonCode;
  }
}

// ── 规范化清单 / 兼容报告镜像类型（冻结 Schema 用于 Value.Check） ──

export interface PluginAuthorMirror {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

export interface NormalizedPluginManifestMirror {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: PluginAuthorMirror;
  readonly license?: string;
  readonly compatibility: { readonly opencolorful: string; readonly pluginApi: 1 };
  readonly trust: PluginTrust;
  readonly runtime: { readonly kind: PluginRuntimeKind; readonly entry?: string };
  readonly permissions: readonly { readonly capability: string; readonly reason?: string }[];
  readonly contributions: Contributions;
  readonly config?: unknown;
  readonly source: {
    readonly sourceRef: PluginSourceRef;
    readonly verification: ArtifactVerification;
    readonly provenance?: unknown;
  };
  readonly normalizedAt: string;
}

export interface CompatibilityReportMirror {
  readonly pluginId: string;
  readonly version: string;
  readonly level: CompatibilityLevel;
  readonly supported: boolean;
  readonly missingCapabilities: readonly string[];
  readonly contributions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly status: CompatibilityItemStatus;
    readonly reason?: string;
  }[];
  readonly blockedReasons: readonly string[];
  readonly requiresFullAccess: boolean;
  readonly requiresRuntime?: string;
}

// ── contribution 镜像类型 ─────────────────────────────────────────

export interface ToolContributionMirror {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly riskLevel?: ToolRiskLevel;
}

export interface CommandContributionMirror {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly argumentsSchema?: unknown;
}

export interface SkillBundleContributionMirror {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly skillsDir?: string;
}

export interface ConfigContributionMirror {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly schema?: unknown;
}

export interface MappedToolContribution {
  readonly contribution: ToolContributionMirror;
  readonly status: "supported" | "degraded";
  readonly reason?: string;
}

export interface OpenClawConversionInput {
  /** openclaw.plugin.json 原始对象 */
  readonly manifest: unknown;
  readonly sourceRef: PluginSourceRef;
  readonly verification: ArtifactVerification;
  readonly provenance?: unknown;
  /** 当前 OpenColorful 宿主版本（用于 engines.opencolorful 范围判定） */
  readonly hostVersion: string;
}

export interface OpenClawConversionResult {
  readonly normalized: NormalizedPluginManifestMirror;
  readonly compatibility: CompatibilityReportMirror;
  /** 附加诊断（如 id 归一化），不改变 normalized 结果 */
  readonly warnings: readonly string[];
}

const OPENCLAW_BLOCKED_PREFIX = "OpenClaw 专属能力，OpenColorful 不支持";

// ── 工具映射（L4） ───────────────────────────────────────────────

/** OpenClaw 工具 → OpenColorful ToolContribution（供 T9/T10 兼容 worker 接线）。 */
export function toToolContribution(tool: OpenClawTool): MappedToolContribution {
  const reasons: string[] = [];
  const riskLevel: ToolRiskLevel =
    tool.risk === "low" || tool.risk === "medium" || tool.risk === "high" ? tool.risk : "medium";
  const contribution: ToolContributionMirror = {
    id: tool.name,
    name: tool.name,
    riskLevel,
    ...(typeof tool.description === "string" && tool.description.length > 0 ? { description: tool.description } : {}),
    ...(isSchemaObject(tool.schema) ? { inputSchema: tool.schema } : {}),
    ...(isSchemaObject(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
  };
  if (tool.schema !== undefined && !isSchemaObject(tool.schema)) {
    reasons.push("工具输入 Schema 不是对象，已省略");
  }
  if (tool.outputSchema !== undefined && !isSchemaObject(tool.outputSchema)) {
    reasons.push("工具输出 Schema 不是对象，已省略");
  }
  return reasons.length > 0
    ? { contribution, status: "degraded", reason: reasons.join("；") }
    : { contribution, status: "supported" };
}

function toCommandContribution(command: OpenClawCommand): CommandContributionMirror {
  return {
    id: command.id,
    name: command.name,
    ...(typeof command.description === "string" && command.description.length > 0 ? { description: command.description } : {}),
    ...(isSchemaObject(command.argumentsSchema) ? { argumentsSchema: command.argumentsSchema } : {}),
  };
}

/** 静态 Skills 只登记为未激活资源（plans/phase-12.md §8.10）。 */
function toSkillBundleContribution(skill: OpenClawSkill): SkillBundleContributionMirror {
  return {
    id: skill.id,
    name: skill.name,
    ...(typeof skill.description === "string" && skill.description.length > 0 ? { description: skill.description } : {}),
    ...(skill.dir !== undefined ? { skillsDir: skill.dir } : { skillsDir: `./skills/${skill.id}` }),
  };
}

// ── 主转换入口 ────────────────────────────────────────────────────

export function convertOpenClawPlugin(input: OpenClawConversionInput): OpenClawConversionResult {
  const manifest = parseOpenClawManifest(input.manifest);
  const warnings: string[] = [];
  const { pluginId, changed } = normalizePluginId(manifest.id);
  if (changed) {
    warnings.push(`OpenClaw 插件 id「${manifest.id}」不满足插件 ID 规则，已归一化为「${pluginId}」`);
  }
  const version = manifest.version.trim();
  if (!new RegExp(SEMVER_PATTERN).test(version)) {
    throw new OpenClawCompatError("openclaw_version_invalid", `OpenClaw 插件版本不是合法 SemVer：${version}`);
  }

  const normalized = buildNormalizedPluginManifest(manifest, pluginId, version, input);
  if (!Value.Check(NormalizedPluginManifestSchema, normalized)) {
    throw new OpenClawCompatError("openclaw_normalized_invalid", "OpenClaw 插件转换后的规范化清单不符合 OpenColorful 契约");
  }
  const compatibility = buildOpenClawCompatibilityReport(manifest, pluginId, normalized, input.hostVersion);
  if (!Value.Check(CompatibilityReportSchema, compatibility)) {
    throw new OpenClawCompatError("openclaw_report_invalid", "OpenClaw 插件兼容性报告不符合契约");
  }
  return { normalized, compatibility, warnings };
}

// ── 规范化清单构建 ────────────────────────────────────────────────

function normalizePluginId(rawId: string): { readonly pluginId: string; readonly changed: boolean } {
  const trimmed = rawId.trim();
  const sanitized = trimmed.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  if (!new RegExp(PLUGIN_ID_PATTERN).test(sanitized)) {
    throw new OpenClawCompatError("openclaw_id_invalid", `OpenClaw 插件 id「${rawId}」无法转换为合法插件 ID`);
  }
  return { pluginId: sanitized, changed: sanitized !== trimmed };
}

function buildNormalizedPluginManifest(
  manifest: OpenClawManifest,
  pluginId: string,
  version: string,
  input: OpenClawConversionInput,
): NormalizedPluginManifestMirror {
  const { tools, commands, skills, config } = collectContributions(manifest);
  const runtime = chooseRuntime(manifest);
  const trust: PluginTrust = runtime.kind === "node-process" ? "full-access" : "restricted";
  const permissions = buildPermissionRequests(manifest);
  const author = normalizeOpenClawAuthor(manifest.author);

  const contributions: Contributions = {
    ...(tools.length > 0 ? { tool: tools } : {}),
    ...(commands.length > 0 ? { command: commands } : {}),
    ...(skills.length > 0 ? { "skill-bundle": skills } : {}),
    ...(config !== undefined ? { config: [config] } : {}),
  };

  const normalized: NormalizedPluginManifestMirror = {
    id: pluginId,
    name: manifest.name,
    version,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(manifest.license !== undefined ? { license: manifest.license } : {}),
    compatibility: {
      opencolorful: manifest.engines?.opencolorful ?? "*",
      pluginApi: 1,
    },
    trust,
    runtime,
    permissions,
    contributions,
    ...(config !== undefined ? { config: config.schema } : {}),
    source: {
      sourceRef: {
        sourceType: "openclaw",
        ref: input.sourceRef.ref,
        ...(input.sourceRef.version !== undefined ? { version: input.sourceRef.version } : {}),
      },
      verification: {
        sha256: input.verification.sha256,
        sizeBytes: input.verification.sizeBytes,
        ...(input.verification.provenance !== undefined ? { provenance: input.verification.provenance } : {}),
      },
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    },
    normalizedAt: new Date().toISOString(),
  };
  return normalized;
}

function collectContributions(manifest: OpenClawManifest): {
  readonly tools: ToolContributionMirror[];
  readonly commands: CommandContributionMirror[];
  readonly skills: SkillBundleContributionMirror[];
  readonly config: ConfigContributionMirror | undefined;
} {
  const tools: ToolContributionMirror[] = [];
  const seenToolIds = new Set<string>();
  for (const tool of manifest.tools ?? []) {
    const mapped = toToolContribution(tool);
    if (seenToolIds.has(mapped.contribution.id)) {
      throw new OpenClawCompatError("openclaw_duplicate_tool", `OpenClaw 插件存在重复工具名：${mapped.contribution.id}`);
    }
    seenToolIds.add(mapped.contribution.id);
    tools.push(mapped.contribution);
  }

  const commands: CommandContributionMirror[] = (manifest.commands ?? []).map(toCommandContribution);

  const skills: SkillBundleContributionMirror[] = (manifest.skills ?? []).map(toSkillBundleContribution);

  let config: ConfigContributionMirror | undefined;
  if (manifest.config?.schema !== undefined) {
    config = { id: "config", name: "配置", description: "OpenClaw 配置 Schema 映射", schema: manifest.config.schema };
  }
  return { tools, commands, skills, config };
}

/**
 * 运行时形态选择（plans/phase-12.md §9.1）：
 * - 声明工具 → node-process（OpenClaw 工具是 Node 代码，需 full-access）；
 * - 仅 MCP → mcp；
 * - 其余（静态资源）→ bundle。
 */
function chooseRuntime(manifest: OpenClawManifest): { readonly kind: PluginRuntimeKind; readonly entry?: string } {
  const entry = manifest.entry ?? manifest.package?.entry;
  const hasTools = (manifest.tools?.length ?? 0) > 0;
  const hasMcp = (manifest.mcp?.length ?? 0) > 0;
  if (hasTools) {
    return { kind: "node-process", ...(entry !== undefined ? { entry } : {}) };
  }
  if (hasMcp) {
    return { kind: "mcp" };
  }
  return { kind: "bundle" };
}

/**
 * 权限请求由映射后的能力推导（tool.register / network.connect / process.spawn）。
 * 不把 OpenClaw 的 allow/deny 列表直接当成 OpenColorful 授权。
 */
function buildPermissionRequests(
  manifest: OpenClawManifest,
): readonly { readonly capability: string; readonly reason?: string }[] {
  const requests: Array<{ capability: string; reason?: string }> = [];
  if ((manifest.tools?.length ?? 0) > 0) {
    requests.push({ capability: "tool.register", reason: "OpenClaw 工具映射到 OpenColorful 工具" });
  }
  for (const server of manifest.mcp ?? []) {
    if (server.url !== undefined) {
      requests.push({ capability: "network.connect", reason: "远程 MCP Server 连接" });
    }
    if (server.command !== undefined) {
      requests.push({ capability: "process.spawn", reason: "stdio MCP Server 进程启动" });
    }
  }
  return requests;
}

// ── 兼容性报告构建 ────────────────────────────────────────────────

function buildOpenClawCompatibilityReport(
  manifest: OpenClawManifest,
  pluginId: string,
  normalized: NormalizedPluginManifestMirror,
  hostVersion: string,
): CompatibilityReportMirror {
  const contributions: Array<{ id: string; kind: string; status: CompatibilityItemStatus; reason?: string }> = [];
  const missingCapabilities: string[] = [];
  const blockedReasons: string[] = [];
  let level: CompatibilityLevel = "L1";

  const considerLevel = (candidate: CompatibilityLevel): void => {
    if (COMPATIBILITY_LEVELS.indexOf(candidate) > COMPATIBILITY_LEVELS.indexOf(level)) {
      level = candidate;
    }
  };

  const pushSupported = (id: string, kind: string, reason?: string): void => {
    contributions.push(reason !== undefined ? { id, kind, status: "supported", reason } : { id, kind, status: "supported" });
  };

  const pushBlocked = (id: string, kind: string, reason: string): void => {
    contributions.push({ id, kind, status: "blocked", reason });
    blockedReasons.push(reason);
  };

  // L4 工具
  for (const tool of manifest.tools ?? []) {
    const mapped = toToolContribution(tool);
    considerLevel("L4");
    const base: { id: string; kind: string; status: CompatibilityItemStatus } = {
      id: mapped.contribution.id,
      kind: "tool",
      status: mapped.status,
    };
    contributions.push(mapped.reason !== undefined ? { ...base, reason: mapped.reason } : base);
  }

  // L3 MCP
  for (const server of manifest.mcp ?? []) {
    pushSupported(server.id, "mcp");
    considerLevel("L3");
  }

  // L2 命令
  for (const command of manifest.commands ?? []) {
    pushSupported(command.id, "command");
    considerLevel("L2");
  }

  // L2 静态 Skills（只登记不激活）
  for (const skill of manifest.skills ?? []) {
    pushSupported(skill.id, "skill-bundle", "仅登记为未激活资源，技能系统未启用");
    considerLevel("L2");
  }

  // config
  if (manifest.config?.schema !== undefined) {
    pushSupported("config", "config");
  }

  // ── OpenClaw 专属能力 → blocked/degraded + 精确诊断 ────────────
  const capabilities = manifest.capabilities;
  if (capabilities?.gateway !== undefined) {
    pushBlocked("openclaw.gateway", "gateway", `${OPENCLAW_BLOCKED_PREFIX}（Gateway 网关服务）`);
  }
  for (const channel of capabilities?.channels ?? []) {
    pushBlocked(`openclaw.channel.${channel}`, "channel", `${OPENCLAW_BLOCKED_PREFIX}（Channel：${channel}）`);
  }
  if (capabilities?.acp !== undefined) {
    pushBlocked("openclaw.acp", "acp", `${OPENCLAW_BLOCKED_PREFIX}（ACP）`);
  }
  if (capabilities?.hooks !== undefined) {
    pushBlocked(
      "openclaw.hooks",
      "hook",
      `${OPENCLAW_BLOCKED_PREFIX}（专属 Hook 会 monkey-patch Agent Loop，无法映射到 OpenColorful 冻结时点）`,
    );
  }
  if (capabilities?.schedules !== undefined) {
    contributions.push({
      id: "openclaw.schedules",
      kind: "schedule",
      status: "degraded",
      reason: "OpenClaw 调度能力未映射到 OpenColorful 后台任务，仅记录不执行",
    });
  }
  if (capabilities?.events !== undefined) {
    contributions.push({
      id: "openclaw.events",
      kind: "event",
      status: "degraded",
      reason: "OpenClaw 事件订阅未映射到 OpenColorful 自定义事件，仅记录不执行",
    });
  }

  // 内部 API 依赖（@openclaw/* 或 openclaw 包）
  for (const dep of detectOpenClawInternalDependencies(manifest.dependencies)) {
    pushBlocked(`openclaw.internal.${dep}`, "internal-api", `${OPENCLAW_BLOCKED_PREFIX}（依赖 OpenClaw 内部 API：${dep}）`);
  }

  // OpenClaw allow/deny 不被当作 OpenColorful 授权
  const permissions = manifest.permissions;
  if (
    permissions !== undefined &&
    ((permissions.allow?.length ?? 0) > 0 || (permissions.deny?.length ?? 0) > 0)
  ) {
    contributions.push({
      id: "openclaw.permissions",
      kind: "permission",
      status: "degraded",
      reason: "OpenClaw 的 allow/deny 权限列表不会被直接当作 OpenColorful 授权，请由用户在权限审查中重新确认",
    });
  }

  // engines.opencolorful 范围（可选字段；OpenClaw 自身版本要求只作 provenance 记录）
  const requiredRange = manifest.engines?.opencolorful;
  if (requiredRange !== undefined && !satisfiesOpenColorfulRange(hostVersion, requiredRange)) {
    blockedReasons.push(`engines.opencolorful 范围不满足（要求 ${requiredRange}，当前 ${hostVersion}）`);
  }

  const requiresFullAccess = normalized.trust === "full-access";
  const requiresRuntime = normalized.runtime.kind === "bundle" ? undefined : normalized.runtime.kind;

  return {
    pluginId,
    version: normalized.version,
    level,
    supported: blockedReasons.length === 0,
    missingCapabilities: Array.from(new Set(missingCapabilities)),
    contributions,
    blockedReasons,
    requiresFullAccess,
    ...(requiresRuntime !== undefined ? { requiresRuntime } : {}),
  };
}

function detectOpenClawInternalDependencies(
  dependencies: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (dependencies === undefined) {
    return [];
  }
  return Object.keys(dependencies).filter((name) => name === "openclaw" || name.startsWith("@openclaw/"));
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
