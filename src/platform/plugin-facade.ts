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
} from "../contracts/plugin-protocol.js";
import type { AuditRecorder } from "../observability/audit-recorder.js";
import { instrument } from "../observability/instrument.js";
import { PluginRegistry, type PluginInstallResult } from "../runtime/plugins/registry/plugin-registry.js";
import { PluginInstaller, type PreparedPlugin } from "../runtime/plugins/installer/plugin-installer.js";
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
import { CarrierRegistry } from "../runtime/plugins/runtimes/carrier-registry.js";
import { RuntimeHost } from "../runtime/plugins/runtimes/runtime-host.js";
import { PluginHostApi } from "../runtime/plugins/contributions/host-api.js";
import { InMemorySecretStore } from "../runtime/plugins/contributions/secret-contribution.js";
import { PluginDevHost } from "../runtime/plugins/dev/dev-host.js";
import { PluginDevInvokeService, type PluginDevInvokeToolInput } from "../runtime/plugins/dev/dev-invoke.js";
import { PluginDevScenarioService, type PluginDevScenarioRunInput } from "../runtime/plugins/dev/dev-scenario.js";
import { convertOpenClawPlugin, type CompatibilityReportMirror, type NormalizedPluginManifestMirror } from "../runtime/plugins/compat/openclaw-compat.js";
import { convertHermesPlugin, readHermesPluginDir } from "../runtime/plugins/compat/hermes-compat.js";
import { pluginDataDir } from "../runtime/plugins/paths.js";

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

const WEB_ACTOR: PluginOperationActor = {
  actor: { kind: "user", id: "web" },
  executor: { kind: "service", id: "plugin-facade" },
};

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
  private readonly paths: RuntimePaths;

  constructor(private readonly deps: PluginFacadeDeps) {
    this.paths = deps.paths;
    const registryStore = new PluginRegistryStore(deps.database);
    this.registryStore = registryStore;
    const grantStore = new PluginGrantStore(deps.database);
    const bindingStore = new PluginBindingStore(deps.database);
    const configStore = new PluginConfigStore(deps.database);
    const secretStore = new InMemorySecretStore();
    const adapters = [
      new LocalSourceAdapter(),
      new ZipSourceAdapter(),
      new GitSourceAdapter(),
      new NpmSourceAdapter(),
      new OpenClawSourceAdapter(),
      new HermesSourceAdapter(),
    ];
    this.installer = new PluginInstaller({ paths: deps.paths, adapters, hostVersion: deps.hostVersion });
    this.registry = new PluginRegistry({ store: registryStore, installer: this.installer, paths: deps.paths, audit: deps.audit });
    this.grants = new GrantService({ store: grantStore, audit: deps.audit });
    this.bindings = new BindingService({ store: bindingStore, grants: grantStore, audit: deps.audit });
    this.policy = new EffectivePolicy({ grants: grantStore, bindings: bindingStore });
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
    // 按 inspect 结果落授权（fail-closed：任一 grant 拒绝则整体拒绝）
    for (const grant of grants) {
      this.grants.change(grant, { actor: actor.actor });
    }
    return this.registry.installNormalized(
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
  }

  async update(pluginId: string, sourceRef: PluginSourceRef, actor: PluginOperationActor = WEB_ACTOR): Promise<PluginInstallResult> {
    return this.registry.update(pluginId, sourceRef, actor);
  }

  enable(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<void> { return this.registry.enable(pluginId, actor); }
  disable(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<void> { return this.registry.disable(pluginId, actor); }
  rollback(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<PluginInstallResult> { return this.registry.rollback(pluginId, actor); }
  uninstall(pluginId: string, actor: PluginOperationActor = WEB_ACTOR): Promise<unknown> { return this.registry.uninstall(pluginId, actor); }

  list() { return this.registryStore.listAll(); }
  get(pluginId: string) { return this.registry.getActive(pluginId); }

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

  async dispose(): Promise<void> {
    this.runtimeHost.stopAll();
    instrument.flush();
  }

  // ── 内部：常规或生态包准备 ─────────────────────────────────────

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
