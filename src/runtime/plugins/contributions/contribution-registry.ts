import type {
  ContributionKind,
  Contributions,
  PluginTrust,
} from "../../../contracts/plugin-protocol.js";
import { CONTRIBUTION_KINDS, PLUGIN_ID_PATTERN } from "../../../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Contribution Registry（plans/phase-12.md §八 / §21.3）
//
// - 插件 contribution 登记/解析/查询：把 Manifest.contributions 展开为
//   扁平 RegisteredContribution（含 kind/id/name/requiredCapabilities/spec）；
// - 唯一性：同一 pluginId 内 contribution id 全局唯一（跨 kind 也唯一），
//   重复 id 在登记时抛 PluginContributionError（fail-closed）；
// - 版本门控：每个 pluginId 只持有"当前 active 版本的 contribution 集合"。
//   插件禁用/更新/卸载时由 host-api 调用 unregister，旧 contribution
//   立即从登记表消失，后续 get/list/isRegistered 均不可再命中——保证
//   "禁用/更新后旧 contribution 不可调用"；
// - 本 Registry 只做登记/查询，不直接调用 RuntimeHost；工具/路由等调用
//   语义由各 contribution service 承担（统一经 RuntimeHost.invoke 产生
//   plugin.execution.* 生命周期）。
// ═══════════════════════════════════════════════════════════════

export class PluginContributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginContributionError";
  }
}

/** 插件 Manifest.permissions 中的权限请求（扁平化安全摘要） */
export interface ManifestPermissionRequest {
  readonly capability: string;
  readonly reason?: string;
}

/** 登记后的 contribution 记录（kind 专属字段保留在 spec，按需读取） */
export interface RegisteredContribution {
  readonly pluginId: string;
  readonly version: string;
  readonly kind: ContributionKind;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly requiredCapabilities: readonly string[];
  /** 规范化后的 contribution 原始声明（工具 schema / 路由 path / Hook 时点等） */
  readonly spec: Record<string, unknown>;
}

/** 插件当前登记集合（active 版本视角） */
export interface PluginContributionSet {
  readonly pluginId: string;
  readonly version: string;
  readonly trust: PluginTrust;
  readonly manifestPermissions: readonly ManifestPermissionRequest[];
  readonly contributions: readonly RegisteredContribution[];
  readonly registeredAt: string;
}

export interface ContributionRegistryDeps {
  readonly now?: () => Date;
}

const DEFAULT_TRUST: PluginTrust = "restricted";

export class ContributionRegistry {
  private readonly now: () => Date;
  /** pluginId → active 集合 */
  private readonly sets = new Map<string, PluginContributionSet>();

  constructor(deps: ContributionRegistryDeps = {}) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 登记插件当前版本的贡献集合（幂等覆盖同一 pluginId 的旧集合）。
   * 同一 pluginId 内 contribution id 全局唯一；重复即抛错。
   */
  register(input: {
    readonly pluginId: string;
    readonly version: string;
    readonly contributions: Contributions;
    readonly manifestPermissions?: readonly ManifestPermissionRequest[];
    readonly trust?: PluginTrust;
  }): PluginContributionSet {
    this.assertPluginId(input.pluginId);
    const seen = new Set<string>();
    const registered: RegisteredContribution[] = [];
    for (const kind of CONTRIBUTION_KINDS) {
      const list = input.contributions[kind];
      if (list === undefined) {
        continue;
      }
      for (const raw of list) {
        if (typeof raw !== "object" || raw === null) {
          throw new PluginContributionError(`${input.pluginId} 的 ${kind} contribution 不是对象`);
        }
        const spec = raw as Record<string, unknown>;
        const id = spec["id"];
        if (typeof id !== "string" || id.length === 0 || id.length > 128) {
          throw new PluginContributionError(`${input.pluginId} 的 ${kind} contribution 缺少合法 id`);
        }
        if (seen.has(id)) {
          throw new PluginContributionError(`插件 ${input.pluginId} 的 contribution id 重复：${id}`);
        }
        seen.add(id);
        registered.push(this.buildContribution(input.pluginId, input.version, kind, spec));
      }
    }
    const manifestPermissions: ManifestPermissionRequest[] = (input.manifestPermissions ?? []).map(
      (request) => (request.reason !== undefined ? { ...request } : { capability: request.capability }),
    );
    const set: PluginContributionSet = {
      pluginId: input.pluginId,
      version: input.version,
      trust: input.trust ?? DEFAULT_TRUST,
      manifestPermissions,
      contributions: registered,
      registeredAt: this.now().toISOString(),
    };
    this.sets.set(input.pluginId, set);
    return set;
  }

  /** 移除插件的全部登记（禁用/更新/卸载时调用；旧 contribution 不可再命中）。 */
  unregister(pluginId: string): void {
    this.sets.delete(pluginId);
  }

  hasPlugin(pluginId: string): boolean {
    return this.sets.has(pluginId);
  }

  getActive(pluginId: string): PluginContributionSet | undefined {
    return this.sets.get(pluginId);
  }

  get(pluginId: string, id: string): RegisteredContribution | undefined {
    const set = this.sets.get(pluginId);
    if (set === undefined) {
      return undefined;
    }
    return set.contributions.find((contribution) => contribution.id === id);
  }

  list(pluginId: string): readonly RegisteredContribution[] {
    return this.sets.get(pluginId)?.contributions ?? [];
  }

  listByKind(pluginId: string, kind: ContributionKind): readonly RegisteredContribution[] {
    return this.list(pluginId).filter((contribution) => contribution.kind === kind);
  }

  isRegistered(pluginId: string, id: string): boolean {
    return this.get(pluginId, id) !== undefined;
  }

  listPlugins(): readonly string[] {
    return [...this.sets.keys()];
  }

  /** 跨插件遍历全部登记 contribution（供 Agent 工具目录/命令目录聚合）。 */
  listAll(): readonly RegisteredContribution[] {
    const result: RegisteredContribution[] = [];
    for (const pluginId of this.sets.keys()) {
      result.push(...this.list(pluginId));
    }
    return result;
  }

  // ── private helpers ───────────────────────────────────────────

  private buildContribution(
    pluginId: string,
    version: string,
    kind: ContributionKind,
    spec: Record<string, unknown>,
  ): RegisteredContribution {
    const id = spec["id"] as string;
    const name = spec["name"];
    if (typeof name !== "string" || name.length === 0 || name.length > 128) {
      throw new PluginContributionError(`${pluginId} 的 ${kind} contribution ${id} 缺少合法 name`);
    }
    const description = spec["description"];
    const requiredCapabilities = Array.isArray(spec["requiredCapabilities"])
      ? (spec["requiredCapabilities"] as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    return {
      pluginId,
      version,
      kind,
      id,
      name,
      ...(typeof description === "string" && description.length > 0 ? { description } : {}),
      requiredCapabilities,
      spec,
    };
  }

  private assertPluginId(pluginId: string): void {
    if (typeof pluginId !== "string" || !new RegExp(PLUGIN_ID_PATTERN).test(pluginId)) {
      throw new PluginContributionError("插件 ID 不合法");
    }
  }
}
