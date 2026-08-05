import type { NormalizedSkillManifest, SkillReadiness } from "../../../contracts/skill-protocol.js";
import {
  SKILL_READINESS_REASONS,
  diagnoseReadiness,
  type ReadinessDiagnosis,
  type ReadinessEnvironment,
} from "../readiness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T7 插件感知 Readiness（plans/phase-13.md §8.2 / §13.1）
//
// - T2 的 diagnoseReadiness 只对照环境清单（environment.plugins 静态数组）；
//   T7 接入真实插件状态：Agent 绑定（agent_plugin_bindings）+ 插件启用位；
// - requires.plugins 判定：
//     绑定存在且插件启用 → 满足；
//     未绑定 → degraded（可在会话内补齐绑定，或 Skill 本身不依赖绑定）；
//     已绑定但插件停用 → blocked（绑定存在却被平台停用，属于硬阻断）；
// - 来源级阻断（插件卸载/回滚后的 Catalog 条目）：readiness=blocked +
//   blockedReason 携带来源诊断（`skill_readiness_blocked:<reason>`）；
// - 只诊断不授权：本模块不读取/创建任何 Grant，不触碰 plugin_grants；
// - 本文件是 T7 新增模块，不改动 T2 的 diagnoseReadiness 语义。
// ═══════════════════════════════════════════════════════════════

/** Agent 插件绑定视图（binding 行 + 插件启用位；来源：PluginFacade.bindings）。 */
export interface PluginBindingStatus {
  readonly pluginId: string;
  readonly enabled: boolean;
}

export interface PluginAwareReadinessInput {
  readonly manifest: NormalizedSkillManifest | null;
  /** 基础平台环境快照（os/bins/env/tools/capabilities；plugins 维由本函数接管） */
  readonly environment: ReadinessEnvironment;
  /** Agent 绑定的插件（binding 存在且 enabled）；缺省视为无绑定 */
  readonly pluginBindings?: readonly PluginBindingStatus[];
  /** 来源级阻断（插件禁用/卸载/回滚）；非空 → 直接 blocked（fail-closed） */
  readonly sourceBlocked?: { readonly reason: string };
}

export interface PluginAwareReadinessResult extends ReadinessDiagnosis {
  readonly readiness: SkillReadiness;
  readonly blockedReason?: string;
  readonly missing: readonly string[];
  readonly degraded: readonly string[];
}

/** 来源阻断稳定 reasonCode 前缀（blockedReason 可含插件卸载等诊断详情）。 */
export const SKILL_SOURCE_BLOCKED_REASON_PREFIX = "skill_readiness_blocked";

/**
 * 插件感知 readiness 判定。规则：
 * - 来源级阻断（插件卸载/禁用/回滚）→ blocked，blockedReason 含来源诊断；
 * - manifest 无效 / OS 不匹配 → 沿用 T2（incompatible）；
 * - requires.plugins：绑定且启用 → 满足；未绑定 → degraded；绑定但停用 → blocked；
 * - requires 的 bins/env/tools/capabilities 与 recommends 沿用 T2 语义
 *   （environment 的 plugins 维先替换为"已绑定且启用"的真实集合）；
 * - 只诊断不授权：不创建任何 Grant。
 */
export function pluginAwareReadiness(input: PluginAwareReadinessInput): PluginAwareReadinessResult {
  const { manifest, environment } = input;

  // 来源级阻断：插件卸载/禁用/回滚后该来源全部条目 fail-closed blocked
  if (input.sourceBlocked !== undefined) {
    return {
      readiness: "blocked",
      blockedReason: `${SKILL_SOURCE_BLOCKED_REASON_PREFIX}:${input.sourceBlocked.reason.slice(0, 200)}`,
      missing: ["source:blocked"],
      degraded: [],
    };
  }

  const bindings = input.pluginBindings ?? [];
  const boundPlugins = new Map<string, boolean>();
  for (const binding of bindings) {
    boundPlugins.set(binding.pluginId, binding.enabled);
  }

  // environment 的 plugins 维替换为"Agent 已绑定且启用"的真实插件集合，
  // 使 T2 的 recommends.plugins 判定同样基于真实绑定状态
  const realEnvironment: ReadinessEnvironment = {
    ...environment,
    plugins: [...boundPlugins.entries()]
      .filter(([, enabled]) => enabled === true)
      .map(([pluginId]) => pluginId),
  };
  const base = diagnoseReadiness(manifest, realEnvironment);
  if (base.readiness === "incompatible") {
    return base;
  }

  const missing = [...base.missing];
  const degraded = [...base.degraded];
  const requires = manifest?.opencolorful?.requires;

  // 插件维度细化：未绑定 → degraded；绑定但停用 → blocked（保留在 missing）
  for (const pluginId of requires?.plugins ?? []) {
    const binding = boundPlugins.get(pluginId);
    const missingIndex = missing.indexOf(`plugin:${pluginId}`);
    if (binding === undefined) {
      // 未绑定：从 hard missing 降级为 degraded（可在会话内补齐绑定）
      if (missingIndex >= 0) {
        missing.splice(missingIndex, 1);
      }
      if (!degraded.includes(`plugin:${pluginId}`)) {
        degraded.push(`plugin:${pluginId}`);
      }
    } else if (!binding) {
      // 绑定存在但插件被平台停用：hard blocked（保留在 missing）
      if (missingIndex < 0) {
        missing.push(`plugin:${pluginId}`);
      }
      if (!degraded.includes(`plugin:${pluginId}-disabled`)) {
        degraded.push(`plugin:${pluginId}-disabled`);
      }
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
