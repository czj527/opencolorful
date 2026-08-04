import fs from "node:fs";

import type { RuntimePaths } from "../../../config/paths.js";
import type { ActorRef, ExecutorRef, TraceContext } from "../../../contracts/observability.js";
import type { ArtifactVerification, CompatibilityReport, ManifestV1, NormalizedPluginManifest, PluginStatus } from "../../../contracts/plugin-protocol.js";
import { assertDurableAudit, type AuditRecorder, type AuditRecordInput } from "../../../observability/audit-recorder.js";
import { instrument } from "../../../observability/instrument.js";
import type {
  PluginInstallationRecord,
  PluginOperationRecord,
  PluginRegistryStore,
} from "../../../storage/plugin-registry-store.js";
import type { PluginBindingStore } from "../../../storage/plugin-binding-store.js";
import type { PluginConfigStore } from "../../../storage/plugin-config-store.js";
import type { PluginGrantStore } from "../../../storage/plugin-grant-store.js";
import {
  buildCompatibilityReport,
  comparePluginVersions,
  PluginInstallError,
  type PluginInstaller,
  type PreparedPlugin,
} from "../installer/plugin-installer.js";
import { pluginDataDir, pluginInstalledRoot, pluginVersionDir } from "../paths.js";
import { assertPluginSourceRef, type NormalizedSource, type PluginSourceRef } from "../sources/source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// 本地镜像类型（TypeBox 1.3.6 Static 缺陷 workaround）：与冻结的
// PluginInstallationSchema 运行时形状一致，仅供内部类型标注。
// ═══════════════════════════════════════════════════════════════

export interface PluginInstallation {
  readonly pluginId: string;
  readonly version: string;
  readonly active: boolean;
  readonly status: string;
  readonly source: NormalizedSource;
  readonly installedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// Phase 12 Plugin Registry（plans/phase-12.md §7.3 / §13 / §17.3）
//
// - plugin_installations 是安装/active version/启用状态事实来源；
// - 同一 pluginId 的 install/update/rollback/uninstall 必须串行：
//   进程内 per-plugin promise 队列 + plugin_operations 表 started 检测
//   （跨进程/中断恢复的冲突防线）；
// - 安装 Artifact 用不可变版本目录（plugins/installed/<id>/<version>），
//   active 由 SQLite active 列原子切换，更新失败保留旧版本并回滚；
// - 严格审计生命周期（install/update/rollback/uninstall）：
//   audit.plugin.*_started → 领域写入 → audit.plugin.*_completed / *_failed；
//   audit 未配置/rejected → fail-closed；completed 失败 → 补偿恢复旧状态；
// - activity 事件（plugin.installed / plugin.updated / plugin.rollback.* /
//   plugin.uninstalled / plugin.enabled / plugin.disabled）只带安全摘要。
// ═══════════════════════════════════════════════════════════════

export class PluginConflictError extends Error {
  constructor(pluginId: string) {
    super(`插件 ${pluginId} 已有进行中的操作，请稍后重试`);
    this.name = "PluginConflictError";
  }
}

export class PluginNotFoundError extends Error {
  constructor(pluginId: string) {
    super(`插件未安装：${pluginId}`);
    this.name = "PluginNotFoundError";
  }
}

export class PluginRollbackUnavailableError extends Error {
  constructor(pluginId: string) {
    super(`插件没有可回滚的历史版本：${pluginId}`);
    this.name = "PluginRollbackUnavailableError";
  }
}

export interface PluginOperationActor {
  readonly actor: ActorRef;
  readonly executor?: ExecutorRef;
}

export interface PluginInstallResult {
  readonly pluginId: string;
  readonly version: string;
  readonly compatibility: CompatibilityReport;
}

export interface PluginUninstallResult {
  readonly pluginId: string;
  readonly removedVersions: readonly string[];
}

export interface PluginRegistryDeps {
  readonly store: PluginRegistryStore;
  readonly installer: PluginInstaller;
  readonly paths: RuntimePaths;
  readonly audit: AuditRecorder;
  /** 卸载清理用（可选）：移除插件残留授权/配置/绑定。 */
  readonly grantStore?: PluginGrantStore;
  readonly configStore?: PluginConfigStore;
  readonly bindingStore?: PluginBindingStore;
}

const DEFAULT_EXECUTOR: ExecutorRef = { kind: "service", id: "plugin-registry" };

export class PluginRegistry {
  /** per-plugin 操作串行化：promise 队列（同一 pluginId 顺序执行）。 */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: PluginRegistryDeps) {}

  // ── 查询 ─────────────────────────────────────────────────────

  getInstallation(pluginId: string, version?: string): PluginInstallation | undefined {
    if (version !== undefined) {
      return this.toInstallation(this.deps.store.getInstallation(pluginId, version));
    }
    const versions = this.deps.store.listVersions(pluginId);
    return versions.length === 0 ? undefined : this.toInstallation(versions[versions.length - 1] as PluginInstallationRecord);
  }

  listVersions(pluginId: string): PluginInstallation[] {
    return this.deps.store.listVersions(pluginId).map((record) => this.toInstallation(record) as PluginInstallation);
  }

  getActive(pluginId: string): PluginInstallation | undefined {
    return this.toInstallation(this.deps.store.getActive(pluginId));
  }

  getActiveStatus(pluginId: string): PluginStatus | undefined {
    return this.deps.store.getActive(pluginId)?.status;
  }

  listInstalled(): PluginInstallation[] {
    return this.deps.store
      .listInstalled()
      .filter((record) => record.status !== "removed")
      .map((record) => this.toInstallation(record) as PluginInstallation);
  }

  listOpenOperations() {
    return this.deps.store.findOpenOperations();
  }

  /**
   * 中断恢复：把启动时遗留的 started 操作终结为 failed（fail-closed）——
   * 写失败终态严格审计（audit.plugin.operation_recovered，decision=denied）后
   * 标记操作终态，并释放 per-plugin 锁（后续 install/update 可正常进入）。
   * 单条失败不阻断其余；失败记 instrument.warn。
   */
  recoverOpenOperations(actor: PluginOperationActor): void {
    for (const operation of this.deps.store.findOpenOperations()) {
      try {
        this.writeRecoveryAudit(operation, actor);
        this.deps.store.finishOperation(operation.operationId, "failed", { reasonCode: "interrupted" });
        this.emitRecoveryActivity(operation, actor);
      } catch (error) {
        instrument.warn("plugin.operation.recovery_failed", "中断插件操作恢复失败", {
          pluginId: operation.pluginId,
          operationId: operation.operationId,
          operation: operation.operation,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ── 安装/更新/回滚/卸载/启停（状态机） ──────────────────────

  /** 安装：准备阶段（锁外）→ 锁内事务提交 + active 切换。 */
  async install(sourceRef: PluginSourceRef, actor: PluginOperationActor): Promise<PluginInstallResult> {
    const ref = assertPluginSourceRef(sourceRef);
    const prepared = this.deps.installer.prepare(ref);
    const pluginId = prepared.normalized.id;
    return this.runExclusive(pluginId, () => this.installLocked(prepared, actor));
  }

  /**
   * 评审 T10：外部生态包（OpenClaw/Hermes）安装路径——来源已由 Source Adapter
   * fetch + 生态 convert 得到 normalized/compatibility，这里直接进入锁内事务，
   * 复用 installLocked 的审计/补偿/active 切换（不再走 manifest.json 校验路径）。
   */
  async installNormalized(
    input: {
      readonly normalized: NormalizedPluginManifest;
      readonly compatibility: CompatibilityReport;
      readonly verification: ArtifactVerification;
      readonly sourceRef: PluginSourceRef;
      readonly contentRoot: string;
      readonly stagingDir: string;
    },
    actor: PluginOperationActor,
  ): Promise<PluginInstallResult> {
    const prepared: PreparedPlugin = {
      operationId: this.deps.installer.createOperationId("install"),
      stagingDir: input.stagingDir,
      contentRoot: input.contentRoot,
      manifest: this.toManifestV1(input.normalized),
      normalized: input.normalized,
      verification: input.verification,
      // 生态 convert 可能产生 readonly 数组：结构化拷贝为可变 CompatibilityReport
      compatibility: {
        ...input.compatibility,
        missingCapabilities: [...input.compatibility.missingCapabilities],
        contributions: input.compatibility.contributions.map((item) => ({ ...item })),
        blockedReasons: [...input.compatibility.blockedReasons],
      },
      sourceRef: input.sourceRef,
      sourceType: input.sourceRef.sourceType,
    };
    return this.runExclusive(input.normalized.id, () => this.installLocked(prepared, actor));
  }

  /** 生态 normalized → ManifestV1 投影（manifest 字段由 normalized 推导，供 buildRecord 使用） */
  private toManifestV1(normalized: NormalizedPluginManifest): ManifestV1 {
    return {
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
    };
  }

  async update(
    pluginId: string,
    sourceRef: PluginSourceRef,
    actor: PluginOperationActor,
  ): Promise<PluginInstallResult> {
    return this.runExclusive(pluginId, async () => {
      const active = this.deps.store.getActive(pluginId);
      if (active === undefined || active.status === "removed") {
        throw new PluginNotFoundError(pluginId);
      }
      const prepared = this.deps.installer.prepare(sourceRef);
      if (prepared.normalized.id !== pluginId) {
        throw new PluginInstallError("plugin_id_mismatch", "来源插件的 id 与目标插件不一致");
      }
      const newVersion = prepared.normalized.version;
      if (comparePluginVersions(newVersion, active.version) <= 0) {
        throw new PluginInstallError("version_not_greater", "更新版本必须高于当前 active 版本");
      }
      this.assertNoOpenOperation(pluginId);
      const operationId = this.deps.installer.createOperationId("update");
      const trace = this.buildTrace(operationId);
      const executor = actor.executor ?? DEFAULT_EXECUTOR;
      assertDurableAudit(
        this.deps.audit.appendStrict(
          this.auditInput({
            eventName: "audit.plugin.update_started",
            action: "plugin.update",
            decision: "allowed",
            pluginId,
            trace,
            actor: actor.actor,
            executor,
          }),
        ),
        "插件更新审计启动",
      );
      this.deps.store.startOperation({
        operationId,
        pluginId,
        operation: "update",
        fromVersion: active.version,
        toVersion: newVersion,
      });

      let versionDir = "";
      let copied = false;
      try {
        versionDir = this.deps.installer.copyIntoVersionDir(prepared, pluginId, newVersion);
        copied = true;
        // 运行时入口准备（Hermes 等平台 worker 具体化）后再做健康检查
        this.deps.installer.prepareRuntimeEntry(versionDir, prepared.normalized);
        const health = this.deps.installer.healthCheck(versionDir, prepared.normalized);
        if (!health.ok) {
          throw new PluginInstallError("health_check_failed", `新版本健康检查失败：${health.reason ?? ""}`);
        }
        const record: PluginInstallationRecord = this.buildRecord(prepared, pluginId, newVersion, active.status);
        // 同库事务：新版本安装行 + active 原子切换 + 操作完成 + completed 审计
        this.deps.audit.runAuditedTransaction(
          this.auditInput({
            eventName: "audit.plugin.update_completed",
            action: "plugin.update",
            decision: "allowed",
            pluginId,
            trace,
            actor: actor.actor,
            executor,
            changedFields: ["activeVersion"],
          }),
          () => {
            this.deps.store.saveInstallation(record);
            this.deps.store.setActive(pluginId, newVersion);
            this.deps.store.finishOperation(operationId, "completed");
          },
        );
        instrument.activity({
          eventName: "plugin.updated",
          actor: actor.actor,
          executor,
          target: { kind: "plugin", id: pluginId },
          scope: { pluginId },
          payload: {
            summaryCode: "plugin_updated",
            attributes: this.summaryAttributes(prepared, pluginId, newVersion),
          },
        });
        return { pluginId, version: newVersion, compatibility: prepared.compatibility };
      } catch (error) {
        const { compensated, reasonCode } = this.compensate(versionDir, copied, error, "update_failed");
        this.writeTerminalAudit("audit.plugin.update_failed", "plugin.update", pluginId, trace, actor.actor, executor, reasonCode);
        this.finishOperationBestEffort(operationId, compensated, reasonCode);
        throw error;
      }
    });
  }

  async rollback(pluginId: string, actor: PluginOperationActor): Promise<PluginInstallResult> {
    return this.runExclusive(pluginId, async () => {
      const active = this.deps.store.getActive(pluginId);
      if (active === undefined || active.status === "removed") {
        throw new PluginNotFoundError(pluginId);
      }
      const candidates = this.deps.store
        .listVersions(pluginId)
        .filter((record) => record.status !== "removed" && !record.active);
      if (candidates.length === 0) {
        throw new PluginRollbackUnavailableError(pluginId);
      }
      const target = [...candidates].sort((a, b) => comparePluginVersions(b.version, a.version))[0] as PluginInstallationRecord;
      this.assertNoOpenOperation(pluginId);
      const operationId = this.deps.installer.createOperationId("rollback");
      const trace = this.buildTrace(operationId);
      const executor = actor.executor ?? DEFAULT_EXECUTOR;
      assertDurableAudit(
        this.deps.audit.appendStrict(
          this.auditInput({
            eventName: "audit.plugin.rollback_started",
            action: "plugin.rollback",
            decision: "allowed",
            pluginId,
            trace,
            actor: actor.actor,
            executor,
          }),
        ),
        "插件回滚审计启动",
      );
      this.deps.store.startOperation({
        operationId,
        pluginId,
        operation: "rollback",
        fromVersion: active.version,
        toVersion: target.version,
      });
      instrument.activity({
        eventName: "plugin.rollback.started",
        status: "started",
        operationId,
        actor: actor.actor,
        executor,
        target: { kind: "plugin", id: pluginId },
        scope: { pluginId },
        payload: {
          summaryCode: "plugin_rollback_started",
          attributes: { pluginId, fromVersion: active.version, toVersion: target.version },
        },
      });
      try {
        const targetNormalized = this.toNormalizedFromRecord(target);
        const versionDir = pluginVersionDir(this.deps.paths, pluginId, target.version);
        const health = this.deps.installer.healthCheck(versionDir, targetNormalized);
        if (!health.ok) {
          throw new PluginInstallError("health_check_failed", `回滚目标版本健康检查失败：${health.reason ?? ""}`);
        }
        this.deps.audit.runAuditedTransaction(
          this.auditInput({
            eventName: "audit.plugin.rollback_completed",
            action: "plugin.rollback",
            decision: "allowed",
            pluginId,
            trace,
            actor: actor.actor,
            executor,
            changedFields: ["activeVersion"],
          }),
          () => {
            this.deps.store.setActive(pluginId, target.version);
            this.deps.store.setStatus(pluginId, target.version, active.status === "removed" ? "installed" : active.status);
            this.deps.store.finishOperation(operationId, "completed");
          },
        );
        instrument.activity({
          eventName: "plugin.rollback.completed",
          status: "completed",
          operationId,
          actor: actor.actor,
          executor,
          target: { kind: "plugin", id: pluginId },
          scope: { pluginId },
          payload: {
            summaryCode: "plugin_rollback_completed",
            attributes: { pluginId, fromVersion: active.version, toVersion: target.version },
          },
        });
        return {
          pluginId,
          version: target.version,
          compatibility: buildCompatibilityReport(targetNormalized, this.deps.installer.hostVersion),
        };
      } catch (error) {
        const reasonCode = error instanceof PluginInstallError ? error.reasonCode : "rollback_failed";
        this.writeTerminalAudit("audit.plugin.rollback_failed", "plugin.rollback", pluginId, trace, actor.actor, executor, reasonCode);
        this.finishOperationBestEffort(operationId, true, reasonCode);
        instrument.activity({
          eventName: "plugin.rollback.failed",
          status: "failed",
          operationId,
          actor: actor.actor,
          executor,
          target: { kind: "plugin", id: pluginId },
          scope: { pluginId },
          payload: { summaryCode: "plugin_rollback_failed", attributes: { pluginId, reasonCode } },
        });
        throw error;
      }
    });
  }

  async uninstall(
    pluginId: string,
    actor: PluginOperationActor,
    options: { readonly deleteData?: boolean } = {},
  ): Promise<PluginUninstallResult> {
    return this.runExclusive(pluginId, async () => {
      const active = this.deps.store.getActive(pluginId);
      if (active === undefined || active.status === "removed") {
        throw new PluginNotFoundError(pluginId);
      }
      const versions = this.deps.store
        .listVersions(pluginId)
        .filter((record) => record.status !== "removed");
      this.assertNoOpenOperation(pluginId);
      const operationId = this.deps.installer.createOperationId("uninstall");
      const trace = this.buildTrace(operationId);
      const executor = actor.executor ?? DEFAULT_EXECUTOR;
      assertDurableAudit(
        this.deps.audit.appendStrict(
          this.auditInput({
            eventName: "audit.plugin.uninstall_started",
            action: "plugin.uninstall",
            decision: "allowed",
            pluginId,
            trace,
            actor: actor.actor,
            executor,
          }),
        ),
        "插件卸载审计启动",
      );
      this.deps.store.startOperation({
        operationId,
        pluginId,
        operation: "uninstall",
        fromVersion: active.version,
      });
      try {
        this.deps.audit.runAuditedTransaction(
          this.auditInput({
            eventName: "audit.plugin.uninstall_completed",
            action: "plugin.uninstall",
            decision: "allowed",
            pluginId,
            trace,
            actor: actor.actor,
            executor,
            changedFields: ["activeVersion", "installation", "grants", "bindings", "configs"],
          }),
          () => {
            this.deps.store.markRemoved(pluginId);
            this.deps.store.clearActive(pluginId);
            this.deps.store.finishOperation(operationId, "completed");
            // 清理残留授权/绑定/配置（可选 store 未注入时不处理）
            this.deps.grantStore?.removeAll(pluginId);
            this.deps.configStore?.removeAll(pluginId);
            this.deps.bindingStore?.removeByPlugin(pluginId);
          },
        );
        // 版本目录清理（DB 已一致；失败仅留可清理残留，不影响卸载结果）
        try {
          fs.rmSync(pluginInstalledRoot(this.deps.paths, pluginId), { recursive: true, force: true });
        } catch {
          instrument.warn("plugin.uninstall.cleanup_failed", "插件版本目录清理失败", { pluginId });
        }
        if (options.deleteData === true) {
          try {
            fs.rmSync(pluginDataDir(this.deps.paths, pluginId), { recursive: true, force: true });
          } catch {
            instrument.warn("plugin.uninstall.data_cleanup_failed", "插件数据目录清理失败", { pluginId });
          }
        }
        instrument.activity({
          eventName: "plugin.uninstalled",
          actor: actor.actor,
          executor,
          target: { kind: "plugin", id: pluginId },
          scope: { pluginId },
          payload: {
            summaryCode: "plugin_uninstalled",
            attributes: { pluginId, removedVersions: versions.map((record) => record.version) },
          },
        });
        return { pluginId, removedVersions: versions.map((record) => record.version) };
      } catch (error) {
        const reasonCode = error instanceof PluginInstallError ? error.reasonCode : "uninstall_failed";
        this.writeTerminalAudit("audit.plugin.uninstall_failed", "plugin.uninstall", pluginId, trace, actor.actor, executor, reasonCode);
        this.finishOperationBestEffort(operationId, true, reasonCode);
        throw error;
      }
    });
  }

  async enable(pluginId: string, actor: PluginOperationActor): Promise<void> {
    return this.runExclusive(pluginId, () => this.setEnabledState(pluginId, actor, true));
  }

  async disable(pluginId: string, actor: PluginOperationActor): Promise<void> {
    return this.runExclusive(pluginId, () => this.setEnabledState(pluginId, actor, false));
  }

  // ── 内部实现 ─────────────────────────────────────────────────

  private async installLocked(prepared: PreparedPlugin, actor: PluginOperationActor): Promise<PluginInstallResult> {
    const pluginId = prepared.normalized.id;
    const version = prepared.normalized.version;
    const existing = this.deps.store.getInstallation(pluginId, version);
    if (existing !== undefined && existing.status !== "removed") {
      throw new PluginInstallError("already_installed", "插件已安装（或已存在该版本），请使用更新或卸载后重装");
    }
    this.assertNoOpenOperation(pluginId);
    const operationId = this.deps.installer.createOperationId("install");
    const trace = this.buildTrace(operationId);
    const executor = actor.executor ?? DEFAULT_EXECUTOR;
    assertDurableAudit(
      this.deps.audit.appendStrict(
        this.auditInput({
          eventName: "audit.plugin.install_started",
          action: "plugin.install",
          decision: "allowed",
          pluginId,
          trace,
          actor: actor.actor,
          executor,
        }),
      ),
      "插件安装审计启动",
    );
    this.deps.store.startOperation({ operationId, pluginId, operation: "install", toVersion: version });

    let versionDir = "";
    let copied = false;
    try {
      versionDir = this.deps.installer.copyIntoVersionDir(prepared, pluginId, version);
      copied = true;
      // 运行时入口准备（Hermes 等平台 worker 具体化）后再做健康检查
      this.deps.installer.prepareRuntimeEntry(versionDir, prepared.normalized);
      const health = this.deps.installer.healthCheck(versionDir, prepared.normalized);
      if (!health.ok) {
        throw new PluginInstallError("health_check_failed", `插件健康检查失败：${health.reason ?? ""}`);
      }
      const record: PluginInstallationRecord = this.buildRecord(prepared, pluginId, version, "installed");
      this.deps.audit.runAuditedTransaction(
        this.auditInput({
          eventName: "audit.plugin.install_completed",
          action: "plugin.install",
          decision: "allowed",
          pluginId,
          trace,
          actor: actor.actor,
          executor,
          changedFields: ["activeVersion", "installation"],
        }),
        () => {
          this.deps.store.saveInstallation(record);
          this.deps.store.setActive(pluginId, version);
          this.deps.store.finishOperation(operationId, "completed");
        },
      );
      instrument.activity({
        eventName: "plugin.installed",
        actor: actor.actor,
        executor,
        target: { kind: "plugin", id: pluginId },
        scope: { pluginId },
        payload: {
          summaryCode: "plugin_installed",
          attributes: this.summaryAttributes(prepared, pluginId, version),
        },
      });
      return { pluginId, version, compatibility: prepared.compatibility };
    } catch (error) {
      const { compensated, reasonCode } = this.compensate(versionDir, copied, error, "install_failed");
      this.writeTerminalAudit("audit.plugin.install_failed", "plugin.install", pluginId, trace, actor.actor, executor, reasonCode);
      this.finishOperationBestEffort(operationId, compensated, reasonCode);
      throw error;
    }
  }

  private setEnabledState(pluginId: string, actor: PluginOperationActor, enabled: boolean): void {
    const active = this.deps.store.getActive(pluginId);
    if (active === undefined || active.status === "removed") {
      throw new PluginNotFoundError(pluginId);
    }
    const targetStatus: PluginStatus = enabled ? "enabled" : "disabled";
    if (active.status === targetStatus) {
      return;
    }
    this.assertNoOpenOperation(pluginId);
    const operationId = this.deps.installer.createOperationId(enabled ? "enable" : "disable");
    const executor = actor.executor ?? DEFAULT_EXECUTOR;
    this.deps.store.startOperation({
      operationId,
      pluginId,
      operation: enabled ? "enable" : "disable",
      toVersion: active.version,
    });
    this.deps.store.setStatus(pluginId, active.version, targetStatus);
    this.deps.store.finishOperation(operationId, "completed");
    instrument.activity({
      eventName: enabled ? "plugin.enabled" : "plugin.disabled",
      actor: actor.actor,
      executor,
      target: { kind: "plugin", id: pluginId },
      scope: { pluginId },
      payload: {
        summaryCode: enabled ? "plugin_enabled" : "plugin_disabled",
        attributes: { pluginId, version: active.version },
      },
    });
  }

  private buildRecord(
    prepared: PreparedPlugin,
    pluginId: string,
    version: string,
    status: PluginStatus,
  ): PluginInstallationRecord {
    return {
      pluginId,
      version,
      active: true,
      status,
      sourceType: prepared.sourceType,
      sourceRef: prepared.sourceRef.ref,
      sourceVersion: prepared.sourceRef.version ?? null,
      artifactSha256: prepared.verification.sha256,
      artifactSize: prepared.verification.sizeBytes,
      provenance: prepared.normalized.source.provenance ?? null,
      manifest: prepared.manifest,
      installedAt: new Date().toISOString(),
    };
  }

  /** 补偿：移除新版本目录（DB 事务由 runAuditedTransaction 整体回滚）。 */
  private compensate(
    versionDir: string,
    copied: boolean,
    error: unknown,
    defaultReasonCode: string,
  ): { compensated: boolean; reasonCode: string } {
    let compensated = true;
    if (copied) {
      try {
        fs.rmSync(versionDir, { recursive: true, force: true });
        compensated = !fs.existsSync(versionDir);
      } catch {
        compensated = false;
      }
    }
    const reasonCode = error instanceof PluginInstallError ? error.reasonCode : defaultReasonCode;
    return { compensated, reasonCode };
  }

  private finishOperationBestEffort(
    operationId: string,
    compensated: boolean,
    reasonCode: string,
  ): void {
    try {
      this.deps.store.finishOperation(operationId, compensated ? "compensated" : "failed", { reasonCode });
    } catch {
      /* 操作终态尽力而为 */
    }
  }

  private writeTerminalAudit(
    eventName: string,
    action: string,
    pluginId: string,
    trace: TraceContext,
    actor: ActorRef,
    executor: ExecutorRef,
    reasonCode: string,
  ): void {
    try {
      assertDurableAudit(
        this.deps.audit.appendStrict(
          this.auditInput({
            eventName,
            action,
            decision: "denied",
            pluginId,
            trace,
            actor,
            executor,
            reasonCode,
            changedFields: [],
          }),
        ),
        `${eventName} 终态审计`,
      );
    } catch {
      instrument.error("plugin.audit.terminal_failed", "插件失败终态审计未能写入", { reasonCode });
    }
  }

  private assertNoOpenOperation(pluginId: string): void {
    if (this.deps.store.findStartedOperation(pluginId) !== undefined) {
      throw new PluginConflictError(pluginId);
    }
  }

  /** 中断恢复：写失败终态严格审计（fail-closed，decision=denied/reasonCode=interrupted）。 */
  private writeRecoveryAudit(operation: PluginOperationRecord, actor: PluginOperationActor): void {
    const trace = this.buildTrace(operation.operationId);
    const executor = actor.executor ?? DEFAULT_EXECUTOR;
    assertDurableAudit(
      this.deps.audit.appendStrict(
        this.auditInput({
          eventName: "audit.plugin.operation_recovered",
          action: "plugin.operation.recover",
          decision: "denied",
          pluginId: operation.pluginId,
          trace,
          actor: actor.actor,
          executor,
          reasonCode: "interrupted",
          changedFields: ["status"],
        }),
      ),
      "中断插件操作恢复审计",
    );
  }

  /** 中断恢复：发 plugin.operation.recovered Activity（安全摘要）。 */
  private emitRecoveryActivity(operation: PluginOperationRecord, actor: PluginOperationActor): void {
    instrument.activity({
      eventName: "plugin.operation.recovered",
      status: "completed",
      operationId: operation.operationId,
      actor: actor.actor,
      executor: actor.executor ?? DEFAULT_EXECUTOR,
      target: { kind: "plugin", id: operation.pluginId },
      scope: { pluginId: operation.pluginId },
      payload: {
        summaryCode: "plugin_operation_recovered",
        attributes: { pluginId: operation.pluginId, operation: operation.operation, reasonCode: "interrupted" },
      },
    });
  }

  private summaryAttributes(
    prepared: PreparedPlugin,
    pluginId: string,
    version: string,
  ): Record<string, string> {
    return {
      pluginId,
      version,
      sourceType: prepared.sourceType,
      runtimeKind: prepared.normalized.runtime.kind,
      trust: prepared.normalized.trust,
    };
  }

  private auditInput(options: {
    readonly eventName: string;
    readonly action: string;
    readonly decision: "allowed" | "denied";
    readonly pluginId: string;
    readonly trace: TraceContext;
    readonly actor: ActorRef;
    readonly executor: ExecutorRef;
    readonly reasonCode?: string;
    readonly changedFields?: readonly string[];
  }): AuditRecordInput {
    return {
      eventName: options.eventName,
      actor: options.actor,
      executor: options.executor,
      target: { kind: "plugin", id: options.pluginId },
      scope: { pluginId: options.pluginId },
      trace: options.trace,
      payload: {
        action: options.action,
        decision: options.decision,
        ...(options.reasonCode !== undefined ? { reasonCode: options.reasonCode } : {}),
        ...(options.changedFields !== undefined ? { changedFields: [...options.changedFields] } : {}),
      },
    };
  }

  private buildTrace(operationId: string): TraceContext {
    return { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };
  }

  private toInstallation(record: PluginInstallationRecord | undefined): PluginInstallation | undefined {
    if (record === undefined) {
      return undefined;
    }
    return {
      pluginId: record.pluginId,
      version: record.version,
      active: record.active,
      status: record.status,
      source: {
        sourceRef: {
          sourceType: record.sourceType,
          ref: record.sourceRef,
          ...(record.sourceVersion !== null ? { version: record.sourceVersion } : {}),
        },
        verification: { sha256: record.artifactSha256, sizeBytes: record.artifactSize },
        ...(record.provenance !== null ? { provenance: record.provenance } : {}),
      },
      installedAt: record.installedAt,
    };
  }

  private toNormalizedFromRecord(record: PluginInstallationRecord): NormalizedPluginManifest {
    const manifest = record.manifest as ManifestV1;
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      ...(manifest.author !== undefined ? { author: manifest.author } : {}),
      ...(manifest.license !== undefined ? { license: manifest.license } : {}),
      compatibility: manifest.compatibility,
      trust: manifest.trust,
      runtime: manifest.runtime,
      permissions: manifest.permissions,
      contributions: manifest.contributions,
      ...(manifest.config !== undefined ? { config: manifest.config } : {}),
      source: {
        sourceRef: {
          sourceType: record.sourceType,
          ref: record.sourceRef,
          ...(record.sourceVersion !== null ? { version: record.sourceVersion } : {}),
        },
        verification: { sha256: record.artifactSha256, sizeBytes: record.artifactSize },
      },
      normalizedAt: record.installedAt,
    };
  }

  /** per-plugin 串行化：同一 pluginId 的后续操作排队等待前序完成。 */
  private runExclusive<T>(pluginId: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(pluginId) ?? Promise.resolve();
    const current = previous.then(task, task);
    this.tails.set(
      pluginId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}
