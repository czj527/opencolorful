import type { NormalizedSkillManifest, SkillReadiness } from "../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Readiness 诊断（plans/phase-13.md §5.2 / §12.1）
//
// - 只诊断不授权：对照当前平台环境/插件清单（T7 再接入真实插件状态）；
// - requires 缺失 → blocked（skill_readiness_blocked）；
// - OS 不匹配 → incompatible（skill_os_incompatible，无法在本平台运行）；
// - 环境变量/工具/能力缺失 → degraded（可在会话内补齐或容忍降级）；
// - 无效 manifest → incompatible（skill_manifest_invalid）。
// ═══════════════════════════════════════════════════════════════

/** 当前平台/环境快照（Resolve 时注入；插件状态由 T7 接入真实值）。 */
export interface ReadinessEnvironment {
  /** 平台 OS（win32 / darwin / linux） */
  readonly os: NodeJS.Platform;
  /** PATH 可解析的二进制名 */
  readonly bins: readonly string[];
  /** 已存在的环境变量名 */
  readonly env: readonly string[];
  /** 已启用插件 id */
  readonly plugins: readonly string[];
  /** 可用工具 id */
  readonly tools: readonly string[];
  /** 可用能力 id */
  readonly capabilities: readonly string[];
  /** 当前可见/可用的 Skill id（recommends.skills 判定用） */
  readonly skills?: readonly string[];
}

export const SKILL_READINESS_REASONS = {
  os: "skill_os_incompatible",
  blocked: "skill_readiness_blocked",
  invalid: "skill_manifest_invalid",
} as const;

export interface ReadinessDiagnosis {
  readonly readiness: SkillReadiness;
  readonly blockedReason?: string;
  /** 导致 blocked/incompatible 的缺失项（fail-closed 时非空） */
  readonly missing: readonly string[];
  /** 导致 degraded 的降级项 */
  readonly degraded: readonly string[];
}

/**
 * 根据 manifest.requires / recommends 对照环境快照判定 readiness。
 * 只诊断不授权：这里不检查任何 Grant，仅对照平台环境与插件清单。
 */
export function diagnoseReadiness(manifest: NormalizedSkillManifest | null, environment: ReadinessEnvironment): ReadinessDiagnosis {
  if (manifest === null) {
    return {
      readiness: "incompatible",
      blockedReason: SKILL_READINESS_REASONS.invalid,
      missing: ["manifest"],
      degraded: [],
    };
  }
  const requires = manifest.opencolorful?.requires;
  const recommends = manifest.opencolorful?.recommends;
  const missing: string[] = [];
  const degraded: string[] = [];

  if (requires?.os !== undefined && requires.os.length > 0 && !requires.os.includes(environment.os as "win32" | "darwin" | "linux")) {
    return {
      readiness: "incompatible",
      blockedReason: SKILL_READINESS_REASONS.os,
      missing: [`os:${environment.os}`],
      degraded: [],
    };
  }
  for (const bin of requires?.bins ?? []) {
    if (!environment.bins.includes(bin)) {
      missing.push(`bin:${bin}`);
    }
  }
  for (const envName of requires?.env ?? []) {
    if (!environment.env.includes(envName)) {
      degraded.push(`env:${envName}`);
    }
  }
  for (const plugin of requires?.plugins ?? []) {
    if (!environment.plugins.includes(plugin)) {
      missing.push(`plugin:${plugin}`);
    }
  }
  for (const tool of requires?.tools ?? []) {
    if (!environment.tools.includes(tool)) {
      degraded.push(`tool:${tool}`);
    }
  }
  for (const capability of requires?.capabilities ?? []) {
    if (!environment.capabilities.includes(capability)) {
      degraded.push(`capability:${capability}`);
    }
  }
  for (const plugin of recommends?.plugins ?? []) {
    if (!environment.plugins.includes(plugin)) {
      degraded.push(`recommend-plugin:${plugin}`);
    }
  }
  const visibleSkills = new Set(environment.skills ?? []);
  for (const skill of recommends?.skills ?? []) {
    if (!visibleSkills.has(skill)) {
      degraded.push(`recommend-skill:${skill}`);
    }
  }

  if (missing.length > 0) {
    return { readiness: "blocked", blockedReason: SKILL_READINESS_REASONS.blocked, missing, degraded };
  }
  if (degraded.length > 0) {
    return { readiness: "degraded", missing: [], degraded };
  }
  return { readiness: "ready", missing: [], degraded: [] };
}

/** 是否允许进入可见集（readiness 门控：ready/degraded 可见，blocked/incompatible 门控）。 */
export function isReadinessPassing(readiness: SkillReadiness): boolean {
  return readiness === "ready" || readiness === "degraded";
}
