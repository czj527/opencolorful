import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { ActorRef, EventScope, ExecutorRef, TraceContext } from "../../../contracts/observability.js";
import {
  skillRefKey,
  type SkillRef,
  type SkillStatus,
} from "../../../contracts/skill-protocol.js";
import type { AuditRecorder } from "../../../observability/audit-recorder.js";
import { instrument } from "../../../observability/instrument.js";
import { pluginVersionDir, safeJoin as pluginSafeJoin } from "../../plugins/paths.js";
import { runStrictAuditLifecycle } from "../../plugins/contributions/shared.js";
import type { RegisteredSkill, SkillCatalog } from "../catalog/skill-catalog.js";
import { SkillError } from "../errors.js";
import { slugifySkillId } from "../manifest.js";
import { safeJoin } from "../path-safety.js";
import type { ReadinessEnvironment } from "../readiness.js";
import { SKILL_SOURCE_BLOCKED_REASON_PREFIX, pluginAwareReadiness, type PluginBindingStatus } from "./plugin-readiness.js";
import type { PluginSkillBundleInput, PluginSkillBundleProvider } from "../sources/plugin-source.js";
import { copyPackageTree } from "../sources/stage-utils.js";
import { inspectLocalDirectory, nowIsoTimestamp, scanPackagesInDirectory } from "../sources/skill-source-adapter.js";
import { validateSkillPackage } from "../validator.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T7 Plugin Skill Bundle 桥（plans/phase-13.md §13.1 / §12.2）
//
// 把 Phase 12 插件声明的 skill-bundle 贡献（skillsDir）接入统一 Catalog：
// - syncPluginSkills(pluginId)：插件启用/更新/回滚到新版本时调用——扫描插件
//   skillsDir，经 inspect 全量校验后登记（sourceKind="plugin"，sourceId=插件
//   id，version=插件版本，rootPath=包根目录，内容读取仍走 SkillContentService）；
//   同插件新版本 = 新 skillRefKey → 旧版本条目自然保留（可回滚）；
// - blockPluginSkills(pluginId, reason)：插件禁用/卸载/回滚离场时调用——
//   Catalog 条目与绑定引用保留，但来源置 blocked（bridge 持有阻断态），
//   readiness=blocked + 来源诊断，正文读取 fail-closed（assertPluginSkillReadable）；
//   用户显式"固定到 Managed Store"转存（fixPluginSkillToManaged）是独立操作：
//   复制正文到 Managed Store + 重登记（sourceKind="managed"）+ 严格审计
//   （audit.skill.install_started/completed/failed，runStrictAuditLifecycle）；
// - 只诊断不授权：本模块不创建任何 Grant；插件不能绕过 Agent 选择模式；
// - 阻断态为进程内存（bridge 生命周期）；T10 在组合根启动时对全部插件调用
//   initialize()（enabled→sync，其余→block），保证重启后无 fail-open 窗口。
//
// T10 接线点（PluginFacade 生命周期，见报告）：
//   enable()     → hostApi.activate 成功后 → bridge.syncPluginSkills(pluginId)
//   disable()    → hostApi.deactivate 后    → bridge.blockPluginSkills(pluginId, "plugin_disabled")
//   update()     → 新版本激活成功后          → bridge.syncPluginSkills(pluginId)
//   rollback()   → 旧版本重新激活后          → bridge.syncPluginSkills(pluginId)
//   uninstall()  → hostApi.deactivate 后    → bridge.blockPluginSkills(pluginId, "plugin_uninstalled")
//   启动          → activateAllEnabled 前    → bridge.initialize()
// ═══════════════════════════════════════════════════════════════

/** 插件 skill-bundle 贡献（skillsDir 已解析为插件版本目录内绝对路径）。 */
export interface PluginSkillBundleContribution {
  readonly pluginId: string;
  readonly contributionId: string;
  /** 插件版本（Skill 版本=插件版本，保证 skillRefKey 随插件版本变化） */
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  /** skills/ 目录绝对路径（插件版本目录内，canonical 校验后） */
  readonly skillsDir: string;
}

/** 插件状态读取端口（T10 用 createPluginFacadeStatePort 从 PluginFacade 适配）。 */
export interface PluginSkillStatePort {
  /** 插件是否启用（status=enabled 且为 active 版本） */
  isEnabled(pluginId: string): boolean;
  /** 当前 active 版本；未安装/removed → undefined */
  activeVersion(pluginId: string): string | undefined;
  /** 全部已安装（非 removed）插件 id */
  listPluginIds(): readonly string[];
  /** 插件声明的 skill-bundle 贡献（含绝对 skillsDir） */
  listSkillBundles(pluginId: string): readonly PluginSkillBundleContribution[];
  /** Agent 插件绑定视图（binding 行 + enabled 位） */
  listAgentBindings(agentId: string): readonly PluginBindingStatus[];
}

/** 插件生命周期离场原因（禁用/卸载/回滚统一走 block，原因进 blockedReason 诊断）。 */
export type PluginSkillBlockReason = "plugin_disabled" | "plugin_uninstalled" | "plugin_rolled_back";

export interface PluginSkillBridgeDeps {
  readonly catalog: SkillCatalog;
  readonly paths: RuntimePaths;
  /** 登记时的基础环境快照（readiness 初始诊断；T10 用真实插件状态构建） */
  readonly environment: ReadinessEnvironment;
  readonly state: PluginSkillStatePort;
  /** 严格审计（fixPluginSkillToManaged 必需；缺省则转存 fail-closed 拒绝） */
  readonly audit?: AuditRecorder;
  readonly actor?: ActorRef;
}

export interface PluginSkillSyncSummary {
  readonly pluginId: string;
  readonly version: string | undefined;
  readonly imported: readonly PluginSkillImportItem[];
  /** 校验失败/哈希不可用被跳过的 Skill（fail-closed：不登记损坏包） */
  readonly skipped: readonly PluginSkillSkipItem[];
  readonly skippedBundles: readonly PluginSkillSkipBundleItem[];
}

export interface PluginSkillImportItem {
  readonly skillRefKey: string;
  readonly skillId: string;
  readonly version: string;
  readonly contentHash: string;
}

export interface PluginSkillSkipItem {
  readonly skillId: string;
  readonly reason: string;
}

export interface PluginSkillSkipBundleItem {
  readonly contributionId: string;
  readonly reason: string;
}

export interface PluginSkillBlockResult {
  readonly pluginId: string;
  readonly reason: PluginSkillBlockReason;
  /** 受影响的 Catalog 条目数（条目保留，仅来源置 blocked） */
  readonly affected: number;
}

export interface FixPluginSkillToManagedResult {
  readonly operationId: string;
  /** 插件来源条目 refKey（beforeRevision） */
  readonly fromRefKey: string;
  readonly skillRef: SkillRef;
  readonly skillRefKey: string;
  readonly registered: RegisteredSkill;
}

const EXECUTOR: ExecutorRef = { kind: "service", id: "skill-plugin-bridge" };

export class PluginSkillBridge implements PluginSkillBundleProvider {
  /** pluginId → 离场原因（禁用/卸载/回滚）；进程内存，启动时由 initialize() 重建 */
  private readonly blockedSources = new Map<string, PluginSkillBlockReason>();

  constructor(private readonly deps: PluginSkillBridgeDeps) {}

  // ── 同步（启用/更新/回滚到新版本）───────────────────────────────

  /**
   * 把插件声明的 skill-bundle 贡献导入统一 Catalog。
   * 插件未启用 → fail-closed 转为 blockPluginSkills（不假装已同步）。
   * 插件更新/回滚后再次调用：新版本 = 新 skillRefKey 追加，旧版本条目保留。
   */
  syncPluginSkills(pluginId: string): PluginSkillSyncSummary {
    const version = this.deps.state.activeVersion(pluginId);
    if (version === undefined || !this.deps.state.isEnabled(pluginId)) {
      this.blockPluginSkills(pluginId, "plugin_disabled");
      return {
        pluginId,
        version: undefined,
        imported: [],
        skipped: [],
        skippedBundles: [{ contributionId: "*", reason: "plugin-not-enabled" }],
      };
    }
    this.blockedSources.delete(pluginId);
    const operationId = `skill-plugin-sync-${crypto.randomUUID().slice(0, 8)}`;
    const imported: PluginSkillImportItem[] = [];
    const skipped: PluginSkillSkipItem[] = [];
    const skippedBundles: PluginSkillSkipBundleItem[] = [];

    for (const bundle of this.deps.state.listSkillBundles(pluginId)) {
      let found: ReturnType<typeof scanPackagesInDirectory>;
      try {
        found = scanPackagesInDirectory(bundle.skillsDir, {
          sourceKind: "plugin",
          // sourceId = 插件 id（稳定，不随包路径变化；版本=插件版本）
          sourceId: () => pluginId,
          defaultVersion: bundle.version,
          buildProvenance: (rootPath) => ({
            sourceRef: `${pluginId}@${bundle.version}#${path.basename(rootPath)}`,
            fetchedAt: nowIsoTimestamp(),
          }),
        });
      } catch (error) {
        skippedBundles.push({ contributionId: bundle.contributionId, reason: error instanceof Error ? error.message.slice(0, 200) : "scan-failed" });
        continue;
      }
      for (const foundSkill of found) {
        const inspection = inspectLocalDirectory(foundSkill.rootPath, { version: bundle.version });
        const valid = inspection.errors.length === 0;
        const skillId = slugifySkillId(inspection.manifest?.name ?? foundSkill.candidate.displayName);
        if (!valid || inspection.contentHash.length === 0) {
          // fail-closed：损坏/哈希不可用包不登记（与 T3 安装器同语义）
          skipped.push({ skillId, reason: inspection.errors[0]?.message ?? "content-hash-unavailable" });
          continue;
        }
        const registered = this.deps.catalog.registerCandidate({
          skillId,
          sourceId: pluginId,
          sourceKind: "plugin",
          version: bundle.version,
          displayName: foundSkill.candidate.displayName,
          rootPath: foundSkill.rootPath,
          contentHash: inspection.contentHash,
          sizeBytes: inspection.sizeBytes,
          fileCount: inspection.fileCount,
          manifest: inspection.manifest,
          compatibility: inspection.compatibility,
          validity: "valid",
          validityErrors: [],
          ...(foundSkill.candidate.provenance !== undefined ? { provenance: foundSkill.candidate.provenance } : {}),
          // 插件安装已获用户授权；Skill 来源信任继承插件安装决策
          trusted: true,
          environment: this.deps.environment,
        });
        const refKey = skillRefKey(registered.skillRef);
        imported.push({ skillRefKey: refKey, skillId, version: bundle.version, contentHash: registered.contentHash.slice(0, 24) });
        this.emitSkillEvent("skill.discovered", operationId, {
          skillRefKey: refKey,
          skillId,
          sourceId: pluginId,
          version: bundle.version,
          contentHash: registered.contentHash.slice(0, 24),
        });
      }
    }
    return { pluginId, version, imported, skipped, skippedBundles };
  }

  // ── 阻断（禁用/卸载/回滚离场）──────────────────────────────────

  /**
   * 插件离场：Catalog 条目与绑定引用保留，来源置 blocked（来源诊断进
   * blockedReason）。幂等；重复调用只重新计数并记录事件。
   */
  blockPluginSkills(pluginId: string, reason: PluginSkillBlockReason): PluginSkillBlockResult {
    this.blockedSources.set(pluginId, reason);
    const affected = this.deps.catalog.list({ sourceKind: "plugin" }).filter((skill) => skill.sourceId === pluginId).length;
    this.emitSkillEvent("skill.blocked", `skill-plugin-block-${crypto.randomUUID().slice(0, 8)}`, {
      pluginId,
      sourceId: pluginId,
      count: affected,
      reason,
      reasonCode: SKILL_SOURCE_BLOCKED_REASON_PREFIX,
    });
    return { pluginId, reason, affected };
  }

  /** 来源阻断诊断（fail-closed 查询；未阻断 → blocked=false）。 */
  sourceBlockedInfo(pluginId: string): { readonly blocked: boolean; readonly reason: string } {
    const reason = this.blockedSources.get(pluginId);
    return reason === undefined ? { blocked: false, reason: "" } : { blocked: true, reason };
  }

  /** 转存（"固定到 Managed Store"）前置门槛：blocked 来源正文读取 fail-closed。 */
  assertPluginSkillReadable(skillRef: SkillRef): void {
    if (skillRef.sourceKind !== "plugin") {
      return;
    }
    const info = this.sourceBlockedInfo(skillRef.sourceId);
    if (info.blocked) {
      throw new SkillError("skill_content_read_denied", `插件来源不可用（${info.reason}），正文读取已拒绝：${skillRef.sourceId}`);
    }
  }

  /**
   * 插件感知 status 覆盖视图：blocked 来源 → readiness=blocked + 来源诊断；
   * 提供 agentId 时对 requires.plugins 用真实绑定重算（只诊断不授权）。
   */
  overlayStatus(skill: RegisteredSkill, agentId?: string): SkillStatus {
    const sourceBlocked = skill.sourceKind === "plugin" ? this.sourceBlockedInfo(skill.sourceId) : { blocked: false, reason: "" };
    if (agentId === undefined) {
      if (sourceBlocked.blocked) {
        return { ...skill.status, readiness: "blocked", blockedReason: `${SKILL_SOURCE_BLOCKED_REASON_PREFIX}:${sourceBlocked.reason}` };
      }
      return skill.status;
    }
    const diagnosis = pluginAwareReadiness({
      manifest: skill.manifest,
      environment: this.deps.environment,
      pluginBindings: this.deps.state.listAgentBindings(agentId).map((binding) => ({ pluginId: binding.pluginId, enabled: binding.enabled })),
      ...(sourceBlocked.blocked ? { sourceBlocked: { reason: sourceBlocked.reason } } : {}),
    });
    return {
      ...skill.status,
      readiness: diagnosis.readiness,
      ...(diagnosis.blockedReason !== undefined ? { blockedReason: diagnosis.blockedReason } : {}),
    };
  }

  /** Agent 环境快照（plugins 维 = 已绑定且启用的插件；供 T10 注入 CoreService）。 */
  buildAgentEnvironment(agentId: string, base: ReadinessEnvironment = this.deps.environment): ReadinessEnvironment {
    const bound = this.deps.state
      .listAgentBindings(agentId)
      .filter((binding) => binding.enabled)
      .map((binding) => binding.pluginId);
    return { ...base, plugins: bound };
  }

  // ── 固定到 Managed Store（独立操作，不走安装器流水线）────────────

  /**
   * 转存：把插件来源的 Skill 正文复制为 Managed Store 不可变 Artifact，
   * 重登记（sourceKind="managed"），严格审计生命周期
   * （audit.skill.install_started/completed/failed）。
   * - 插件条目保留（blocked 与否不变）；managed 条目是新的独立登记；
   * - 同版本同哈希 → 幂等复用；同版本不同哈希 → skill_version_conflict；
   * - 审计不可用 → 拒绝（fail-closed）；审计失败 → 补偿删除已复制目录。
   */
  fixPluginSkillToManaged(input: {
    readonly pluginId: string;
    readonly skillId: string;
    readonly actor?: ActorRef;
    readonly sessionId?: string;
  }): FixPluginSkillToManagedResult {
    if (this.deps.audit === undefined) {
      throw new SkillError("skill_operation_failed", "严格审计不可用，转存被拒绝（fail-closed）");
    }
    const candidates = this.deps.catalog
      .list({ sourceKind: "plugin" })
      .filter((skill) => skill.sourceId === input.pluginId && skill.skillId === input.skillId);
    if (candidates.length === 0) {
      throw new SkillError("skill_unknown_skillref", `插件来源中不存在该 Skill：${input.pluginId}#${input.skillId}`);
    }
    // 多版本并存时取最高版本（旧版本仍保留在 Catalog，可回滚）
    const record = candidates.reduce((best, current) => (compareVersions(current.version, best.version) > 0 ? current : best));
    const validation = validateSkillPackage({ packageRoot: record.rootPath, version: record.version });
    if (!validation.ok) {
      throw new SkillError(validation.errors[0]?.reasonCode ?? "skill_package_invalid", validation.errors[0]?.message ?? "转存前校验失败");
    }
    // 闭包内 narrowing 不保留属性访问：先收窄到局部常量
    const contentHash = validation.contentHash;
    const manifest = validation.manifest;
    if (manifest === null || contentHash === null) {
      throw new SkillError("skill_package_invalid", "转存来源缺少标准化 Manifest 或内容哈希");
    }
    const operationId = `skill-plugin-fix-${crypto.randomUUID()}`;
    const fromRefKey = skillRefKey(record.skillRef);
    const skillRoot = safeJoin(this.deps.paths.skillsInstalled, input.skillId);
    const targetVersionDir = safeJoin(skillRoot, record.version);
    // 预计算 managed 条目 refKey（afterRevision；内容哈希/版本已确定）
    const managedRef: SkillRef = {
      skillId: record.skillId,
      sourceId: targetVersionDir,
      sourceKind: "managed",
      version: record.version,
      contentHash,
    };
    const afterRefKey = skillRefKey(managedRef);
    // audit payload schema（冻结契约）的 revision 字段上限 64 字符：
    // 长 refKey（managed sourceId 为绝对路径）截断存储；完整 refKey 经
    // target_id（skill:<refKey>，TEXT 列无长度限制）保留，审计查询按
    // target_id / beforeRevision 精确过滤。
    const beforeRevision = fromRefKey.slice(0, 64);
    const afterRevision = afterRefKey.slice(0, 64);
    const actor = input.actor ?? this.deps.actor ?? { kind: "user", id: "web" };
    const scope: EventScope = input.sessionId !== undefined ? { sessionId: input.sessionId } : {};
    const trace: TraceContext = { traceId: operationId, spanId: operationId, operationId };

    const registered = runStrictAuditLifecycle(
      {
        audit: this.deps.audit,
        trace,
        actor,
        executor: EXECUTOR,
        target: { kind: "external_resource", id: `skill:${fromRefKey}` },
        scope,
        startEventName: "audit.skill.install_started",
        completedEventName: "audit.skill.install_completed",
        failedEventName: "audit.skill.install_failed",
        action: "skill.plugin_fix_to_managed",
        beforeRevision,
        afterRevision,
        changedFields: ["sourceKind", "sourceId", "rootPath", "version", "pluginId"],
        // 审计事务失败补偿：删除已复制的 Managed Artifact（尽力而为）
        rollback: () => {
          fs.rmSync(targetVersionDir, { recursive: true, force: true });
          try {
            if (fs.readdirSync(skillRoot).length === 0) {
              fs.rmSync(skillRoot, { recursive: true, force: true });
            }
          } catch {
            /* 忽略 */
          }
        },
      },
      () => {
        let idempotent = false;
        if (fs.existsSync(targetVersionDir)) {
          const existing = this.deps.catalog.list({ sourceKind: "managed" }).find((skill) => skill.sourceId === targetVersionDir);
          if (existing !== undefined && existing.contentHash === contentHash) {
            idempotent = true; // 幂等复用：同版本同哈希已转存
          } else {
            throw new SkillError("skill_version_conflict", `Managed Store 中该版本内容哈希不一致：${record.skillId}@${record.version}`);
          }
        } else {
          fs.mkdirSync(skillRoot, { recursive: true });
          const tempDir = safeJoin(skillRoot, `.tmp-${operationId}`);
          try {
            copyPackageTree(record.rootPath, tempDir, { exclude: [".git"] });
            fs.renameSync(tempDir, targetVersionDir);
          } catch (error) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            throw error;
          }
        }
        void idempotent;
        return this.deps.catalog.registerCandidate({
          skillId: record.skillId,
          sourceId: targetVersionDir,
          sourceKind: "managed",
          version: record.version,
          displayName: record.displayName,
          rootPath: targetVersionDir,
          contentHash,
          sizeBytes: validation.sizeBytes,
          fileCount: validation.fileCount,
          manifest,
          compatibility: validation.compatibility,
          validity: "valid",
          validityErrors: [],
          provenance: {
            sourceRef: `${input.pluginId}@${record.version}#${record.skillId}`,
            fetchedAt: nowIsoTimestamp(),
          },
          trusted: true,
          environment: this.deps.environment,
        });
      },
    );
    return {
      operationId,
      fromRefKey,
      skillRef: registered.skillRef,
      skillRefKey: skillRefKey(registered.skillRef),
      registered,
    };
  }

  // ── 组合根启动恢复 / T2 PluginSkillSource 适配 ─────────────────

  /**
   * 组合根启动：对全部已安装插件重建阻断/同步状态（enabled → sync，
   * 其余 → block），保证重启后无 fail-open 窗口。
   */
  initialize(): { readonly synced: readonly string[]; readonly blocked: readonly string[] } {
    const synced: string[] = [];
    const blocked: string[] = [];
    for (const pluginId of this.deps.state.listPluginIds()) {
      if (this.deps.state.isEnabled(pluginId)) {
        this.syncPluginSkills(pluginId);
        synced.push(pluginId);
      } else {
        this.blockPluginSkills(pluginId, "plugin_disabled");
        blocked.push(pluginId);
      }
    }
    return { synced, blocked };
  }

  /** 供 T2 PluginSkillSource 适配器接线（provider 形状；仅启用插件）。 */
  list(): readonly PluginSkillBundleInput[] {
    const inputs: PluginSkillBundleInput[] = [];
    for (const pluginId of this.deps.state.listPluginIds()) {
      if (!this.deps.state.isEnabled(pluginId)) {
        continue;
      }
      for (const bundle of this.deps.state.listSkillBundles(pluginId)) {
        inputs.push({
          pluginId,
          contributionId: bundle.contributionId,
          version: bundle.version,
          skillsDir: bundle.skillsDir,
        });
      }
    }
    return inputs;
  }

  // ── 事件（只记录元数据：refKey/hash 前缀/大小摘要，绝不记录正文）──

  private emitSkillEvent(
    eventName: "skill.discovered" | "skill.blocked",
    operationId: string,
    attributes: Record<string, string | number | boolean>,
  ): void {
    instrument.activity({
      eventName,
      operationId,
      actor: { kind: "system", id: "skill-plugin-bridge" },
      executor: EXECUTOR,
      payload: { summaryCode: eventName.replace(/\./g, "_"), attributes },
    });
  }
}

// ── T10 装配辅助：从 PluginFacade 形状适配状态端口 ───────────────

export interface PluginFacadeStatePortInput {
  readonly paths: RuntimePaths;
  /** facade.registry.getActive（PluginInstallationRecord | undefined） */
  readonly getActivePlugin: (pluginId: string) => { readonly version: string; readonly status: string } | undefined;
  /** facade.registryStore.listAll 或 facade.list()（含 pluginId/status） */
  readonly listAllPlugins: () => readonly { readonly pluginId: string; readonly status: string }[];
  /** facade.hostApi.skills.list(pluginId)（SkillBundleDescriptor[]） */
  readonly listSkillBundles: (
    pluginId: string,
  ) => readonly {
    readonly pluginId: string;
    readonly contributionId: string;
    readonly version: string;
    readonly name: string;
    readonly description?: string;
    readonly skillsDir?: string;
  }[];
  /** facade.bindings.listByAgent(agentId)（AgentPluginBinding[]） */
  readonly listAgentBindings: (agentId: string) => readonly { readonly pluginId: string; readonly enabled: boolean }[];
}

/**
 * 从 PluginFacade 形状创建状态端口：skillsDir 相对路径解析为插件版本目录内
 * 绝对路径（canonical 校验，逃逸贡献跳过），版本 = 当前 active 版本。
 */
export function createPluginFacadeStatePort(input: PluginFacadeStatePortInput): PluginSkillStatePort {
  const resolveSkillsDir = (pluginId: string, version: string, skillsDir: string): string | undefined => {
    const segments = skillsDir.split(/[\\/]+/).filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return undefined;
    }
    try {
      return pluginSafeJoin(pluginVersionDir(input.paths, pluginId, version), ...segments);
    } catch {
      return undefined;
    }
  };
  return {
    isEnabled(pluginId) {
      const active = input.getActivePlugin(pluginId);
      return active !== undefined && active.status === "enabled";
    },
    activeVersion(pluginId) {
      return input.getActivePlugin(pluginId)?.version;
    },
    listPluginIds() {
      return input.listAllPlugins().map((plugin) => plugin.pluginId);
    },
    listSkillBundles(pluginId) {
      const version = input.getActivePlugin(pluginId)?.version;
      if (version === undefined) {
        return [];
      }
      const result: PluginSkillBundleContribution[] = [];
      for (const bundle of input.listSkillBundles(pluginId)) {
        if (bundle.skillsDir === undefined || bundle.skillsDir.trim() === "") {
          continue;
        }
        const skillsDir = resolveSkillsDir(pluginId, version, bundle.skillsDir);
        if (skillsDir === undefined) {
          continue;
        }
        result.push({
          pluginId,
          contributionId: bundle.contributionId,
          version: bundle.version,
          name: bundle.name,
          ...(bundle.description !== undefined ? { description: bundle.description } : {}),
          skillsDir,
        });
      }
      return result;
    },
    listAgentBindings(agentId) {
      return input.listAgentBindings(agentId).map((binding) => ({ pluginId: binding.pluginId, enabled: binding.enabled }));
    },
  };
}

/** 简单 semver 比较（"1.2.3" 风格；非数字段忽略）。 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[^0-9]+/).map((part) => Number.parseInt(part, 10) || 0);
  const partsB = b.split(/[^0-9]+/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
