import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { RuntimePaths } from "../../config/paths.js";
import type { AuditRecorder } from "../../observability/audit-recorder.js";
import type { PluginFacade } from "../../platform/plugin-facade.js";
import { instrument } from "../../observability/instrument.js";
import type { SkillErrorCode } from "../../contracts/skill-protocol.js";

import { SkillCatalog } from "./catalog/skill-catalog.js";
import { SkillOperationStore } from "./installer/operation-store.js";
import { SessionFileRegistry } from "./installer/session-file-registry.js";
import { SkillStager } from "./installer/stager.js";
import { SkillInstaller } from "./installer/skill-installer.js";
import { AgentSkillConfigStore } from "./agent/agent-skill-config.js";
import { AgentSkillService } from "./binding/skill-binding-service.js";
import { SkillBundleService } from "./bundles/skill-bundle-service.js";
import { SessionSkillService } from "./session/session-skill-service.js";
import { SkillSnapshotService } from "./snapshot/skill-snapshot.js";
import { SkillContentService } from "./content/skill-content-service.js";
import { LoadHandleRegistry } from "./content/load-handle.js";
import { ConfirmationTokenRegistry } from "./confirmation/confirmation-token.js";
import { SkillCoreService } from "./core/skill-core-service.js";
import { scanSkills } from "./catalog/scan.js";
import { createStandardAdapters } from "./sources/factory.js";
import { DefaultSkillTrustPolicy, SkillSourceTrustStore } from "./sources/trust-config.js";
import type { SkillSourceAdapter } from "./sources/skill-source-adapter.js";
import { PluginSkillBridge } from "./plugin/plugin-skill-bridge.js";
import { createPluginFacadeStatePort } from "./plugin/plugin-skill-bridge.js";
import { createBashExecutor, sandboxPortFromService, SkillScriptRunner, type SkillScriptExecutor, type SkillScriptSandboxPort } from "./plugin/skill-script-runner.js";
import type { ReadinessEnvironment } from "./readiness.js";
import { SkillBundleStore } from "../../storage/skill-bundle-store.js";
import { AgentSkillBindingStore } from "../../storage/agent-skill-binding-store.js";
import { SessionSkillBindingStore } from "../../storage/session-skill-binding-store.js";
import { SkillActivationGrantStore } from "../../storage/skill-activation-grant-store.js";
import type { SandboxService } from "../../sandbox/sandbox-service.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T10 Skill 组合根（plans/phase-13.md §17.2：主 Agent 归属）
//
// - 装配 Catalog/安装器/绑定/Bundle/Session/Snapshot/Content/loadHandle/
//   确认令牌/Core Service 与插件桥/ScriptRunner，组合根只此一处；
// - rebuildFromDisk()：启动时从磁盘扫描重建 Catalog（五类来源；插件源经
//   PluginSkillBridge）；幂等；
// - attachPluginLifecycle()：PluginFacade 生命周期（enable/disable/update/
//   rollback/uninstall）接线 syncPluginSkills/blockPluginSkills——插件 Skill
//   跟随插件状态（卸载后 blocked + 来源诊断，正文读取 fail-closed）；
// - PI 元数据注入：messages 路由经 core.buildPiSkillsForTurn 每 turn 冻结。
// ═══════════════════════════════════════════════════════════════

export interface SkillCompositionOptions {
  readonly paths: RuntimePaths;
  readonly database: Database.Database;
  readonly audit: AuditRecorder;
  /** Session 工作区根（workspace 层扫描；缺省不扫描 workspace） */
  readonly cwd?: string;
  /** 插件门面（可选：提供插件 Skill Bundle 状态与生命周期接线） */
  readonly pluginFacade?: PluginFacade;
  /** T9：OpenClaw/Hermes 生态镜像目录（固定版本夹具；缺省无市场可用但诊断明确） */
  readonly ecosystemRegistryDir?: string;
  /** ScriptRunner 沙箱（Phase 9 SandboxService；缺省无 Sandbox → 脚本 blocked） */
  readonly sandbox?: SandboxService;
  /** ScriptRunner 执行入口（缺省拒绝直接执行） */
  readonly scriptExecutor?: SkillScriptExecutor;
  readonly now?: () => Date;
}

export interface SkillRebuildSummary {
  readonly registered: number;
  readonly skipped: readonly { readonly skillId: string; readonly reason: SkillErrorCode }[];
}

export interface SkillComposition {
  readonly core: SkillCoreService;
  readonly catalog: SkillCatalog;
  readonly installer: SkillInstaller;
  readonly agentService: AgentSkillService;
  readonly bundleService: SkillBundleService;
  readonly sessionService: SessionSkillService;
  readonly snapshots: SkillSnapshotService;
  readonly contentService: SkillContentService;
  readonly loadHandles: LoadHandleRegistry;
  readonly confirmations: ConfirmationTokenRegistry;
  readonly pluginBridge: PluginSkillBridge | undefined;
  readonly scriptRunner: SkillScriptRunner;
  readonly adapters: readonly SkillSourceAdapter[];
  /** 启动时从磁盘重建 Catalog（幂等；五类来源扫描 + 插件桥同步） */
  rebuildFromDisk(): SkillRebuildSummary;
  /** PluginFacade 生命周期接线（pluginFacade 提供时；包装 enable/disable/update/rollback/uninstall） */
  attachPluginLifecycle(): void;
}

/** 组合根环境快照：os + PATH 可解析 bin + 环境变量名 + 已启用插件（readiness 门控用）。 */
export function buildSkillReadinessEnvironment(options: {
  readonly pluginFacade?: PluginFacade;
}): ReadinessEnvironment {
  const plugins: string[] = [];
  if (options.pluginFacade !== undefined) {
    try {
      for (const plugin of options.pluginFacade.list()) {
        if (plugin.status === "enabled") {
          plugins.push(plugin.pluginId);
        }
      }
    } catch {
      // 插件状态读取失败不阻塞 Skill 系统（readiness 按缺省保守判定）
    }
  }
  return {
    os: process.platform as NodeJS.Platform,
    bins: detectPathBins(),
    env: Object.keys(process.env),
    plugins,
    tools: [],
    capabilities: [],
  };
}

/**
 * PATH 可解析的二进制名（Skill requires.bins 门控依据）。
 * Windows 匹配 .exe/.cmd/.bat/.ps1；POSIX 直接列文件名。上限 2000 防超大目录。
 */
export function detectPathBins(): string[] {
  const bins = new Set<string>();
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  let scanned = 0;
  for (const entry of entries) {
    if (entry === "" || scanned >= 2000) {
      continue;
    }
    let names: readonly string[];
    try {
      names = fs.readdirSync(entry);
    } catch {
      continue; // 目录不存在/不可读：跳过（不误判 ready）
    }
    for (const name of names) {
      if (scanned >= 2000) {
        break;
      }
      if (process.platform === "win32") {
        const match = /^(.+)\.(exe|cmd|bat|ps1)$/i.exec(name);
        if (match !== null) {
          bins.add(match[1]!.toLowerCase());
        }
      } else {
        bins.add(name);
      }
      scanned += 1;
    }
  }
  return [...bins];
}

export function buildSkillComposition(options: SkillCompositionOptions): SkillComposition {
  const { paths, database, audit, pluginFacade } = options;

  // ── 存储层 ────────────────────────────────────────────────────
  const catalog = new SkillCatalog();
  const bundles = new SkillBundleStore(database);
  const bindingStore = new AgentSkillBindingStore(database);
  const sessionBindings = new SessionSkillBindingStore(database);
  const grants = new SkillActivationGrantStore(database);
  const operations = new SkillOperationStore(database);
  const configStore = new AgentSkillConfigStore(paths);
  const sessionFiles = new SessionFileRegistry();

  // ── 信任与来源 ────────────────────────────────────────────────
  const trustStore = new SkillSourceTrustStore(paths);
  const trust = new DefaultSkillTrustPolicy(trustStore.load());
  const environment = buildSkillReadinessEnvironment({ ...(pluginFacade !== undefined ? { pluginFacade } : {}) });
  const workspace =
    options.cwd !== undefined
      ? { cwd: options.cwd, home: paths.home, trust }
      : undefined;

  // ── 插件桥（PluginFacade 提供时）──────────────────────────────
  let pluginBridge: PluginSkillBridge | undefined;
  if (pluginFacade !== undefined) {
    const statePort = createPluginFacadeStatePort({
      paths,
      getActivePlugin: (pluginId) => {
        const active = pluginFacade.get(pluginId);
        return active === undefined ? undefined : { version: active.version, status: active.status };
      },
      listAllPlugins: () => pluginFacade.list().map((plugin) => ({ pluginId: plugin.pluginId, status: plugin.status })),
      listSkillBundles: (pluginId) => pluginFacade.hostApi.skills.list(pluginId),
      listAgentBindings: (agentId) => pluginFacade.listAgentBindings(agentId),
    });
    pluginBridge = new PluginSkillBridge({
      catalog,
      paths,
      environment,
      state: statePort,
      audit,
    });
  }

  // ── 来源适配器 ────────────────────────────────────────────────
  const adapters = createStandardAdapters(paths, {
    ...(workspace !== undefined ? { workspace } : {}),
    externalTrust: trust,
    ...(pluginBridge !== undefined ? { pluginProvider: pluginBridge } : {}),
    ...(options.ecosystemRegistryDir !== undefined ? { ecosystemRegistryDir: options.ecosystemRegistryDir } : {}),
  });

  // ── 安装器 ────────────────────────────────────────────────────
  const stager = new SkillStager({ paths, adapters, sessionFiles });
  const installer = new SkillInstaller({
    paths,
    catalog,
    operations,
    sessionFiles,
    adapters,
    stager,
    environment,
  });

  // ── 领域服务 ──────────────────────────────────────────────────
  const agentService = new AgentSkillService({
    paths,
    catalog,
    configStore,
    bindingStore,
    bundles,
    audit,
    operations,
  });
  const bundleService = new SkillBundleService({
    paths,
    bundles,
    catalog,
    configStore,
    bindingStore,
    audit,
    operations,
  });
  const sessionService = new SessionSkillService({ catalog, sessionBindings, grants });
  const snapshots = new SkillSnapshotService();
  const loadHandles = new LoadHandleRegistry();
  const confirmations = new ConfirmationTokenRegistry();
  const contentService = new SkillContentService({ catalog, snapshots });

  // ── Core Service ──────────────────────────────────────────────
  const core = new SkillCoreService({
    catalog,
    installer,
    agentService,
    bundleService,
    sessionService,
    snapshots,
    contentService,
    loadHandles,
    confirmations,
    sessionFiles,
    environment,
    trust,
    ...(workspace !== undefined ? { workspace } : {}),
    adapters,
  });

  // ── ScriptRunner（沙箱/执行缺省拒绝；插件来源阻断经 bridge）───
  const sandboxPort: SkillScriptSandboxPort | undefined =
    options.sandbox !== undefined ? sandboxPortFromService(options.sandbox) : undefined;
  const scriptRunner = new SkillScriptRunner({
    catalog,
    ...(sandboxPort !== undefined ? { sandbox: sandboxPort } : {}),
    ...(options.scriptExecutor !== undefined ? { executor: options.scriptExecutor } : {}),
    ...(pluginBridge !== undefined
      ? {
          blockedSourceCheck: (skillRef) => {
            try {
              pluginBridge.assertPluginSkillReadable(skillRef);
              return { blocked: false };
            } catch (error) {
              return {
                blocked: true,
                reason: error instanceof Error ? error.message : "插件来源 Skill 已阻断",
              };
            }
          },
        }
      : {}),
  });

  // ── 生命周期接线 ──────────────────────────────────────────────
  function rebuildFromDisk(): SkillRebuildSummary {
    const skipped: { skillId: string; reason: SkillErrorCode }[] = [];
    try {
      // 五类来源扫描（workspace 需信任；plugin 经 bridge）
      const report = scanSkills({
        paths,
        cwd: options.cwd ?? process.cwd(),
        home: paths.home,
        trust,
        environment,
        catalog,
        ...(pluginBridge !== undefined ? { pluginProvider: pluginBridge } : {}),
      });
      for (const item of report.skipped) {
        skipped.push({ skillId: item.sourceKind, reason: "skill_source_not_found" });
      }
      for (const item of report.failed) {
        skipped.push({ skillId: item.candidate.displayName, reason: "skill_manifest_invalid" });
      }
    } catch (error) {
      instrument.warn("skill.rebuild.failed", "Skill Catalog 磁盘重建失败", {
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
    if (pluginBridge !== undefined) {
      try {
        pluginBridge.initialize();
      } catch (error) {
        instrument.warn("skill.plugin_bridge.init_failed", "插件 Skill 桥初始化失败", {
          reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
    }
    return { registered: catalog.list({}).length, skipped };
  }

  function attachPluginLifecycle(): void {
    if (pluginFacade === undefined || pluginBridge === undefined) {
      return;
    }
    const facade = pluginFacade;
    // 包装生命周期方法：成功后同步插件 Skill，离场后阻断（best-effort，失败只 warn）
    const wrap = <A extends unknown[]>(
      original: (...args: A) => Promise<unknown>,
      onSuccess: (pluginId: string) => void,
      onLeave: ((pluginId: string) => void) | undefined,
    ) => {
      return async (...args: A): Promise<unknown> => {
        const pluginId = String(args[0]);
        const result = await original(...args);
        try {
          if (onLeave !== undefined) {
            onLeave(pluginId);
          } else {
            onSuccess(pluginId);
          }
        } catch (error) {
          instrument.warn("skill.plugin_lifecycle.hook_failed", "插件 Skill 生命周期钩子执行失败", {
            pluginId,
            reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
          });
        }
        return result;
      };
    };
    facade.enable = wrap(facade.enable.bind(facade), (pluginId) => pluginBridge.syncPluginSkills(pluginId), undefined) as typeof facade.enable;
    facade.disable = wrap(facade.disable.bind(facade), () => undefined, (pluginId) => pluginBridge.blockPluginSkills(pluginId, "plugin_disabled")) as typeof facade.disable;
    facade.update = wrap(facade.update.bind(facade), (pluginId) => pluginBridge.syncPluginSkills(pluginId), undefined) as typeof facade.update;
    facade.rollback = wrap(facade.rollback.bind(facade), (pluginId) => pluginBridge.syncPluginSkills(pluginId), undefined) as typeof facade.rollback;
    facade.uninstall = wrap(facade.uninstall.bind(facade), () => undefined, (pluginId) => pluginBridge.blockPluginSkills(pluginId, "plugin_uninstalled")) as typeof facade.uninstall;
  }

  return {
    core,
    catalog,
    installer,
    agentService,
    bundleService,
    sessionService,
    snapshots,
    contentService,
    loadHandles,
    confirmations,
    pluginBridge,
    scriptRunner,
    adapters,
    rebuildFromDisk,
    attachPluginLifecycle,
  };
}
