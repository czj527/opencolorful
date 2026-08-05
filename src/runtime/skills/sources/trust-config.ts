import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceKind } from "../../../contracts/skill-protocol.js";
import { isPathWithinRoot } from "../path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 来源与信任配置（plans/phase-13.md §8.1 / §9.2）
//
// - 配置文件：${OPENCOLORFUL_HOME}/config/skill-sources.json（路径由 paths.ts 生成）；
// - workspace 与兼容目录默认关闭：只有用户显式信任根目录后才扫描；
// - 实际信任决策 UI/CLI 在 T6/T8；本模块只提供读写 + 信任策略接口；
// - 失败路径 fail-closed：配置损坏/缺失 → 默认配置（全部关闭）。
// ═══════════════════════════════════════════════════════════════

export interface SkillSourcesConfig {
  readonly version: 1;
  /** 用户显式信任的根目录（绝对路径；可包含 cwd / 兼容目录根） */
  readonly trustedRoots: readonly string[];
  /** 显式关闭的来源 kind（workspace 默认关闭） */
  readonly disabledKinds: readonly SkillSourceKind[];
  /** 精确来源信任（sourceId → true；external 等需要审查的来源用） */
  readonly trustedSourceIds: Readonly<Record<string, boolean>>;
}

export function defaultSkillSourcesConfig(): SkillSourcesConfig {
  return { version: 1, trustedRoots: [], disabledKinds: ["workspace"], trustedSourceIds: {} };
}

export class SkillSourceTrustStore {
  constructor(private readonly paths: RuntimePaths) {}

  /** 读取配置；文件缺失/损坏 → 默认配置（fail-closed，不静默信任任何来源）。 */
  load(): SkillSourcesConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.paths.skillSources, "utf8")) as unknown;
      return parseConfig(raw);
    } catch {
      return defaultSkillSourcesConfig();
    }
  }

  save(config: SkillSourcesConfig): void {
    fs.mkdirSync(path.dirname(this.paths.skillSources), { recursive: true });
    fs.writeFileSync(this.paths.skillSources, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
}

export interface SourceTrustDecision {
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly reason?: string;
}

export interface SkillTrustPolicy {
  /** 某根目录是否被用户显式信任（workspace/兼容目录扫描前置条件） */
  isRootTrusted(root: string): boolean;
  /** 来源级信任决策（Catalog 登记时写入 status.trust） */
  evaluate(input: { readonly sourceKind: SkillSourceKind; readonly sourceId: string; readonly rootPath?: string }): SourceTrustDecision;
}

/**
 * 默认信任策略：
 * - builtin/managed/plugin → 启用且可信（plugin 的实际启用状态由 T7 接线）；
 * - workspace → 默认关闭，仅当根目录被显式信任时启用；
 * - external → 默认启用扫描但不可信，需审查或显式 trustedSourceIds。
 */
export class DefaultSkillTrustPolicy implements SkillTrustPolicy {
  constructor(private readonly config: SkillSourcesConfig) {}

  isRootTrusted(root: string): boolean {
    const canonical = path.resolve(root);
    return this.config.trustedRoots.some((trusted) => isPathWithinRoot(canonical, trusted));
  }

  evaluate(input: { readonly sourceKind: SkillSourceKind; readonly sourceId: string; readonly rootPath?: string }): SourceTrustDecision {
    switch (input.sourceKind) {
      case "builtin":
        return { enabled: true, trusted: true };
      case "managed":
        return { enabled: true, trusted: true };
      case "plugin":
        return { enabled: true, trusted: true };
      case "workspace": {
        if (this.config.disabledKinds.includes("workspace")) {
          return { enabled: false, trusted: false, reason: "workspace 来源默认关闭" };
        }
        if (input.rootPath !== undefined && this.isRootTrusted(input.rootPath)) {
          return { enabled: true, trusted: true };
        }
        return { enabled: false, trusted: false, reason: "工作区根目录未显式信任" };
      }
      case "external": {
        if (this.config.disabledKinds.includes("external")) {
          return { enabled: false, trusted: false, reason: "external 来源已显式关闭" };
        }
        if (this.config.trustedSourceIds[input.sourceId] === true) {
          return { enabled: true, trusted: true };
        }
        return { enabled: true, trusted: false, reason: "外部来源未信任，需要安装审查" };
      }
      default:
        return { enabled: false, trusted: false, reason: `未知来源 kind：${input.sourceKind}` };
    }
  }
}

// ── 配置解析（跨函数边界输入显式解析，fail-closed） ─────────────

const KNOWN_KINDS = new Set<SkillSourceKind>(["builtin", "managed", "plugin", "workspace", "external"]);

function parseConfig(input: unknown): SkillSourcesConfig {
  if (typeof input !== "object" || input === null) {
    return defaultSkillSourcesConfig();
  }
  const raw = input as Record<string, unknown>;
  if (raw["version"] !== 1) {
    return defaultSkillSourcesConfig();
  }
  const trustedRoots = toArray(raw["trustedRoots"])
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => path.resolve(item));
  const disabledKinds = toArray(raw["disabledKinds"]).filter((item): item is SkillSourceKind => typeof item === "string" && KNOWN_KINDS.has(item as SkillSourceKind));
  const trustedSourceIds: Record<string, boolean> = {};
  const ids = raw["trustedSourceIds"];
  if (typeof ids === "object" && ids !== null && !Array.isArray(ids)) {
    for (const [key, value] of Object.entries(ids as Record<string, unknown>)) {
      if (value === true) {
        trustedSourceIds[key] = true;
      }
    }
  }
  return { version: 1, trustedRoots, disabledKinds, trustedSourceIds };
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
