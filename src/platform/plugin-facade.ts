import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { RuntimePaths } from "../config/paths.js";
import type { ActorRef, ExecutorRef } from "../contracts/observability.js";
import type {
  AgentPluginBinding,
  CompatibilityReport,
  ManifestV1,
  NormalizedPluginManifest,
  PluginSourceRef,
  PluginSourceType,
} from "../contracts/plugin-protocol.js";
import type { PluginInstallationRecord } from "../storage/plugin-registry-store.js";
import type { AuditRecorder } from "../observability/audit-recorder.js";
import { instrument } from "../observability/instrument.js";
import { PluginRegistry, type PluginInstallResult } from "../runtime/plugins/registry/plugin-registry.js";
import {
  buildCompatibilityReport,
  comparePluginVersions,
  PluginInstallError,
  PluginInstaller,
  type PreparedPlugin,
} from "../runtime/plugins/installer/plugin-installer.js";
import { LocalSourceAdapter } from "../runtime/plugins/sources/local-source.js";
import { ZipSourceAdapter } from "../runtime/plugins/sources/zip-source.js";
import { GitSourceAdapter } from "../runtime/plugins/sources/git-source.js";
import { NpmSourceAdapter } from "../runtime/plugins/sources/npm-source.js";
import { OpenClawSourceAdapter } from "../runtime/plugins/sources/openclaw-source.js";
import { HermesSourceAdapter } from "../runtime/plugins/sources/hermes-source.js";
import { PluginRegistryStore } from "../storage/plugin-registry-store.js";
import { PluginGrantStore } from "../storage/plugin-grant-store.js";
import { PluginBindingStore } from "../storage/plugin-binding-store.js";
import { PluginConfigStore } from "../storage/plugin-config-store.js";
import { GrantService, type GrantChangeRequest } from "../runtime/plugins/grants/grant-service.js";
import { BindingService } from "../runtime/plugins/grants/binding-service.js";
import { EffectivePolicy } from "../runtime/plugins/grants/effective-policy.js";
import { HostBroker } from "../runtime/plugins/grants/host-broker.js";
import { SandboxBridge } from "../runtime/plugins/grants/sandbox-bridge.js";
import { CarrierRegistry } from "../runtime/plugins/runtimes/carrier-registry.js";
import { RuntimeHost } from "../runtime/plugins/runtimes/runtime-host.js";
import { PluginHostApi } from "../runtime/plugins/contributions/host-api.js";
import { InMemorySecretStore } from "../runtime/plugins/contributions/secret-contribution.js";
import type { PluginSecretStore } from "../runtime/plugins/contributions/secret-contribution.js";
import { FileSecretStore } from "../runtime/plugins/contributions/file-secret-store.js";
import type { SurfaceDescriptor } from "../runtime/plugins/contributions/surface-contribution.js";
import { PluginDevHost } from "../runtime/plugins/dev/dev-host.js";
import { PluginDevInvokeService, type PluginDevInvokeToolInput } from "../runtime/plugins/dev/dev-invoke.js";
import { PluginDevScenarioService, type PluginDevScenarioRunInput } from "../runtime/plugins/dev/dev-scenario.js";
import { convertOpenClawPlugin, type CompatibilityReportMirror, type NormalizedPluginManifestMirror } from "../runtime/plugins/compat/openclaw-compat.js";
import { convertHermesPlugin, readHermesPluginDir } from "../runtime/plugins/compat/hermes-compat.js";
import { materializeHermesWorker } from "../runtime/plugins/compat/hermes-python-bridge.js";
import type { SourceSearchResult } from "../runtime/plugins/sources/source-adapter.js";
import { assertNotSymlinkOrJunction, pluginDataDir, pluginVersionDir, safeJoin } from "../runtime/plugins/paths.js";

export interface PluginFacadeDeps {
  readonly database: Database.Database;
  readonly paths: RuntimePaths;
  readonly audit: AuditRecorder;
  readonly hostVersion: string;
  readonly nodePath?: string;
  readonly pythonInterpreter?: string;
}

export interface PluginOperationActor {
  readonly actor: ActorRef;
  readonly executor?: ExecutorRef;
}

/** inspect 结果（安装前展示：来源/版本/兼容/权限/风险） */
export interface PluginInspectResult {
  readonly pluginId: string;
  readonly version: string;
  readonly compatibility: CompatibilityReport;
  readonly manifest: ManifestV1;
  readonly normalized: NormalizedPluginManifest;
  readonly sourceRef: PluginSourceRef;
  readonly provenance: unknown;
  readonly blocked: boolean;
  readonly blockedReasons: readonly string[];
}

/** 列表项视图（Web 插件中心契约：最小集 + 富化可选字段） */
export interface PluginListItemView {
  readonly pluginId: string;
  readonly version: string;
  readonly active: boolean;
  readonly status: string;
  readonly sourceType: PluginSourceType;
  readonly sourceRef: string;
  readonly installedAt: string;
  readonly name?: string;
  readonly trust?: string;
  readonly runtimeKind?: string;
  readonly enabled?: boolean;
  readonly rollbackAvailable?: boolean;
  readonly updateAvailable?: boolean;
}

/** 详情视图（含授权/绑定/Secret/Surface/运行时状态） */
export interface PluginDetailView extends PluginListItemView {
  readonly manifest?: unknown;
  readonly grants: readonly unknown[];
  readonly agentBindings: readonly unknown[];
  readonly secretStatus: readonly string[];
  readonly surfaces: readonly SurfaceDescriptor[];
  readonly configValues: readonly unknown[];
  readonly runtime: {
    readonly kind?: string;
    readonly runtimeInstanceId?: string;
    readonly status?: string;
    readonly health: boolean;
  };
}

const WEB_ACTOR: PluginOperationActor = {
  actor: { kind: "user", id: "web" },
  executor: { kind: "service", id: "plugin-facade" },
};

/** 资产 Content-Type 推断（受限白名单，未知扩展名回 application/octet-stream） */
function contentTypeForAsset(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": case ".htm": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".txt": case ".md": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

/**
 * Phase 12 组合根门面（plans/phase-12.md §19.2 src/platform/plugin-*）。
 * 装配 Registry/Sources/Installer/Grants/Bindings/Runtime/Contributions/Dev，
 * 对外提供 inspect/install/enable/disable/update/rollback/uninstall/bind/dev
 * 高层 API；生态包（OpenClaw/Hermes）经 compat 转换后走 installNormalized。
 */
export class PluginFacade {
  readonly registry: PluginRegistry;
  readonly grants: GrantService;
  readonly bindings: BindingService;
  readonly policy: EffectivePolicy;
  readonly broker: HostBroker;
  readonly runtimeHost: RuntimeHost;
  readonly hostApi: PluginHostApi;
  readonly devHost: PluginDevHost;
  readonly devInvoke: PluginDevInvokeService;
  readonly devScenario: PluginDevScenarioService;
  private readonly installer: PluginInstaller;
  private readonly registryStore: PluginRegistryStore;
  private readonly grantStore: PluginGrantStore;
  private readonly bindingStore: PluginBindingStore;
  private readonly configStore: PluginConfigStore;
  private readonly secretStore: PluginSecretStore;
  private readonly adapters: readonly import("../runtime/plugins/sources/source-adapter.js").PluginSourceAdapter[];
  private readonly paths: RuntimePaths;

  constructor(private readonly deps: PluginFacadeDeps) {
    this.paths = deps.paths;
    const registryStore = new PluginRegistryStore(deps.database);
    this.registryStore = registryStore;
    const grantStore = new PluginGrantStore(deps.database);
    this.grantStore = grantStore;
    const bindingStore = new PluginBindingStore(deps.database);
    this.bindingStore = bindingStore;
    const configStore = new PluginConfigStore(deps.database);
    this.configStore = configStore;
    const secretStore = new FileSecretStore({ filePath: deps.paths.pluginSecrets });
    this.secretStore = secretStore;
    // P0-2：来源目录（用户放置本地插件的目录）作为 local/openclaw/hermes 的搜索根
    const sourcesDir = path.join(deps.paths.home, "plugins", "sources");
    const adapters = [
      new LocalSourceAdapter({ baseDir: sourcesDir }),
      new ZipSourceAdapter(),
      new GitSourceAdapter(),
      new NpmSourceAdapter(),
      new OpenClawSourceAdapter({ baseDir: sourcesDir }),
      new HermesSourceAdapter({ baseDir: sourcesDir }),
    ];
    this.adapters = adapters;
    this.installer = new PluginInstaller({
      paths: deps.paths,
      adapters,
      hostVersion: deps.hostVersion,
      prepareEntry: (versionDir, normalized) => this.prepareRuntimeEntry(versionDir, normalized),
    });
    this.registry = new PluginRegistry({
      store: registryStore,
      installer: this.installer,
      paths: deps.paths,
      audit: deps.audit,
      grantStore,
      configStore,
      bindingStore,
    });
    this.grants = new GrantService({ store: grantStore, audit: deps.audit });
    this.bindings = new BindingService({ store: bindingStore, grants: grantStore, audit: deps.audit });
    // Phase 9 沙箱策略层接线：base policy（不含 sandboxCheck）供 SandboxBridge 委托，
    // 外层 policy 注入 sandboxCheck —— 避免 bridge→policy→sandboxCheck 无限递归；
    // 平台 PathGuard 未配置时插件文件操作 fail-closed 拒绝（SandboxBridge 语义）。
    const basePolicy = new EffectivePolicy({ grants: grantStore, bindings: bindingStore });
    const sandboxBridge = new SandboxBridge({ policy: basePolicy, pathGuard: null });
    this.policy = new EffectivePolicy({
      grants: grantStore,
      bindings: bindingStore,
      sandboxCheck: (input) => sandboxBridge.resolveCapability(input),
    });
    this.broker = new HostBroker({ policy: this.policy });
    const carriers = new CarrierRegistry();
    this.runtimeHost = new RuntimeHost({
      paths: deps.paths,
      registry: this.registry,
      broker: this.broker,
      carriers,
      ...(deps.nodePath !== undefined ? { nodePath: deps.nodePath } : {}),
      ...(deps.pythonInterpreter !== undefined ? { pythonInterpreter: deps.pythonInterpreter } : {}),
    });
    this.hostApi = new PluginHostApi({
      paths: deps.paths,
      registry: this.registry,
      runtimeHost: this.runtimeHost,
      broker: this.broker,
      policy: this.policy,
      configStore,
      secretStore,
      audit: deps.audit,
    });
    // P1：注册 HostBroker 白名单 API（config/secret/attachment/custom-activity），
    // worker 主动请求经 json-rpc → runtime-host 校验 carrier 后可达
    this.hostApi.registerHostBrokerApis();
    this.devHost = new PluginDevHost({
      paths: deps.paths,
      store: registryStore,
      audit: deps.audit,
      broker: this.broker,
      policy: this.policy,
      grants: this.grants,
      configStore,
      secretStore,
      hostVersion: deps.hostVersion,
      ...(deps.nodePath !== undefined ? { nodePath: deps.nodePath } : {}),
      ...(deps.pythonInterpreter !== undefined ? { pythonInterpreter: deps.pythonInterpreter } : {}),
      adapters,
    });
    this.devInvoke = new PluginDevInvokeService({ host: this.devHost });
    this.devScenario = new PluginDevScenarioService({ host: this.devHost, invoke: this.devInvoke });
  }

  invokeDevTool(input: PluginDevInvokeToolInput): Promise<unknown> {
    return this.devInvoke.invokeTool(input);
  }

  runDevScenario(input: PluginDevScenarioRunInput): Promise<unknown> {
    return this.devScenario.runScenario(input);
  }

  listDevSurfaces(): unknown {
    return this.devInvoke.listSurfaces();
  }

  // ── inspect / install（含生态包路径）──────────────────────────

  inspect(sourceRef: PluginSourceRef, actor: PluginOperationActor = WEB_ACTOR): PluginInspectResult {
    const prepared = this.prepareAny(sourceRef);
    return {
      pluginId: prepared.normalized.id,
      version: prepared.normalized.version,
      compatibility: prepared.compatibility,
      manifest: prepared.manifest,
      normalized: prepared.normalized,
      sourceRef: prepared.sourceRef,
      provenance: prepared.normalized.source.provenance ?? null,
      blocked: !prepared.compatibility.supported,
      blockedReasons: prepared.compatibility.blockedReasons,
    };
  }

  async install(
    sourceRef: PluginSourceRef,
    grants: readonly GrantChangeRequest[],
    actor: PluginOperationActor = WEB_ACTOR,
  ): Promise<PluginInstallResult> {
    const prepared = this.prepareAny(sourceRef);
    if (!prepared.compatibility.supported) {
      throw new Error(`插件不兼容：${prepared.compatibility.blockedReasons.join("；")}`);
    }
    // P0-6：授权对象与目标插件强绑定——grant.pluginId 必须等于安装插件 id，
    // 且能力必须在目标插件 Manifest 权限声明中（防止安装 A 时给 B 写授权/绕过声明层）
    const declaredCapabilities = new Set(prepared.normalized.permissions.map((permission) => permission.capability));
    for (const grant of grants) {
      if (grant.pluginId !== prepared.normalized.id) {
        throw new Error(`授权对象与安装插件不一致：${grant.pluginId} ≠ ${prepared.normalized.id}`);
      }
      if (!declaredCapabilities.has(grant.capability)) {
        throw new Error(`授权能力未在插件 Manifest 中声明：${grant.capability}`);
      }
    }
    // 评审修复（C2 原子性）：先安装（health check/ZIP 校验/already_installed 全部
    // 在安装事务内失败即回滚），成功后再落授权——授权随安装成功才生效（fail-closed）；
    // 授权阶段失败则回滚刚完成的安装，不留"未安装插件的授权残留"。
    const result = await this.registry.installNormalized(
      {
        normalized: prepared.normalized,
        compatibility: prepared.compatibility,
        verification: prepared.verification,
        sourceRef: prepared.sourceRef,
        contentRoot: prepared.contentRoot,
        stagingDir: prepared.stagingDir,
      },
      actor,
    );
    try {
      for (const grant of grants) {
        this.grants.change(grant, { actor: actor.actor });
      }
    } catch (error) {
      try {
        await this.registry.uninstall(result.pluginId, actor);
      } catch (rollbackError) {
        instrument.error(
          "plugin.install.grant_rollback_failed",
          "授权失败后回滚安装未能完成",
          { pluginId: result.pluginId, reason: rollbackError instanceof Error ? rollbackError.message : "unknown" },
        );
      }
      throw error;
    }
    return result;
  }

  async update(pluginId: string, sourceRef: PluginSourceRef, actor: PluginOperationActor = WEB_ACTOR): Promise<PluginInstallResult> {
    const active = this.registry.getActive(pluginId);
    const wasEnabled = active !== undefined && active.status === "enabled";
    if (wasEnabled) {
      try {
        await this.hostApi.deactivate(pluginId, "plugin_updated");
      } catch (error) {
        instrument.warn("plugin.deactivate.failed", "更新前停用旧版本运行时失败", { pluginId });
      }
    }
    const result = await this.registry.update(pluginId, sourceRef, actor);
    if (wasEnabled) {
      try {
        await this.hostApi.activate(pluginId);
      } catch (error) {
        // P1 更新补偿：新版本激活失败 → 回滚 active 到旧版本（旧版本目录仍在），
        // 避免"DB 显示新版本 enabled 但没有运行实例"的悬挂状态
        try {
          await this.registry.rollback(pluginId, actor);
        } catch (rollbackError) {
          instrument.warn("plugin.update.activate_rollback_failed", "更新激活失败后回滚旧版本未能完成", {
            pluginId,
            reason: rollbackError instanceof Error ? rollbackError.message : "unknown",
          });
        }
        throw error;
      }
    }
    return result;
  }

  async enable(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<void> {
    await this.registry.enable(pluginId, actor);
    try {
      await this.hostApi.activate(pluginId);
    } catch (error) {
      // 激活失败（登记/启动运行时失败）→ 回滚状态到 disabled（fail-closed）
      try {
        await this.registry.disable(pluginId, actor);
      } catch {
        /* 尽力回滚状态 */
      }
      throw error;
    }
  }

  async disable(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<void> {
    try {
      await this.hostApi.deactivate(pluginId, "plugin_disabled");
    } catch (error) {
      instrument.warn("plugin.deactivate.failed", "停用运行时失败，仍置为禁用", { pluginId });
    }
    await this.registry.disable(pluginId, actor);
  }

  async rollback(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<PluginInstallResult> {
    const active = this.registry.getActive(pluginId);
    const wasEnabled = active !== undefined && active.status === "enabled";
    if (wasEnabled) {
      try {
        await this.hostApi.deactivate(pluginId, "plugin_updated");
      } catch (error) {
        instrument.warn("plugin.deactivate.failed", "回滚前停用旧版本运行时失败", { pluginId });
      }
    }
    const result = await this.registry.rollback(pluginId, actor);
    if (wasEnabled) {
      await this.hostApi.activate(pluginId);
    }
    return result;
  }

  async uninstall(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<unknown> {
    try {
      await this.hostApi.deactivate(pluginId, "plugin_uninstalled");
    } catch (error) {
      instrument.warn("plugin.deactivate.failed", "卸载前停用运行时失败", { pluginId });
    }
    return this.registry.uninstall(pluginId, actor);
  }

  list(): PluginListItemView[] {
    return this.registryStore
      .listAll()
      .filter((record) => record.status !== "removed")
      .map((record) => this.toListItem(record));
  }
  get(pluginId: string) { return this.registry.getActive(pluginId); }

  /** 详情视图：安装信息 + 授权/绑定/Secret/Surface/运行时状态（Web 插件中心契约） */
  getDetail(pluginId: string): PluginDetailView | undefined {
    const record = this.registryStore.getActive(pluginId);
    if (record === undefined) {
      return undefined;
    }
    const status = this.runtimeHost.getStatus(pluginId);
    const instance = this.runtimeHost.getInstance(pluginId);
    const updateAvailable = this.resolveUpdateAvailable(record);
    return {
      ...this.toListItem(record),
      ...(updateAvailable !== undefined ? { updateAvailable } : {}),
      manifest: record.manifest ?? undefined,
      grants: this.grantStore.list(pluginId),
      agentBindings: this.bindingStore.listByPlugin(pluginId),
      secretStatus: this.hostApi.secrets.listSecretNames(pluginId),
      surfaces: this.hostApi.surfaces.listSurfaces().filter((surface) => surface.pluginId === pluginId),
      configValues: this.configStore.list(pluginId),
      runtime: {
        ...(instance?.kind !== undefined ? { kind: instance.kind } : {}),
        ...(instance?.runtimeInstanceId !== undefined ? { runtimeInstanceId: instance.runtimeInstanceId } : {}),
        ...(status !== undefined ? { status } : {}),
        health: this.runtimeHost.isHealthy(pluginId),
      },
    };
  }

  /**
   * P1：插件资产读取（Surface 资产路由）——版本目录内受控路径，
   * 防父目录穿越/空段/反斜杠/符号链接；Content-Type 按扩展名推断。
   */
  readPluginAsset(
    pluginId: string,
    assetPath: string,
  ): { ok: true; data: Buffer; contentType: string } | { ok: false; reason: string } {
    const record = this.registryStore.getActive(pluginId);
    if (record === undefined) {
      return { ok: false, reason: "插件未安装" };
    }
    if (assetPath.length === 0 || path.isAbsolute(assetPath) || assetPath.includes("\\")) {
      return { ok: false, reason: "资产路径必须相对且使用正斜杠" };
    }
    const segments = assetPath.split("/");
    if (segments.some((segment) => segment === ".." || segment === "")) {
      return { ok: false, reason: "资产路径不能包含父目录穿越或空段" };
    }
    const versionDir = pluginVersionDir(this.deps.paths, pluginId, record.version);
    let resolved: string;
    try {
      resolved = safeJoin(versionDir, ...segments);
      assertNotSymlinkOrJunction(resolved, "资产文件");
      if (!fs.statSync(resolved).isFile()) {
        return { ok: false, reason: "资产不是普通文件" };
      }
    } catch {
      return { ok: false, reason: "资产路径不在插件版本目录内" };
    }
    try {
      return { ok: true, data: fs.readFileSync(resolved), contentType: contentTypeForAsset(resolved) };
    } catch {
      return { ok: false, reason: "资产读取失败" };
    }
  }

  /** 来源搜索（Discover 视图；sourceType 过滤可空；单来源失败不阻断其余） */
  search(query: string, sourceType?: PluginSourceType): SourceSearchResult[] {    const adapters = sourceType === undefined
      ? this.adapters
      : this.adapters.filter((adapter) => adapter.sourceType === sourceType);
    const results: SourceSearchResult[] = [];
    for (const adapter of adapters) {
      try {
        results.push(...adapter.search(query));
      } catch (error) {
        instrument.warn("plugin.source.search_failed", "来源搜索失败", { sourceType: adapter.sourceType });
      }
    }
    return results;
  }

  /** dev 槽位 Surface 描述（CLI/Web dev 诊断） */
  describeDevSurface(pluginId: string, surfaceId: string): unknown {
    return this.devInvoke.describeSurface(pluginId, surfaceId);
  }

  bind(agentId: string, pluginId: string, contributions: readonly string[], actor: PluginOperationActor = WEB_ACTOR): void {
    this.bindings.bind({ agentId, pluginId, contributions: [...contributions] }, { actor: actor.actor });
  }
  unbind(agentId: string, pluginId: string, actor: PluginOperationActor = WEB_ACTOR): void {
    this.bindings.unbind(agentId, pluginId, { actor: actor.actor });
  }
  listAgentBindings(agentId: string): AgentPluginBinding[] { return this.bindings.listByAgent(agentId); }

  /** 启动插件运行时（绑定后激活贡献）——组合根启动时对 enabled 插件调用 */
  async activatePlugin(pluginId: string): Promise<void> {
    await this.hostApi.activate(pluginId);
  }

  /** 组合根启动：恢复中断操作（崩溃遗留 started 行终结为 failed） */
  recoverInterruptedOperations(actor: PluginOperationActor = WEB_ACTOR): void {
    this.registry.recoverOpenOperations(actor);
  }

  /**
   * 组合根启动：激活全部 enabled 插件（容错——单个失败不阻塞其余，记录 warn）。
   * 插件运行时在此真正启动（后台任务/Hook/contribution 登记/Runtime 进程）。
   */
  async activateAllEnabled(actor: PluginOperationActor = WEB_ACTOR): Promise<{ activated: string[]; failed: Array<{ pluginId: string; reason: string }> }> {
    const enabled = this.registryStore.listAll().filter((record) => record.status === "enabled");
    const activated: string[] = [];
    const failed: Array<{ pluginId: string; reason: string }> = [];
    for (const record of enabled) {
      try {
        await this.hostApi.activate(record.pluginId);
        activated.push(record.pluginId);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 300) : "激活失败";
        failed.push({ pluginId: record.pluginId, reason });
        instrument.warn("plugin.activate.failed", "启动时激活插件失败", { pluginId: record.pluginId });
      }
    }
    return { activated, failed };
  }

  async dispose(): Promise<void> {
    this.runtimeHost.stopAll();
    instrument.flush();
  }

  // ── 内部：常规或生态包准备 ─────────────────────────────────────

  /** 列表项视图：最小集 + manifest 富化（Web 插件中心契约） */
  private toListItem(record: PluginInstallationRecord): PluginListItemView {
    const manifest = (typeof record.manifest === "object" && record.manifest !== null ? record.manifest : {}) as Partial<ManifestV1>;
    const rollbackAvailable = this.registryStore
      .listVersions(record.pluginId)
      .some((item) => !item.active && item.status !== "removed");
    return {
      pluginId: record.pluginId,
      version: record.version,
      active: record.active,
      status: record.status,
      sourceType: record.sourceType,
      sourceRef: record.sourceRef,
      installedAt: record.installedAt,
      ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
      ...(manifest.trust !== undefined ? { trust: manifest.trust } : {}),
      ...(manifest.runtime?.kind !== undefined ? { runtimeKind: manifest.runtime.kind } : {}),
      enabled: record.status === "enabled",
      ...(rollbackAvailable ? { rollbackAvailable: true } : {}),
    };
  }

  /**
   * 更新可用性判定（P1）：尽力而为——来源适配器可解析到更高版本时 true；
   * 来源不可达/异常时 undefined（Web 端按钮不显示，不阻塞列表）。
   */
  private resolveUpdateAvailable(record: PluginInstallationRecord): boolean | undefined {
    try {
      const adapter = this.adapters.find((item) => item.sourceType === record.sourceType);
      if (adapter === undefined) {
        return undefined;
      }
      const versions = adapter.listVersions({
        sourceType: record.sourceType,
        ref: record.sourceRef,
        ...(record.sourceVersion !== null ? { version: record.sourceVersion } : {}),
      });
      const latest = [...versions].sort((a, b) => comparePluginVersions(b.version, a.version))[0];
      if (latest === undefined) {
        return undefined;
      }
      return comparePluginVersions(latest.version, record.version) > 0;
    } catch {
      return undefined;
    }
  }

  /** 运行时入口准备（评审 E1）：Hermes 生态包安装/更新时具体化 L5 worker。 */
  private prepareRuntimeEntry(versionDir: string, normalized: NormalizedPluginManifest): void {
    if (normalized.source.sourceRef.sourceType !== "hermes") {
      return;
    }
    let entry: string | undefined;
    try {
      entry = readHermesPluginDir(versionDir).entry;
    } catch {
      entry = undefined; // 兜底走 materialize 默认 __init__.py
    }
    materializeHermesWorker(versionDir, {
      name: normalized.name,
      version: normalized.version,
      ...(entry !== undefined ? { entry } : {}),
    });
  }

  private prepareAny(sourceRef: PluginSourceRef): PreparedPlugin {
    if (sourceRef.sourceType === "openclaw" || sourceRef.sourceType === "hermes") {
      return this.prepareEcosystem(sourceRef);
    }
    return this.installer.prepare(sourceRef);
  }

  private prepareEcosystem(sourceRef: PluginSourceRef): PreparedPlugin {
    const adapter = this.installer.adapterFor(sourceRef.sourceType);
    const artifact = adapter.fetchArtifact(sourceRef);
    const verification = adapter.verifyArtifact(artifact);
    const provenance = adapter.readProvenance(artifact);
    if (sourceRef.sourceType === "openclaw") {
      const manifestPath = path.join(artifact.contentRoot, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("OpenClaw 插件缺少 openclaw.plugin.json");
      }
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
      const converted = convertOpenClawPlugin({ manifest: raw, sourceRef, verification, provenance, hostVersion: this.deps.hostVersion });
      return this.buildPrepared(this.toProtocolNormalized(converted.normalized), this.toProtocolCompatibility(converted.compatibility), verification, sourceRef, artifact.contentRoot);
    }
    const descriptor = readHermesPluginDir(artifact.contentRoot);
    const converted = convertHermesPlugin({ descriptor, sourceRef, verification, provenance, hostVersion: this.deps.hostVersion });
    return this.buildPrepared(converted.normalized, converted.compatibility, verification, sourceRef, artifact.contentRoot);
  }

  /** 生态 Mirror → 协议 NormalizedPluginManifest（readonly/结构差异收敛） */
  private toProtocolNormalized(mirror: NormalizedPluginManifestMirror): NormalizedPluginManifest {
    return {
      id: mirror.id,
      name: mirror.name,
      version: mirror.version,
      ...(mirror.description !== undefined ? { description: mirror.description } : {}),
      ...(mirror.author !== undefined ? { author: { name: mirror.author.name, ...(mirror.author.email !== undefined ? { email: mirror.author.email } : {}), ...(mirror.author.url !== undefined ? { url: mirror.author.url } : {}) } } : {}),
      ...(mirror.license !== undefined ? { license: mirror.license } : {}),
      compatibility: { opencolorful: mirror.compatibility.opencolorful, pluginApi: mirror.compatibility.pluginApi },
      trust: mirror.trust,
      runtime: { kind: mirror.runtime.kind, ...(mirror.runtime.entry !== undefined ? { entry: mirror.runtime.entry } : {}) },
      permissions: mirror.permissions.map((permission) => ({ capability: permission.capability as NormalizedPluginManifest["permissions"][number]["capability"], ...(permission.reason !== undefined ? { reason: permission.reason } : {}) })),
      contributions: mirror.contributions,
      ...(mirror.config !== undefined ? { config: mirror.config } : {}),
      source: {
        sourceRef: mirror.source.sourceRef,
        verification: { sha256: mirror.source.verification.sha256, sizeBytes: mirror.source.verification.sizeBytes },
        ...(mirror.source.provenance !== undefined ? { provenance: mirror.source.provenance } : {}),
      },
      normalizedAt: mirror.normalizedAt,
    };
  }

  /** 生态兼容报告 Mirror → 协议 CompatibilityReport */
  private toProtocolCompatibility(mirror: CompatibilityReportMirror): CompatibilityReport {
    return {
      pluginId: mirror.pluginId,
      version: mirror.version,
      level: mirror.level,
      supported: mirror.supported,
      missingCapabilities: [...mirror.missingCapabilities],
      contributions: mirror.contributions.map((item) => ({ id: item.id, kind: item.kind, status: item.status, ...(item.reason !== undefined ? { reason: item.reason } : {}) })),
      blockedReasons: [...mirror.blockedReasons],
      requiresFullAccess: mirror.requiresFullAccess,
      ...(mirror.requiresRuntime !== undefined ? { requiresRuntime: mirror.requiresRuntime } : {}),
    };
  }

  private buildPrepared(
    normalized: NormalizedPluginManifest,
    compatibility: CompatibilityReport,
    verification: { sha256: string; sizeBytes: number },
    sourceRef: PluginSourceRef,
    contentRoot: string,
  ): PreparedPlugin {
    const stagingDir = path.join(this.paths.pluginsStaging, `ecosystem-${normalized.id}-${normalized.version}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    return {
      operationId: `plugin-install-${normalized.id}`,
      stagingDir,
      contentRoot,
      manifest: {
        manifestVersion: 1,
        id: normalized.id,
        name: normalized.name,
        version: normalized.version,
        ...(normalized.description !== undefined ? { description: normalized.description } : {}),
        ...(normalized.author !== undefined ? { author: normalized.author } : {}),
        ...(normalized.license !== undefined ? { license: normalized.license } : {}),
        compatibility: normalized.compatibility,
        trust: normalized.trust,
        runtime: normalized.runtime,
        permissions: normalized.permissions,
        contributions: normalized.contributions,
      },
      normalized,
      verification,
      compatibility,
      sourceRef,
      sourceType: sourceRef.sourceType,
    };
  }
}
