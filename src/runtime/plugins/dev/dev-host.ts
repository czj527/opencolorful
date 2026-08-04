// ═══════════════════════════════════════════════════════════════
// Phase 12 Dev Host（plans/phase-12.md §15 / §19.2）
//
// - dev install / reload / enable / disable / reset / uninstall；
// - 每次 install/reload 生成 devRunId；旧运行上下文（旧 devRunId）
//   不能操作新实例（invoke/scenario 携带 devRunId 校验）；
// - dev 安装写入独立 dev 目录（paths.pluginsDev/<pluginId>），不写正式
//   插件目录（plugins/installed）——本 Host 使用专用 dev 路径视图
//   （pluginsInstalled → pluginsDev）构建独立 dev 槽（Registry + RuntimeHost
//   + HostApi），与正式插件运行时栈隔离；
// - full-access 开发插件按 dev slot 或逐次授权：install fullAccess=true 时
//   授予全部能力（含高风险）；否则只授予 manifest 请求中的非高风险能力；
// - Dev Host 自动记录 plugin.dev.installed/reloaded/scenario_completed/
//   scenario_failed Activity；config/secret 变更走既有审计三阶段
//   （audit.plugin.config_change_* / secret_change_*，由 Config/Secret
//   contribution 承担）；
// - dev 状态（devRunId/sourceDir/授权）持久化在
//   plugins-dev/<pluginId>/.dev-state.json，重启后可恢复。
// ═══════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Value from "typebox/value";

import type { RuntimePaths } from "../../../config/paths.js";
import type { ActorRef, ExecutorRef } from "../../../contracts/observability.js";
import {
  CAPABILITY_KINDS,
  ManifestV1Schema,
  type CapabilityKind,
  type ManifestV1,
  type PluginSourceType,
  type PluginStatus,
} from "../../../contracts/plugin-protocol.js";
import type { AuditRecorder } from "../../../observability/audit-recorder.js";
import { instrument } from "../../../observability/instrument.js";
import type { PluginConfigStore } from "../../../storage/plugin-config-store.js";
import type { PluginRegistryStore } from "../../../storage/plugin-registry-store.js";
import type { PluginHostApi } from "../contributions/host-api.js";
import { PluginHostApi as PluginHostApiImpl } from "../contributions/host-api.js";
import type { PluginSecretStore } from "../contributions/secret-contribution.js";
import { isHighRisk } from "../grants/capability-catalog.js";
import type { GrantService } from "../grants/grant-service.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { HostBroker } from "../grants/host-broker.js";
import { PluginInstaller } from "../installer/plugin-installer.js";
import {
  canonicalPathSync,
  copyTreeSafe,
  PluginPathError,
  pluginVersionDir,
  safeJoin,
} from "../paths.js";
import type { PluginRegistry } from "../registry/plugin-registry.js";
import { PluginRegistry as PluginRegistryImpl } from "../registry/plugin-registry.js";
import { CarrierRegistry } from "../runtimes/carrier-registry.js";
import type { RuntimeHost } from "../runtimes/runtime-host.js";
import { RuntimeHost as RuntimeHostImpl } from "../runtimes/runtime-host.js";
import { computeArtifactHash, PluginSourceError, readManifestFile } from "../sources/source-adapter.js";
import type { PluginSourceAdapter } from "../sources/source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// 错误与公开类型
// ═══════════════════════════════════════════════════════════════

export class PluginDevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginDevError";
  }
}

export class PluginDevRunIdMismatchError extends PluginDevError {
  constructor(pluginId: string, expected: string, received: string | undefined) {
    super(
      `插件 ${pluginId} 的 devRunId 不匹配（旧运行上下文不能操作新实例；当前 ${expected.slice(0, 8)}…，收到 ${(received ?? "无").slice(0, 8)}…）`,
    );
    this.name = "PluginDevRunIdMismatchError";
  }
}

export class PluginDevNotFoundError extends PluginDevError {
  constructor(pluginId: string) {
    super(`开发插件未安装：${pluginId}（请先 plugins dev install）`);
    this.name = "PluginDevNotFoundError";
  }
}

export class PluginDevAlreadyInstalledError extends PluginDevError {
  constructor(pluginId: string) {
    super(`插件 ${pluginId} 已安装（正式目录或 dev 槽），请先卸载`);
    this.name = "PluginDevAlreadyInstalledError";
  }
}

export type PluginDevHealth = "unknown" | "ok" | "degraded" | "error";

/** 开发态插件状态（与 web/src/lib/plugin-types.ts PluginDevState 对齐）。 */
export interface PluginDevState {
  readonly pluginId: string;
  readonly devRunId: string;
  readonly status: PluginStatus;
  readonly sourceDir: string;
  readonly runtimeKind: string;
  readonly healthy: boolean;
  readonly lastError: string | null;
  readonly scenarios: readonly string[];
  readonly surfaces: readonly string[];
}

export interface PluginDiagnosticCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly message?: string;
}

export interface PluginRecentEvent {
  readonly recordedAt: string;
  readonly eventName: string;
  readonly status: string | null;
  readonly errorCode: string | null;
}

/** 开发态诊断（与 web/src/lib/plugin-types.ts PluginDiagnostics 对齐）。 */
export interface PluginDiagnostics {
  readonly pluginId: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly status: PluginStatus;
  readonly health: PluginDevHealth;
  readonly checks: readonly PluginDiagnosticCheck[];
  readonly lastError: string | null;
  readonly recentEvents: readonly PluginRecentEvent[];
}

/** dev 槽内部状态（内存 + .dev-state.json 持久化）。 */
export interface DevSlot {
  readonly pluginId: string;
  readonly version: string;
  readonly devRunId: string;
  readonly sourceDir: string;
  readonly fullAccess: boolean;
  readonly sourceType: PluginSourceType;
  readonly installedAt: string;
  status: PluginStatus;
  lastError?: string;
}

/** 诊断用活动事件源（由 Server 组合根注入；缺省无活动查询）。 */
export interface DevActivityEventRow {
  readonly recorded_at: string;
  readonly event_name: string;
  readonly status: string | null;
  readonly payload_json: string;
}

export interface PluginDevHostDeps {
  readonly paths: RuntimePaths;
  readonly store: PluginRegistryStore;
  readonly audit: AuditRecorder;
  readonly broker: HostBroker;
  readonly policy: EffectivePolicy;
  readonly grants: GrantService;
  readonly configStore: PluginConfigStore;
  readonly secretStore: PluginSecretStore;
  /** openColorful 版本（兼容范围判定）；缺省 "0.1.0" */
  readonly hostVersion?: string;
  readonly nodePath?: string;
  readonly pythonInterpreter?: string;
  readonly adapters?: readonly PluginSourceAdapter[];
  /** 活动事件查询（diagnostics 用；注入方负责安全摘要，不返回 Secret） */
  readonly queryActivityEvents?: (pluginId: string) => readonly DevActivityEventRow[];
  readonly now?: () => number;
}

export interface PluginDevInstallInput {
  /** 开发源码目录（本地绝对路径） */
  readonly sourceDir: string;
  /** full-access：显式授权全部能力（含高风险） */
  readonly fullAccess?: boolean;
  /** dev install 只支持本地源码目录 */
  readonly sourceType?: PluginSourceType;
  readonly actor?: ActorRef;
}

const DEFAULT_HOST_VERSION = "0.1.0";
const DEV_ACTOR: ActorRef = { kind: "user", id: "plugin-dev" };
const DEV_EXECUTOR: ExecutorRef = { kind: "service", id: "plugin-dev-host" };
const DEV_STATE_FILE = ".dev-state.json";

// ═══════════════════════════════════════════════════════════════

export class PluginDevHost {
  private readonly paths: RuntimePaths;
  private readonly store: PluginRegistryStore;
  private readonly audit: AuditRecorder;
  private readonly broker: HostBroker;
  private readonly policy: EffectivePolicy;
  private readonly grants: GrantService;
  private readonly configStore: PluginConfigStore;
  private readonly secretStore: PluginSecretStore;
  private readonly hostVersion: string;
  private readonly nodePath: string | undefined;
  private readonly pythonInterpreter: string | undefined;
  private readonly adapters: readonly PluginSourceAdapter[];
  private readonly queryActivityEvents: (pluginId: string) => readonly DevActivityEventRow[];
  private readonly now: () => number;
  private readonly slots = new Map<string, DevSlot>();
  private readonly carriers = new CarrierRegistry();
  /** destructive scenario 审批：pluginId\0devRunId\0scenarioName */
  private readonly destructiveApprovals = new Set<string>();

  // dev 槽独立栈（与正式插件运行时栈隔离）
  private devPaths: RuntimePaths | undefined;
  private devRegistry: PluginRegistry | undefined;
  private devRuntimeHost: RuntimeHost | undefined;
  private devHostApi: PluginHostApi | undefined;

  constructor(deps: PluginDevHostDeps) {
    this.paths = deps.paths;
    this.store = deps.store;
    this.audit = deps.audit;
    this.broker = deps.broker;
    this.policy = deps.policy;
    this.grants = deps.grants;
    this.configStore = deps.configStore;
    this.secretStore = deps.secretStore;
    this.hostVersion = deps.hostVersion ?? DEFAULT_HOST_VERSION;
    this.nodePath = deps.nodePath;
    this.pythonInterpreter = deps.pythonInterpreter;
    this.adapters = deps.adapters ?? [];
    this.queryActivityEvents = deps.queryActivityEvents ?? (() => []);
    this.now = deps.now ?? (() => Date.now());
  }

  /** 启动时恢复持久化 dev 槽（读取 plugins-dev 下各插件目录的 .dev-state.json）。 */
  init(): void {
    if (!fs.existsSync(this.paths.pluginsDev)) {
      return;
    }
    for (const entry of fs.readdirSync(this.paths.pluginsDev, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const statePath = path.join(this.paths.pluginsDev, entry.name, DEV_STATE_FILE);
      if (!fs.existsSync(statePath)) {
        continue;
      }
      try {
        const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
        const slot = this.parseDevSlot(raw);
        if (slot !== undefined) {
          this.slots.set(slot.pluginId, slot);
        }
      } catch {
        // 损坏的 dev 状态文件：忽略（下次 install 重建）
      }
    }
  }

  // ── dev 槽栈访问（dev-invoke / dev-scenario 复用） ────────────

  getDevHostApi(): PluginHostApi {
    this.ensureStack();
    return this.devHostApi as PluginHostApi;
  }

  getDevRuntimeHost(): RuntimeHost {
    this.ensureStack();
    return this.devRuntimeHost as RuntimeHost;
  }

  getDevRegistry(): PluginRegistry {
    this.ensureStack();
    return this.devRegistry as PluginRegistry;
  }

  getDevPaths(): RuntimePaths {
    this.ensureStack();
    return this.devPaths as RuntimePaths;
  }

  getSlot(pluginId: string): DevSlot | undefined {
    return this.slots.get(pluginId);
  }

  requireSlot(pluginId: string, devRunId: string | undefined): DevSlot {
    const slot = this.slots.get(pluginId);
    if (slot === undefined) {
      throw new PluginDevNotFoundError(pluginId);
    }
    if (devRunId !== slot.devRunId) {
      throw new PluginDevRunIdMismatchError(pluginId, slot.devRunId, devRunId);
    }
    return slot;
  }

  /** 确保插件已激活（contribution 登记 + Runtime 运行）；未启用/缺失则抛错。 */
  async ensureActivated(pluginId: string): Promise<void> {
    const slot = this.slots.get(pluginId);
    if (slot === undefined) {
      throw new PluginDevNotFoundError(pluginId);
    }
    if (slot.status !== "enabled") {
      throw new PluginDevError(`插件 ${pluginId} 未启用（status=${slot.status}），请先 dev enable`);
    }
    const host = this.getDevRuntimeHost();
    if (host.getStatus(pluginId) === "running") {
      return;
    }
    try {
      await this.getDevHostApi().activate(pluginId);
      slot.status = "enabled";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      slot.lastError = message.slice(0, 400);
      throw error;
    }
  }

  // ── install ───────────────────────────────────────────────────

  async install(input: PluginDevInstallInput): Promise<PluginDevState> {
    const sourceType = input.sourceType ?? "local";
    if (sourceType !== "local") {
      throw new PluginDevError(`dev install 只支持本地源码目录（sourceType=${sourceType}）`);
    }
    const sourceDir = this.validateSourceDir(input.sourceDir);
    const manifest = this.readManifest(sourceDir);
    const pluginId = manifest.id;
    const version = manifest.version;

    if (this.slots.has(pluginId)) {
      throw new PluginDevAlreadyInstalledError(pluginId);
    }
    const existing = this.store
      .listVersions(pluginId)
      .find((record) => record.status !== "removed");
    if (existing !== undefined) {
      throw new PluginDevAlreadyInstalledError(pluginId);
    }

    this.ensureStack();
    const devRunId = this.newDevRunId();
    const fullAccess = input.fullAccess === true;
    const actor = input.actor ?? DEV_ACTOR;

    // 1. 开发槽授权（full-access 逐次授权 / 非高风险自动授权）
    this.grantForDevInstall(pluginId, manifest, fullAccess, actor);

    // 2. 写入独立 dev 版本目录（不写正式插件目录）
    const contentRoot = this.resolveContentRoot(sourceDir, manifest.dev?.sourceDir);
    const versionDir = pluginVersionDir(this.devPaths as RuntimePaths, pluginId, version);
    assertPathWithinDevRoot(versionDir, this.paths.pluginsDev);
    fs.rmSync(versionDir, { recursive: true, force: true });
    copyTreeSafe(contentRoot, versionDir, { exclude: [".git", "node_modules"] });

    // 3. 注册安装记录（sourceType=local，sourceRef=dev 源码目录）
    const verification = computeArtifactHash(versionDir);
    this.store.saveInstallation({
      pluginId,
      version,
      active: true,
      status: "enabled",
      sourceType: "local",
      sourceRef: sourceDir,
      sourceVersion: null,
      artifactSha256: verification.sha256,
      artifactSize: verification.sizeBytes,
      provenance: { devRunId, sourceDir, devInstall: true },
      manifest,
      installedAt: new Date(this.now()).toISOString(),
    });
    this.store.setActive(pluginId, version);

    // 4. 激活（登记贡献 + 启动 dev Runtime）
    const slot: DevSlot = {
      pluginId,
      version,
      devRunId,
      sourceDir,
      fullAccess,
      sourceType: "local",
      installedAt: new Date(this.now()).toISOString(),
      status: "enabled",
    };
    try {
      await (this.devHostApi as PluginHostApi).activate(pluginId);
    } catch (error) {
      // 失败补偿：清空 store 记录与 dev 目录，恢复未安装状态
      const message = error instanceof Error ? error.message : String(error);
      this.store.markRemoved(pluginId);
      this.store.clearActive(pluginId);
      fs.rmSync(pluginInstalledRootOf(this.devPaths as RuntimePaths, pluginId), { recursive: true, force: true });
      throw new PluginDevError(`dev install 激活失败：${message.slice(0, 300)}`);
    }

    this.slots.set(pluginId, slot);
    this.persistSlot(slot);
    this.emitDevActivity("plugin.dev.installed", {
      pluginId,
      version,
      fullAccess,
      devRunId: slot.devRunId,
    });
    return this.toState(slot);
  }

  // ── reload ────────────────────────────────────────────────────

  async reload(pluginId: string, devRunId: string, actor?: ActorRef): Promise<PluginDevState> {
    const slot = this.requireSlot(pluginId, devRunId);
    this.ensureStack();
    const devPaths = this.devPaths as RuntimePaths;

    // 1. 停用旧实例（旧 contribution 立即不可调用）
    await (this.devHostApi as PluginHostApi).deactivate(pluginId, "plugin_updated");

    // 2. 重新读取源码并刷新 dev 版本目录
    const manifest = this.readManifest(slot.sourceDir);
    let version = slot.version;
    if (manifest.version !== version) {
      const oldDir = pluginVersionDir(devPaths, pluginId, version);
      fs.rmSync(oldDir, { recursive: true, force: true });
      version = manifest.version;
    }
    const contentRoot = this.resolveContentRoot(slot.sourceDir, manifest.dev?.sourceDir);
    const versionDir = pluginVersionDir(devPaths, pluginId, version);
    assertPathWithinDevRoot(versionDir, this.paths.pluginsDev);
    fs.rmSync(versionDir, { recursive: true, force: true });
    copyTreeSafe(contentRoot, versionDir, { exclude: [".git", "node_modules"] });

    // 3. 刷新安装记录（版本变化时重建 active 记录）
    const verification = computeArtifactHash(versionDir);
    const record = this.store.getInstallation(pluginId, version);
    if (record === undefined || record.status === "removed") {
      this.store.saveInstallation({
        pluginId,
        version,
        active: true,
        status: "enabled",
        sourceType: "local",
        sourceRef: slot.sourceDir,
        sourceVersion: null,
        artifactSha256: verification.sha256,
        artifactSize: verification.sizeBytes,
        provenance: { devRunId: slot.devRunId, sourceDir: slot.sourceDir, devInstall: true },
        manifest,
        installedAt: new Date(this.now()).toISOString(),
      });
      this.store.setActive(pluginId, version);
    } else {
      this.store.setStatus(pluginId, version, "enabled");
    }

    // 4. 新 devRunId + 重新激活
    const newSlot: DevSlot = {
      pluginId: slot.pluginId,
      version,
      devRunId: this.newDevRunId(),
      sourceDir: slot.sourceDir,
      fullAccess: slot.fullAccess,
      sourceType: slot.sourceType,
      installedAt: new Date(this.now()).toISOString(),
      status: "enabled",
    };
    try {
      await (this.devHostApi as PluginHostApi).activate(pluginId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PluginDevError(`dev reload 激活失败：${message.slice(0, 300)}`);
    }
    this.slots.set(pluginId, newSlot);
    this.persistSlot(newSlot);
    this.emitDevActivity("plugin.dev.reloaded", {
      pluginId,
      version: newSlot.version,
      fullAccess: newSlot.fullAccess,
      devRunId: newSlot.devRunId,
    });
    return this.toState(newSlot);
  }

  // ── enable / disable ──────────────────────────────────────────

  async enable(pluginId: string, devRunId: string, actor?: ActorRef): Promise<PluginDevState> {
    const slot = this.requireSlot(pluginId, devRunId);
    await this.getDevRegistry().enable(pluginId, { actor: actor ?? DEV_ACTOR });
    slot.status = "enabled";
    delete slot.lastError;
    await this.ensureActivated(pluginId);
    this.persistSlot(slot);
    return this.toState(slot);
  }

  async disable(pluginId: string, devRunId: string, actor?: ActorRef): Promise<PluginDevState> {
    const slot = this.requireSlot(pluginId, devRunId);
    await (this.getDevHostApi() as PluginHostApi).deactivate(pluginId, "plugin_disabled");
    await this.getDevRegistry().disable(pluginId, { actor: actor ?? DEV_ACTOR });
    slot.status = "disabled";
    this.persistSlot(slot);
    return this.toState(slot);
  }

  // ── reset / uninstall ─────────────────────────────────────────

  /** 重置：停用、移除 dev 目录与安装记录、清除 dev 状态（保留 Audit 事实）。 */
  async reset(pluginId: string, devRunId: string, actor?: ActorRef): Promise<{ status: string }> {
    const slot = this.requireSlot(pluginId, devRunId);
    await this.getDevRegistry().uninstall(pluginId, { actor: actor ?? DEV_ACTOR });
    this.slots.delete(pluginId);
    void slot;
    return { status: "reset" };
  }

  /** 卸载：停用、移除 dev 目录与安装记录、清除 dev 状态并撤销 dev 授权。 */
  async uninstall(
    pluginId: string,
    devRunId: string,
    actor?: ActorRef,
  ): Promise<{ pluginId: string; removedVersions: readonly string[] }> {
    const slot = this.requireSlot(pluginId, devRunId);
    const uninstallActor = actor ?? DEV_ACTOR;
    const result = await this.getDevRegistry().uninstall(pluginId, { actor: uninstallActor });
    // 卸载成功：撤销 dev 授权（授权表不随 dev 槽清理，显式回收；失败不阻断卸载）
    try {
      this.grants.removeAll(pluginId, { actor: uninstallActor });
    } catch (error) {
      instrument.warn("plugin.dev.uninstall_grant_cleanup_failed", "dev 卸载撤销授权失败", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.slots.delete(pluginId);
    void slot;
    return { pluginId, removedVersions: result.removedVersions };
  }

  // ── destructive scenario 审批 ────────────────────────────────

  /**
   * 显式批准 destructive scenario（逐场景逐 devRunId 授权）。
   * 审批通过 instrument.info 记录到 Trace/日志通道（事件目录未冻结专属
   * activity 事件，destructive 拒绝/通过由 run-scenario 的
   * scenario_completed/failed 终态活动承载）。
   */
  approveDestructive(pluginId: string, devRunId: string, scenarioName: string, actor?: ActorRef): void {
    const slot = this.requireSlot(pluginId, devRunId);
    const key = this.approvalKey(slot, scenarioName);
    this.destructiveApprovals.add(key);
    instrument.info("plugin.dev.destructive_approved", `destructive scenario 已批准：${pluginId}/${scenarioName}`, {
      pluginId,
      scenarioName,
      devRunId: slot.devRunId.slice(0, 8),
      actor: (actor ?? DEV_ACTOR).id,
    });
  }

  /** 检查 destructive scenario 是否已获批准（当前 devRunId 上下文）。 */
  hasDestructiveApproval(pluginId: string, devRunId: string, scenarioName: string): boolean {
    const slot = this.requireSlot(pluginId, devRunId);
    return this.destructiveApprovals.has(this.approvalKey(slot, scenarioName));
  }

  private approvalKey(slot: DevSlot, scenarioName: string): string {
    return `${slot.pluginId}\u0000${slot.devRunId}\u0000${scenarioName}`;
  }

  // ── 查询 ──────────────────────────────────────────────────────

  list(): PluginDevState[] {
    return [...this.slots.values()].map((slot) => this.toState(slot));
  }

  getState(pluginId: string): PluginDevState {
    const slot = this.slots.get(pluginId);
    if (slot === undefined) {
      throw new PluginDevNotFoundError(pluginId);
    }
    return this.toState(slot);
  }

  async diagnostics(pluginId: string): Promise<PluginDiagnostics> {
    const slot = this.slots.get(pluginId);
    if (slot === undefined) {
      throw new PluginDevNotFoundError(pluginId);
    }
    const checks: PluginDiagnosticCheck[] = [];
    const push = (id: string, label: string, ok: boolean, message?: string): void => {
      checks.push({
        id,
        label,
        ok,
        ...(message !== undefined ? { message } : {}),
      });
    };

    push("source-dir", "源码目录存在", fs.existsSync(slot.sourceDir), fs.existsSync(slot.sourceDir) ? undefined : slot.sourceDir);
    const versionDir = pluginVersionDir(this.getDevPaths(), pluginId, slot.version);
    push("dev-runtime-copy", "dev 运行时副本存在", fs.existsSync(versionDir));
    let manifestOk = false;
    try {
      const raw = this.readManifest(versionDir);
      manifestOk = raw.id === pluginId;
      push("manifest", "manifest 合法且 id 一致", manifestOk);
    } catch (error) {
      push("manifest", "manifest 合法且 id 一致", false, error instanceof Error ? error.message.slice(0, 200) : undefined);
    }
    const storeActive = this.store.getActive(pluginId);
    push("installation", "安装记录与 active 指针一致", storeActive !== undefined && storeActive.version === slot.version);

    let healthy = false;
    let lastError: string | null = slot.lastError ?? null;
    try {
      healthy = this.getDevRuntimeHost().isHealthy(pluginId);
      push("runtime", "dev 运行时健康", healthy);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      push("runtime", "dev 运行时健康", false, message.slice(0, 200));
      lastError = message.slice(0, 400);
    }
    if (manifestOk) {
      const scenarios = this.listScenarioNames(slot);
      push("scenarios", "dev 场景文件", scenarios.length > 0, scenarios.length > 0 ? undefined : "dev/scenarios 目录为空或不存在");
    }

    const health: PluginDevHealth =
      !manifestOk || this.store.getActive(pluginId) === undefined
        ? "error"
        : healthy
          ? "ok"
          : slot.status === "disabled"
            ? "unknown"
            : "degraded";

    return {
      pluginId,
      version: slot.version,
      generatedAt: new Date(this.now()).toISOString(),
      status: slot.status,
      health,
      checks,
      lastError,
      recentEvents: this.collectRecentEvents(pluginId),
    };
  }

  // ── 内部：dev 槽栈 ────────────────────────────────────────────

  private ensureStack(): void {
    if (this.devHostApi !== undefined) {
      return;
    }
    const devPaths: RuntimePaths = { ...this.paths, pluginsInstalled: this.paths.pluginsDev };
    this.devPaths = devPaths;
    const installer = new PluginInstaller({ paths: devPaths, adapters: this.adapters, hostVersion: this.hostVersion });
    const registry = new PluginRegistryImpl({ store: this.store, installer, paths: devPaths, audit: this.audit });
    const runtimeHost = new RuntimeHostImpl({
      paths: devPaths,
      registry,
      broker: this.broker,
      carriers: this.carriers,
      ...(this.nodePath !== undefined ? { nodePath: this.nodePath } : {}),
      ...(this.pythonInterpreter !== undefined ? { pythonInterpreter: this.pythonInterpreter } : {}),
    });
    const hostApi = new PluginHostApiImpl({
      paths: devPaths,
      registry,
      runtimeHost,
      broker: this.broker,
      policy: this.policy,
      configStore: this.configStore,
      secretStore: this.secretStore,
      audit: this.audit,
    });
    this.devRegistry = registry;
    this.devRuntimeHost = runtimeHost;
    this.devHostApi = hostApi;
    // 注意：不重复注册 Host Broker API（共享 broker 已由正式 HostApi 注册，
    // 重复注册会抛错）；dev 插件的领域执行不依赖 broker 白名单 API。
  }

  // ── 内部：dev 槽持久化 ────────────────────────────────────────

  private persistSlot(slot: DevSlot): void {
    const dir = path.join(this.paths.pluginsDev, slot.pluginId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, DEV_STATE_FILE),
      `${JSON.stringify(
        {
          pluginId: slot.pluginId,
          version: slot.version,
          devRunId: slot.devRunId,
          sourceDir: slot.sourceDir,
          fullAccess: slot.fullAccess,
          sourceType: slot.sourceType,
          installedAt: slot.installedAt,
          status: slot.status,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  private parseDevSlot(raw: unknown): DevSlot | undefined {
    if (typeof raw !== "object" || raw === null) {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    const pluginId = record["pluginId"];
    const version = record["version"];
    const devRunId = record["devRunId"];
    const sourceDir = record["sourceDir"];
    if (
      typeof pluginId !== "string" ||
      typeof version !== "string" ||
      typeof devRunId !== "string" ||
      typeof sourceDir !== "string"
    ) {
      return undefined;
    }
    return {
      pluginId,
      version,
      devRunId,
      sourceDir,
      fullAccess: record["fullAccess"] === true,
      sourceType: record["sourceType"] === "local" ? "local" : "local",
      installedAt: typeof record["installedAt"] === "string" ? record["installedAt"] : new Date(0).toISOString(),
      status: record["status"] === "disabled" ? "disabled" : "enabled",
    };
  }

  // ── 内部：授权 ────────────────────────────────────────────────

  private grantForDevInstall(pluginId: string, manifest: ManifestV1, fullAccess: boolean, actor: ActorRef): void {
    const requested = new Set(manifest.permissions.map((request) => request.capability));
    const grantActor = { actor, allowSystemForHighRisk: true };
    for (const capability of CAPABILITY_KINDS) {
      const grant = fullAccess || (requested.has(capability) && !isHighRisk(capability as CapabilityKind));
      if (grant) {
        this.grants.grant({ pluginId, capability: capability as CapabilityKind, reason: "dev install 授权" }, grantActor);
      }
    }
  }

  // ── 内部：工具 ────────────────────────────────────────────────

  private validateSourceDir(sourceDir: string): string {
    if (typeof sourceDir !== "string" || sourceDir.trim() === "") {
      throw new PluginDevError("sourceDir 必须是非空路径");
    }
    const resolved = canonicalPathSync(sourceDir);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new PluginDevError(`开发源码目录不存在：${resolved}`);
    }
    if (stat.isSymbolicLink()) {
      throw new PluginDevError("开发源码目录不允许是符号链接或 Junction");
    }
    if (!stat.isDirectory()) {
      throw new PluginDevError(`开发源码目录不是目录：${resolved}`);
    }
    return resolved;
  }

  private readManifest(root: string): ManifestV1 {
    let raw: unknown;
    try {
      raw = readManifestFile(root);
    } catch (error) {
      if (error instanceof PluginSourceError) {
        throw new PluginDevError(`开发源码目录缺少合法 manifest.json：${error.message.slice(0, 200)}`);
      }
      throw error;
    }
    if (!Value.Check(ManifestV1Schema, raw)) {
      throw new PluginDevError("开发源码 manifest 不符合 v1 契约（未知字段或字段非法）");
    }
    return raw as ManifestV1;
  }

  /** manifest.dev.sourceDir 声明子目录时复制该子目录（相对源码根）。 */
  private resolveContentRoot(sourceDir: string, devSourceDir: string | undefined): string {
    if (devSourceDir === undefined || devSourceDir === "" || devSourceDir === ".") {
      return sourceDir;
    }
    const segments = devSourceDir.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (segments.some((segment) => segment === "..")) {
      throw new PluginDevError("manifest.dev.sourceDir 不能包含父目录穿越");
    }
    const candidate = safeJoin(sourceDir, ...segments);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      throw new PluginDevError(`manifest.dev.sourceDir 声明的源码子目录不存在：${devSourceDir}`);
    }
    return candidate;
  }

  private newDevRunId(): string {
    return `dev-${crypto.randomUUID()}`;
  }

  private toState(slot: DevSlot): PluginDevState {
    const runtimeKind = this.readRuntimeKind(slot);
    const healthy = slot.status === "enabled" && this.safeIsHealthy(slot.pluginId);
    return {
      pluginId: slot.pluginId,
      devRunId: slot.devRunId,
      status: slot.status,
      sourceDir: slot.sourceDir,
      runtimeKind,
      healthy,
      lastError: slot.lastError ?? null,
      scenarios: this.listScenarioNames(slot),
      surfaces: this.listSurfaceIds(slot),
    };
  }

  private safeIsHealthy(pluginId: string): boolean {
    try {
      return this.devRuntimeHost !== undefined && this.devRuntimeHost.isHealthy(pluginId);
    } catch {
      return false;
    }
  }

  private readRuntimeKind(slot: DevSlot): string {
    try {
      const raw = readManifestFile(pluginVersionDir(this.getDevPaths(), slot.pluginId, slot.version)) as
        | { runtime?: { kind?: string } }
        | null;
      return raw?.runtime?.kind ?? "bundle";
    } catch {
      return "bundle";
    }
  }

  private listScenarioNames(slot: DevSlot): string[] {
    try {
      const scenariosDir = path.join(pluginVersionDir(this.getDevPaths(), slot.pluginId, slot.version), "dev", "scenarios");
      if (!fs.existsSync(scenariosDir)) {
        return [];
      }
      return fs
        .readdirSync(scenariosDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .sort();
    } catch {
      return [];
    }
  }

  private listSurfaceIds(slot: DevSlot): string[] {
    try {
      const raw = readManifestFile(pluginVersionDir(this.getDevPaths(), slot.pluginId, slot.version)) as unknown;
      if (typeof raw !== "object" || raw === null) {
        return [];
      }
      const contributions = (raw as Record<string, unknown>)["contributions"] as Record<string, unknown> | undefined;
      const ids: string[] = [];
      for (const kind of ["page", "widget", "chat-surface"] as const) {
        const list = contributions?.[kind];
        if (!Array.isArray(list)) {
          continue;
        }
        for (const item of list) {
          if (typeof item === "object" && item !== null) {
            const id = (item as Record<string, unknown>)["id"];
            if (typeof id === "string") {
              ids.push(id);
            }
          }
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  private collectRecentEvents(pluginId: string): PluginRecentEvent[] {
    return this.queryActivityEvents(pluginId).map((row) => {
      let errorCode: string | null = null;
      try {
        const payload = JSON.parse(row.payload_json) as { attributes?: Record<string, unknown> };
        const code = payload.attributes?.["errorCode"];
        if (typeof code === "string") {
          errorCode = code;
        }
      } catch {
        // ignore
      }
      return {
        recordedAt: row.recorded_at,
        eventName: row.event_name,
        status: row.status,
        errorCode,
      };
    });
  }

  private emitDevActivity(
    eventName: "plugin.dev.installed" | "plugin.dev.reloaded",
    attributes: Record<string, string | boolean>,
  ): void {
    instrument.activity({
      eventName,
      actor: DEV_ACTOR,
      executor: DEV_EXECUTOR,
      target: { kind: "plugin", id: String(attributes["pluginId"]) },
      scope: { pluginId: String(attributes["pluginId"]) },
      payload: {
        summaryCode: eventName.replace(/\./g, "_"),
        attributes,
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// 模块级辅助
// ═══════════════════════════════════════════════════════════════

function assertPathWithinDevRoot(candidate: string, devRoot: string): void {
  const relative = path.relative(path.resolve(devRoot), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PluginPathError(`dev 安装路径不在 dev 目录内，已拒绝：${candidate}`);
  }
}

function pluginInstalledRootOf(paths: RuntimePaths, pluginId: string): string {
  return path.join(paths.pluginsInstalled, pluginId);
}
