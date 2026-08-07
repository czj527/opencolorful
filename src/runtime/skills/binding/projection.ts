import { skillRefKey, type SkillRef, type SkillSelectionMode } from "../../../contracts/skill-protocol.js";
import type { AgentSkillBindingWriteInput } from "../../../storage/agent-skill-binding-store.js";
import type { SkillBundleStore } from "../../../storage/skill-bundle-store.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import type { AgentSkillConfig } from "../agent/agent-skill-config.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 绑定投影构建（plans/phase-13.md §9.1）
//
// skills.json（唯一事实来源）→ agent_skill_binding_index（查询投影）的
// 双向一致性：
// - resolveBundleItems：Bundle 版本的 skillRefKey → 精确 SkillRef（contentHash
//   只能来自 Catalog；解析失败 → missing，fail-closed 不伪造哈希）；
// - buildBindingRows：config + 已解析 Bundle 项 → 投影行（direct 与 bundle
//   引用均 pinned=true；overrides 优先于 Bundle 项自身 selection）。
// ═══════════════════════════════════════════════════════════════

export interface ResolvedBundleItem {
  readonly skillRef: SkillRef;
  readonly skillRefKey: string;
  readonly selection: SkillSelectionMode;
  readonly ordinal: number;
  readonly bundleId: string;
  readonly bundleVersion: string;
}

/** 解析 Agent 配置中全部 Bundle 绑定的精确 SkillRef；缺失项进入 missing。 */
export function resolveAllBundleItems(input: {
  readonly bundles: SkillBundleStore;
  readonly catalog: SkillCatalog;
  readonly config: AgentSkillConfig;
}): { readonly resolved: readonly ResolvedBundleItem[]; readonly missing: readonly string[] } {
  const resolved: ResolvedBundleItem[] = [];
  const missing: string[] = [];
  const candidates = input.catalog.list({});
  const byRefKey = new Map<string, SkillRef>();
  for (const candidate of candidates) {
    byRefKey.set(skillRefKey(candidate.skillRef), candidate.skillRef);
  }
  for (const binding of input.config.bundleBindings) {
    const version = input.bundles.getBundle(binding.bundleId, binding.version);
    if (version === null) {
      missing.push(`bundle:${binding.bundleId}@${binding.version}`);
      continue;
    }
    for (const item of version.items) {
      const skillRef = byRefKey.get(item.skillRefKey);
      if (skillRef === undefined) {
        missing.push(item.skillRefKey);
        continue;
      }
      resolved.push({
        skillRef,
        skillRefKey: item.skillRefKey,
        selection: item.selection,
        ordinal: item.ordinal,
        bundleId: binding.bundleId,
        bundleVersion: binding.version,
      });
    }
  }
  return { resolved, missing };
}

/**
 * config + 已解析 Bundle 项 → 投影行。
 * - directSkillRefs：pinned=true，selection 取 overrides[key] ?? "implicit"；
 * - bundle 项：pinned=true，selection 取 overrides[key] ?? item.selection；
 * - overrides 中未被任何引用消费的键不产生行（仅作解析期覆盖）。
 */
export function buildBindingRows(input: {
  readonly agentId: string;
  readonly config: AgentSkillConfig;
  readonly bundleItems: readonly ResolvedBundleItem[];
  readonly configRevision: number;
  readonly updatedAt: string;
}): AgentSkillBindingWriteInput[] {
  const rows: AgentSkillBindingWriteInput[] = [];
  const seen = new Set<string>();
  for (const ref of input.config.directSkillRefs) {
    const key = skillRefKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      agentId: input.agentId,
      skillRefKey: key,
      selection: input.config.overrides[key] ?? "implicit",
      pinned: true,
      configRevision: input.configRevision,
      updatedAt: input.updatedAt,
    });
  }
  for (const item of input.bundleItems) {
    if (seen.has(item.skillRefKey)) {
      continue;
    }
    seen.add(item.skillRefKey);
    rows.push({
      agentId: input.agentId,
      skillRefKey: item.skillRefKey,
      selection: input.config.overrides[item.skillRefKey] ?? item.selection,
      bundleId: item.bundleId,
      bundleVersion: item.bundleVersion,
      pinned: true,
      configRevision: input.configRevision,
      updatedAt: input.updatedAt,
    });
  }
  rows.sort((a, b) => (a.skillRefKey < b.skillRefKey ? -1 : a.skillRefKey > b.skillRefKey ? 1 : 0));
  return rows;
}
