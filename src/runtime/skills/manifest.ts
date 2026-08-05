import Value from "typebox/value";

import {
  NormalizedSkillManifestSchema,
  type NormalizedSkillManifest,
  type OpenColorfulSkillMetadata,
  type SkillCompatibilityLevel,
  type SkillCompatibilityReport,
  type SkillErrorCode,
  type SkillRecommends,
  type SkillRequires,
} from "../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Manifest 标准化与兼容等级（plans/phase-13.md §7 / §8.4）
//
// - 把 frontmatter 标准化为 NormalizedSkillManifest；
// - 兼容字段 + metadata.opencolorful 扩展 + 未知字段保留 rawFrontmatter；
// - 兼容等级判定：native / pi-compatible / openclaw / hermes /
//   metadata-only / unsupported（§8.4），转换后给出 SkillCompatibilityReport；
// - 只诊断不授权：allowed-tools / requires 只进入 manifest，绝不产生 Grant；
// - 跨函数边界数据过 TypeBox 校验（fail-closed）。
// ═══════════════════════════════════════════════════════════════

export type NormalizedManifestResult =
  | { readonly ok: true; readonly manifest: NormalizedSkillManifest; readonly issues: readonly string[] }
  | { readonly ok: false; readonly reasonCode: SkillErrorCode; readonly reason: string; readonly issues: readonly string[] };

/** 规范化技能名 → skillId（名称只用于展示与搜索，skillId 用于稳定引用）。 */
export function slugifySkillId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 0) {
    return slug.slice(0, 128);
  }
  const fallback = name.toLowerCase().trim().replace(/\s+/g, "-");
  return fallback.length > 0 ? fallback.slice(0, 128) : "skill";
}

const CONSUMED_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "allowed_tools",
  "disable-model-invocation",
  "disable_model_invocation",
  "metadata",
]);

/** 未知高风险字段：保留但绝不授权，并给出降级诊断（要求人工迁移确认）。 */
const HIGH_RISK_UNKNOWN_KEYS = [
  "permissions",
  "grants",
  "tool-grants",
  "tool_grants",
  "allow-commands",
  "allow_commands",
  "authorization",
  "secrets",
  "filesystem",
  "network-access",
  "network_access",
  "exec",
  "commands",
] as const;

const OS_NAME_MAP: Record<string, "win32" | "darwin" | "linux"> = {
  win32: "win32",
  windows: "win32",
  win: "win32",
  darwin: "darwin",
  macos: "darwin",
  mac: "darwin",
  osx: "darwin",
  linux: "linux",
  unix: "linux",
};

export interface NormalizeSkillManifestOptions {
  /** SKILL.md 正文（用于 metadata-only 判定：正文为空则仅元数据可用） */
  readonly body?: string;
}

/**
 * 标准化 frontmatter → NormalizedSkillManifest + 兼容报告。
 * 失败路径 fail-closed：必填字段缺失 / 平台扩展非法 / TypeBox 校验失败一律拒绝。
 */
export function normalizeSkillManifest(
  frontmatter: Record<string, unknown>,
  options: NormalizeSkillManifestOptions = {},
): NormalizedManifestResult {
  const issues: string[] = [];

  const name = asString(frontmatter["name"]);
  const description = asString(frontmatter["description"]);
  if (name === null) {
    issues.push("缺少必填字段 name（必须是非空字符串）");
  }
  if (description === null) {
    issues.push("缺少必填字段 description（必须是非空字符串）");
  }
  if (name === null || description === null) {
    return { ok: false, reasonCode: "skill_manifest_invalid", reason: "SKILL.md frontmatter 缺少必填字段（name/description）", issues };
  }

  const license = asString(frontmatter["license"]);
  const compatibility = asString(frontmatter["compatibility"]);
  const allowedTools = parseAllowedTools(frontmatter, issues);
  const disableModelInvocation = parseDisableModelInvocation(frontmatter, issues);

  // ── 平台扩展（metadata.opencolorful）与生态来源转换 ────────────
  const metadata = isPlainObject(frontmatter["metadata"]) ? (frontmatter["metadata"] as Record<string, unknown>) : undefined;
  const analysis = analyzeCompatibility({ metadata, frontmatter, issues });
  const { opencolorful, level, missing, degradation, requiresManualMigration, consumedMetaKeys } = analysis;

  // 未知高风险字段：所有等级统一给出降级诊断（保留 rawFrontmatter，绝不授权）
  const highRisk = HIGH_RISK_UNKNOWN_KEYS.filter((key) => frontmatter[key] !== undefined);
  const highRiskMissing = highRisk.map((key) => `unknown-high-risk:${key}`);
  const highRiskDegradation =
    highRisk.length > 0 ? `未知高风险字段（${highRisk.join("、")}）已保留但未授予任何权限，需人工确认` : undefined;

  // 正文为空 → 仅元数据可用（metadata-only）
  const body = options.body;
  const effectiveLevel: SkillCompatibilityLevel =
    level === "unsupported"
      ? level
      : body !== undefined && body.trim() === ""
        ? "metadata-only"
        : level;

  const compatReport: SkillCompatibilityReport = {
    level: effectiveLevel,
    missing: dedupe([...missing, ...highRiskMissing]).slice(0, 64),
    ...(effectiveLevel === "metadata-only"
      ? { degradation: "正文为空，仅元数据可用，需要补充 SKILL.md 正文" }
      : highRiskDegradation !== undefined
        ? { degradation: highRiskDegradation }
        : degradation !== undefined
          ? { degradation }
          : {}),
    requiresManualMigration:
      requiresManualMigration || highRisk.length > 0 || effectiveLevel === "metadata-only" || effectiveLevel === "unsupported",
  };

  // ── rawFrontmatter：保留未知字段（不做授权） ────────────────────
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!CONSUMED_TOP_LEVEL_KEYS.has(key)) {
      raw[key] = value;
    }
  }
  if (metadata !== undefined && Object.keys(metadata).length > 0) {
    const remainingMeta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!consumedMetaKeys.has(key)) {
        remainingMeta[key] = value;
      }
    }
    if (Object.keys(remainingMeta).length > 0) {
      raw["metadata"] = remainingMeta;
    }
  }

  const manifest: NormalizedSkillManifest = {
    name,
    description,
    ...(license !== null ? { license } : {}),
    ...(compatibility !== null ? { compatibility } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(opencolorful !== undefined ? { opencolorful } : {}),
    rawFrontmatter: raw,
    compatibilityLevel: effectiveLevel,
    compatibilityReport: compatReport,
  };

  if (!Value.Check(NormalizedSkillManifestSchema, manifest)) {
    const errors = [...Value.Errors(NormalizedSkillManifestSchema, manifest)]
      .map((error) => `${"path" in error && typeof error.path === "string" ? error.path : "$root"}: ${error.message}`)
      .slice(0, 16);
    issues.push(...errors);
    return {
      ok: false,
      reasonCode: "skill_manifest_invalid",
      reason: `frontmatter 标准化失败（TypeBox 拒绝 ${errors.length} 项）`,
      issues,
    };
  }
  return { ok: true, manifest, issues };
}

// ── 兼容等级分析 ───────────────────────────────────────────────

interface CompatibilityAnalysis {
  readonly opencolorful: OpenColorfulSkillMetadata | undefined;
  readonly level: SkillCompatibilityLevel;
  readonly missing: string[];
  readonly degradation: string | undefined;
  readonly requiresManualMigration: boolean;
  /** 已消费的 metadata 子键（不再进入 rawFrontmatter） */
  readonly consumedMetaKeys: ReadonlySet<string>;
}

interface AnalysisContext {
  readonly metadata: Record<string, unknown> | undefined;
  readonly frontmatter: Record<string, unknown>;
  readonly issues: string[];
}

/**
 * 兼容等级判定（plans/phase-13.md §8.4）：
 * - native：带 metadata.opencolorful（version=1）的原生技能；
 * - openclaw：metadata.openclaw 已转换到 opencolorful.requires；
 * - hermes：platform/prerequisites 已转换；
 * - pi-compatible：标准 Agent Skills / PI 字段；
 * - metadata-only：正文为空，仅元数据可用；
 * - unsupported：opencolorful 版本不支持 / 不可转换。
 */
function analyzeCompatibility(context: AnalysisContext): CompatibilityAnalysis {
  const { metadata, frontmatter, issues } = context;
  const dropped: string[] = [];

  if (metadata !== undefined && metadata["opencolorful"] !== undefined) {
    const raw = metadata["opencolorful"];
    if (!isPlainObject(raw) || (raw as Record<string, unknown>)["version"] !== 1) {
      issues.push("metadata.opencolorful.version 必须是 1");
      return {
        opencolorful: undefined,
        level: "unsupported",
        missing: ["metadata.opencolorful.version=1"],
        degradation: "OpenColorful 扩展版本不支持，无法安装",
        requiresManualMigration: true,
        consumedMetaKeys: new Set(["opencolorful"]),
      };
    }
    const opencolorful = raw as Record<string, unknown>;
    return {
      opencolorful: {
        version: 1,
        ...(isPlainObject(opencolorful["requires"]) ? { requires: opencolorful["requires"] as SkillRequires } : {}),
        ...(isPlainObject(opencolorful["recommends"]) ? { recommends: opencolorful["recommends"] as SkillRecommends } : {}),
        ...(typeof opencolorful["risk"] === "string" ? { risk: opencolorful["risk"] as OpenColorfulRisk } : {}),
      },
      level: "native",
      missing: [],
      degradation: undefined,
      requiresManualMigration: false,
      consumedMetaKeys: new Set(["opencolorful"]),
    };
  }

  if (metadata !== undefined && metadata["openclaw"] !== undefined) {
    const requires = convertOpenClawRequires(metadata["openclaw"], dropped);
    const degradation =
      (metadata["openclaw"] as Record<string, unknown>)["requires"] !== undefined &&
      isPlainObject((metadata["openclaw"] as Record<string, unknown>)["requires"]) &&
      ((metadata["openclaw"] as Record<string, unknown>)["requires"] as Record<string, unknown>)["network"] === true
        ? "OpenClaw 声明需要网络访问；仅作风险展示，不授予网络权限"
        : undefined;
    return {
      opencolorful: requires,
      level: "openclaw",
      missing: dropped,
      degradation,
      requiresManualMigration: dropped.length > 0,
      consumedMetaKeys: new Set(["openclaw"]),
    };
  }

  const hermesHint =
    metadata !== undefined && metadata["hermes"] !== undefined
      ? true
      : frontmatter["platform"] !== undefined || frontmatter["prerequisites"] !== undefined;
  if (hermesHint) {
    const requires = convertHermesRequires(context, dropped);
    return {
      opencolorful: requires,
      level: "hermes",
      missing: dropped,
      degradation: "Hermes platform/prerequisites 已转换到 opencolorful.requires",
      requiresManualMigration: dropped.length > 0,
      consumedMetaKeys: new Set(["hermes"]),
    };
  }

  // 标准 Agent Skills / PI：无生态标记
  return {
    opencolorful: undefined,
    level: "pi-compatible",
    missing: [],
    degradation: undefined,
    requiresManualMigration: false,
    consumedMetaKeys: new Set(),
  };
}

type OpenColorfulRisk = "low" | "medium" | "high";

/** 转换 OpenClaw metadata.openclaw.requires → opencolorful.requires（只诊断不授权）。 */
function convertOpenClawRequires(openclaw: unknown, dropped: string[]): OpenColorfulSkillMetadata | undefined {
  if (!isPlainObject(openclaw)) {
    dropped.push("metadata.openclaw 不是映射");
    return undefined;
  }
  const oc = openclaw as Record<string, unknown>;
  const rawRequires = oc["requires"];
  const requires: SkillRequires = {};
  if (isPlainObject(rawRequires)) {
    const req = rawRequires as Record<string, unknown>;
    const bins = asStringArray(req["bins"]);
    if (bins !== null && bins.length > 0) {
      requires.bins = bins;
    }
    const env = envNames(req["env"]);
    if (env.length > 0) {
      requires.env = env;
    }
    const os = normalizeOsList(asStringArray(req["os"]), dropped);
    if (os.length > 0) {
      requires.os = os;
    }
    const tools = asStringArray(req["tools"]);
    if (tools !== null && tools.length > 0) {
      requires.tools = tools;
    }
    const capabilities = asStringArray(req["capabilities"]);
    if (capabilities !== null && capabilities.length > 0) {
      requires.capabilities = capabilities;
    }
    const plugins = asStringArray(req["plugins"]);
    if (plugins !== null && plugins.length > 0) {
      requires.plugins = plugins;
    }
  }
  for (const key of Object.keys(oc)) {
    if (!["requires", "icon", "tips", "description"].includes(key)) {
      dropped.push(`metadata.openclaw.${key}`);
    }
  }
  return Object.keys(requires).length > 0 ? { version: 1, requires } : { version: 1 };
}

/** 转换 Hermes platform/prerequisites → opencolorful.requires。 */
function convertHermesRequires(context: AnalysisContext, dropped: string[]): OpenColorfulSkillMetadata | undefined {
  const { metadata, frontmatter } = context;
  const requires: SkillRequires = {};

  const platform = frontmatter["platform"];
  const os = normalizeOsList(asStringArray(platform), dropped);
  if (os.length > 0) {
    requires.os = os;
  }

  const prerequisites = frontmatter["prerequisites"];
  if (isPlainObject(prerequisites)) {
    const prereq = prerequisites as Record<string, unknown>;
    const bins = asStringArray(prereq["bins"]);
    if (bins !== null && bins.length > 0) {
      requires.bins = bins;
    }
    const env = envNames(prereq["env"]);
    if (env.length > 0) {
      requires.env = env;
    }
    const prereqOs = normalizeOsList(asStringArray(prereq["os"]), dropped);
    if (prereqOs.length > 0) {
      requires.os = [...(requires.os ?? []), ...prereqOs];
    }
  } else if (Array.isArray(prerequisites)) {
    const bins = asStringArray(prerequisites);
    if (bins !== null && bins.length > 0) {
      requires.bins = bins;
    }
  } else if (typeof prerequisites === "string" && prerequisites.trim() !== "") {
    requires.bins = [prerequisites.trim()];
  }

  const topRequires = asStringArray(frontmatter["requires"]);
  if (topRequires !== null && topRequires.length > 0) {
    requires.tools = topRequires;
  }

  const hermes = metadata !== undefined && metadata["hermes"] !== undefined ? (metadata["hermes"] as Record<string, unknown>) : undefined;
  if (hermes !== undefined) {
    for (const key of Object.keys(hermes)) {
      if (!["requires", "title", "description", "platform"].includes(key)) {
        dropped.push(`metadata.hermes.${key}`);
      }
    }
  }
  return Object.keys(requires).length > 0 ? { version: 1, requires } : { version: 1 };
}

// ── 字段解析辅助 ───────────────────────────────────────────────

function parseAllowedTools(frontmatter: Record<string, unknown>, issues: string[]): string[] | undefined {
  const raw = frontmatter["allowed-tools"] ?? frontmatter["allowed_tools"];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    const tools: string[] = [];
    for (const item of raw) {
      if (typeof item === "string" && item.length > 0) {
        tools.push(item);
      } else {
        issues.push(`allowed-tools 包含非字符串项，已忽略`);
      }
    }
    return tools;
  }
  issues.push("allowed-tools 必须是字符串列表（仅解析为依赖提示，不产生授权）");
  return undefined;
}

function parseDisableModelInvocation(frontmatter: Record<string, unknown>, issues: string[]): boolean | undefined {
  const raw = frontmatter["disable-model-invocation"] ?? frontmatter["disable_model_invocation"];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  issues.push("disable-model-invocation 必须是布尔值");
  return undefined;
}

function normalizeOsList(values: readonly string[] | null, dropped: string[]): ("win32" | "darwin" | "linux")[] {
  if (values === null) {
    return [];
  }
  const result: ("win32" | "darwin" | "linux")[] = [];
  for (const value of values) {
    const mapped = OS_NAME_MAP[value.toLowerCase()];
    if (mapped !== undefined) {
      result.push(mapped);
    } else {
      dropped.push(`os:${value}`);
    }
  }
  return dedupe(result);
}

function envNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (isPlainObject(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : null;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return (value as string[]).filter((item) => item.trim().length > 0);
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
