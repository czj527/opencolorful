import crypto from "node:crypto";
import fs from "node:fs";

import type { RuntimePaths } from "../../../config/paths.js";
import type {
  NormalizedSkillManifest,
  SkillCompatibilityReport,
  SkillErrorCode,
  SkillProvenance,
  SkillRef,
  SkillSourceAdapterKind,
  SkillSourceCandidate,
} from "../../../contracts/skill-protocol.js";
import { skillRefKey } from "../../../contracts/skill-protocol.js";
import type { EventScope } from "../../../contracts/observability.js";
import { instrument } from "../../../observability/instrument.js";
import type { RegisteredSkill } from "../catalog/skill-catalog.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import { SkillError } from "../errors.js";
import { computeSkillContentHash } from "../hash.js";
import { slugifySkillId } from "../manifest.js";
import { SkillPathError, safeJoin } from "../path-safety.js";
import type { ReadinessEnvironment } from "../readiness.js";
import type { SkillSourceAdapter, SkillSourceInspection } from "../sources/skill-source-adapter.js";
import { inspectLocalDirectory } from "../sources/skill-source-adapter.js";
import { copyPackageTree, resolveStagedVersion } from "../sources/stage-utils.js";
import { peekSkillManifest, validateSkillPackage } from "../validator.js";
import type { SkillInstallSourceKind, SkillStager } from "./stager.js";
import { assessPackageRisks, type SkillRiskMarker } from "./risk.js";
import type { SkillOperationStore } from "./operation-store.js";
import type { SessionFileRegistration, SessionFileRegistrationInput, SessionFileRegistry } from "./session-file-registry.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 SkillInstaller（plans/phase-13.md §7.3 / §8.3 / §12.2 / §18.3）
//
// 完整安装流水线：
//   inspect（适配器）→ stage（受控 staging，skillsStaging/<operationId>）
//   → validate（复用 validator）→ canonicalize/hash（复用 hash.ts）
//   → 复制为不可变 Managed Artifact（skillsInstalled/<skillId>/<version>/，
//      temp + rename 原子写入）→ provenance 保存（进 Catalog 登记）
//   → Catalog.ingestCandidate → skill_operations started→completed/failed/compensated。
//
// 安全承诺：
// - 只接受完整 package；裸 skill_content / 裸 Markdown → skill_not_a_complete_package；
// - 绝不执行来源脚本、postinstall、依赖安装命令（只复制与校验）；
// - scripts/ 目录 → 显著风险标记（进 inspect 结果）；二进制 → skill_binary_denied；
// - 同版本同哈希 → 幂等；同版本不同哈希 → skill_version_conflict；
// - 任何一步失败（复制/登记/审计事务）→ 清理 staging + 恢复已复制 Artifact
//   + operation 记 failed/compensated（参照 Phase 12 plugin 补偿模式）。
// ═══════════════════════════════════════════════════════════════

export interface SkillInstallerDeps {
  readonly paths: RuntimePaths;
  readonly catalog: SkillCatalog;
  readonly operations: SkillOperationStore;
  readonly sessionFiles: SessionFileRegistry;
  readonly adapters: readonly SkillSourceAdapter[];
  readonly stager: SkillStager;
  /** 登记时环境快照（Catalog readiness 诊断用） */
  readonly environment: ReadinessEnvironment;
}

export interface SkillInstallOptions {
  readonly sourceRef: string;
  readonly kind: SkillInstallSourceKind;
  /** 来源信任决策（T6 审批流决定；false 记为 untrusted，不阻断安装） */
  readonly trust: boolean;
  readonly sessionId?: string;
  readonly agentId?: string;
  /** 内部：install 复用为 update 时写 skill_operations 的 kind */
  readonly operationKind?: "install" | "update";
  /** 内部：update 时校验新来源解析出的 skillId 与目标一致 */
  readonly expectedSkillId?: string;
}

export interface SkillInstallResult {
  readonly operationId: string;
  readonly skillRef: SkillRef;
  readonly skillRefKey: string;
  readonly registered: RegisteredSkill;
  readonly idempotent: boolean;
  readonly risks: readonly SkillRiskMarker[];
}

export interface SkillUpdateOptions {
  readonly skillId: string;
  readonly newSourceRef: string;
  readonly kind: SkillInstallSourceKind;
  readonly trust: boolean;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface SkillRollbackOptions {
  readonly skillId: string;
  readonly targetVersion: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface SkillRollbackResult {
  readonly operationId: string;
  readonly skillRef: SkillRef;
  readonly registered: RegisteredSkill;
}

export interface SkillUninstallOptions {
  readonly skillId: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface SkillUninstallResult {
  readonly operationId: string;
  readonly skillId: string;
  /** 从 Catalog 移除的登记数（记录保留在 skill_operations 与审计） */
  readonly removedRefs: number;
}

export interface SkillSourceInspectResult {
  readonly inspection: SkillSourceInspection;
  readonly risks: readonly SkillRiskMarker[];
  readonly version: string;
}

interface ValidatedStagedPackage {
  readonly manifest: NormalizedSkillManifest;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly version: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly risks: readonly SkillRiskMarker[];
}

export class SkillInstaller {
  constructor(private readonly deps: SkillInstallerDeps) {}

  createOperationId(kind: string): string {
    return `skill-${kind}-${crypto.randomUUID()}`;
  }

  registerSessionFile(input: SessionFileRegistrationInput): SessionFileRegistration {
    return this.deps.sessionFiles.register(input);
  }

  /**
   * 安装前检查（T6/T8 检查页使用）：适配器 inspect + 结构风险标记。
   * session-file 通过临时 staging 检查后立即清理，不落 installed。
   */
  inspectSource(input: { readonly sourceRef: string; readonly kind: SkillInstallSourceKind; readonly sessionId?: string }): SkillSourceInspectResult {
    if (input.kind === "session-file") {
      const operationId = this.createOperationId("inspect");
      try {
        const staged = this.deps.stager.stage({
          sourceRef: input.sourceRef,
          kind: "session-file",
          operationId,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        });
        const inspection = inspectLocalDirectory(staged.packageRoot);
        return { inspection, risks: inspection.risks ?? [], version: resolveStagedVersion(staged.packageRoot) };
      } finally {
        this.deps.stager.cleanup(operationId);
      }
    }
    const adapter = this.adapterFor(input.kind);
    const inspection = adapter.inspect(input.sourceRef);
    return { inspection, risks: inspection.risks ?? [], version: versionOfInspection(inspection) };
  }

  /** 完整安装（新 Skill 或同 Skill 的新版本）。 */
  install(options: SkillInstallOptions): SkillInstallResult {
    const operationId = this.createOperationId(options.operationKind ?? "install");
    const operationKind = options.operationKind ?? "install";
    this.emitSkillEvent("skill.install.started", "started", operationId, options, { sourceRef: options.sourceRef.slice(0, 240), kind: options.kind });
    this.deps.operations.startOperation({
      operationId,
      kind: operationKind,
      sourceRef: options.sourceRef,
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    });
    let installedSkillRoot: string | undefined;
    let installedVersionDir: string | undefined;
    try {
      const staged = this.deps.stager.stage({
        sourceRef: options.sourceRef,
        kind: options.kind,
        operationId,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      });
      const validated = this.validateStagedPackage(staged);
      const skillId = slugifySkillId(validated.manifest.name);
      const version = validated.version;
      if (options.expectedSkillId !== undefined && skillId !== options.expectedSkillId) {
        throw new SkillError("skill_operation_failed", `更新来源的 Skill 名称与目标不一致（期望 ${options.expectedSkillId}，实际 ${skillId}）`);
      }
      installedSkillRoot = safeJoin(this.deps.paths.skillsInstalled, skillId);
      const targetVersionDir = safeJoin(installedSkillRoot, version);
      let idempotent = false;
      if (fs.existsSync(targetVersionDir)) {
        const existingHash = computeSkillContentHash(targetVersionDir, { version });
        if (existingHash === validated.contentHash) {
          idempotent = true;
        } else {
          throw new SkillError("skill_version_conflict", `同一版本（${version}）内容哈希不一致：不可变 Artifact 拒绝覆盖，请为新内容提升版本号`);
        }
      } else {
        this.copyAtomically(staged.packageRoot, installedSkillRoot, targetVersionDir, operationId);
        installedVersionDir = targetVersionDir;
      }
      const registered = this.registerManagedSkill({
        skillId,
        version,
        displayName: validated.manifest.name,
        description: validated.manifest.description,
        packageRoot: targetVersionDir,
        contentHash: validated.contentHash,
        sizeBytes: validated.sizeBytes,
        fileCount: validated.fileCount,
        manifest: validated.manifest,
        compatibility: validated.compatibility,
        provenance: staged.provenance,
        trust: options.trust,
        risks: validated.risks,
      });
      this.deps.stager.cleanup(operationId);
      this.deps.operations.finishOperation(operationId, "completed");
      this.emitSkillEvent("skill.install.completed", "completed", operationId, options, {
        skillRefKey: skillRefKey(registered.skillRef),
        skillId,
        version,
        contentHash: registered.contentHash.slice(0, 24),
        idempotent,
      });
      return {
        operationId,
        skillRef: registered.skillRef,
        skillRefKey: skillRefKey(registered.skillRef),
        registered,
        idempotent,
        risks: validated.risks,
      };
    } catch (error) {
      const reasonCode = extractReasonCode(error);
      const compensated = this.compensateInstall(operationId, installedSkillRoot, installedVersionDir);
      this.deps.operations.finishOperation(operationId, compensated ? "compensated" : "failed", { errorCode: reasonCode });
      this.emitSkillEvent("skill.install.failed", "failed", operationId, options, { reasonCode });
      throw toSkillError(error, "skill_operation_failed");
    }
  }

  /** 更新：从新来源安装新版本（旧版本目录保留，可回滚）。 */
  update(options: SkillUpdateOptions): SkillInstallResult {
    const existing = this.deps.catalog.list({}).filter((skill) => skill.skillId === options.skillId);
    if (existing.length === 0) {
      throw new SkillError("skill_unknown_skillref", `Skill 未安装，无法更新：${options.skillId}`);
    }
    return this.install({
      sourceRef: options.newSourceRef,
      kind: options.kind,
      trust: options.trust,
      operationKind: "update",
      expectedSkillId: options.skillId,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    });
  }

  /** 回滚：重新登记已保留的旧版本目录（旧版本不删除，可反复回滚）。 */
  rollback(options: SkillRollbackOptions): SkillRollbackResult {
    const operationId = this.createOperationId("rollback");
    this.emitSkillEvent("skill.rollback.started", "started", operationId, options, { skillId: options.skillId, targetVersion: options.targetVersion });
    this.deps.operations.startOperation({
      operationId,
      kind: "rollback",
      sourceRef: `${options.skillId}@${options.targetVersion}`,
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    });
    try {
      const packageRoot = safeJoin(this.deps.paths.skillsInstalled, options.skillId, options.targetVersion);
      if (!fs.existsSync(packageRoot)) {
        throw new SkillError("skill_rollback_failed", `回滚目标版本未安装（旧版本目录不存在）：${options.skillId}@${options.targetVersion}`);
      }
      const validation = validateSkillPackage({ packageRoot, version: options.targetVersion });
      if (!validation.ok || validation.contentHash === null || validation.manifest === null) {
        throw new SkillError("skill_rollback_failed", validation.errors[0]?.message ?? "回滚目标版本校验失败");
      }
      const registered = this.registerManagedSkill({
        skillId: options.skillId,
        version: options.targetVersion,
        displayName: validation.manifest.name,
        description: validation.manifest.description,
        packageRoot,
        contentHash: validation.contentHash,
        sizeBytes: validation.sizeBytes,
        fileCount: validation.fileCount,
        manifest: validation.manifest,
        compatibility: validation.compatibility,
        provenance: { sourceRef: packageRoot, fetchedAt: new Date().toISOString() },
        trust: true,
        risks: assessPackageRisks(packageRoot),
      });
      this.deps.operations.finishOperation(operationId, "completed");
      this.emitSkillEvent("skill.rollback.completed", "completed", operationId, options, { skillRefKey: skillRefKey(registered.skillRef), skillId: options.skillId, targetVersion: options.targetVersion });
      return { operationId, skillRef: registered.skillRef, registered };
    } catch (error) {
      const reasonCode = extractReasonCode(error);
      this.deps.operations.finishOperation(operationId, "failed", { errorCode: reasonCode });
      this.emitSkillEvent("skill.rollback.failed", "failed", operationId, options, { reasonCode });
      throw toSkillError(error, "skill_rollback_failed");
    }
  }

  /**
   * 卸载：从 Catalog 移除登记（立即不可解析）+ 删除 installed 正文目录。
   * 记录与审计保留（skill_operations + observability 事件），正文删除不阻塞审计。
   */
  uninstall(options: SkillUninstallOptions): SkillUninstallResult {
    const operationId = this.createOperationId("uninstall");
    this.deps.operations.startOperation({
      operationId,
      kind: "uninstall",
      sourceRef: options.skillId,
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    });
    try {
      const removedRefs = this.deps.catalog.removeBySkillId(options.skillId);
      const installedRoot = safeJoin(this.deps.paths.skillsInstalled, options.skillId);
      if (removedRefs === 0 && !fs.existsSync(installedRoot)) {
        throw new SkillError("skill_unknown_skillref", `Skill 未安装：${options.skillId}`);
      }
      fs.rmSync(installedRoot, { recursive: true, force: true });
      this.deps.operations.finishOperation(operationId, "completed");
      const scope = buildScope(options.sessionId, options.agentId);
      instrument.activity({
        eventName: "skill.uninstalled",
        actor: { kind: "system", id: "skill-installer" },
        executor: { kind: "service", id: "skill-installer" },
        target: { kind: "external_resource", id: `skill:${options.skillId}` },
        ...(scope !== undefined ? { scope } : {}),
        payload: {
          summaryCode: "skill_uninstalled",
          attributes: { skillId: options.skillId, removedRefs },
        },
      });
      return { operationId, skillId: options.skillId, removedRefs };
    } catch (error) {
      const reasonCode = extractReasonCode(error);
      this.deps.operations.finishOperation(operationId, "failed", { errorCode: reasonCode });
      throw toSkillError(error, "skill_operation_failed");
    }
  }

  // ── 内部：校验 / 复制 / 登记 / 补偿 ─────────────────────────────

  private validateStagedPackage(staged: { readonly packageRoot: string; readonly contentHash: string; readonly sizeBytes: number }): ValidatedStagedPackage {
    const peek = peekSkillManifest(staged.packageRoot);
    if (!peek.ok) {
      throw new SkillError(peek.error?.reasonCode ?? "skill_not_a_complete_package", peek.error?.message ?? "暂存包缺少有效 SKILL.md");
    }
    const version = peek.version ?? "0.0.0";
    const validation = validateSkillPackage({ packageRoot: staged.packageRoot, version });
    if (!validation.ok) {
      const firstError = validation.errors[0];
      const message =
        firstError?.reasonCode === "skill_binary_denied"
          ? `${firstError?.message ?? "包含二进制/可执行文件"}；Skill 安装器默认拒绝，建议转换为 Plugin 分发`
          : (firstError?.message ?? "Skill 包校验失败");
      throw new SkillError(firstError?.reasonCode ?? "skill_package_invalid", message);
    }
    if (validation.contentHash === null) {
      throw new SkillError("skill_package_invalid", "内容哈希不可用，无法安装");
    }
    if (validation.contentHash !== staged.contentHash) {
      throw new SkillError("skill_content_hash_mismatch", "暂存包内容哈希与来源适配器声明不一致");
    }
    if (validation.sizeBytes !== staged.sizeBytes) {
      throw new SkillError("skill_content_hash_mismatch", "暂存包大小与来源适配器声明不一致");
    }
    if (validation.manifest === null) {
      throw new SkillError("skill_manifest_invalid", "Skill 包缺少标准化 Manifest");
    }
    return {
      manifest: validation.manifest,
      compatibility: validation.compatibility,
      version,
      contentHash: validation.contentHash,
      sizeBytes: validation.sizeBytes,
      fileCount: validation.fileCount,
      risks: assessPackageRisks(staged.packageRoot),
    };
  }

  /** 不可变 Artifact 原子写入：temp + rename（同一文件系统内原子）。 */
  private copyAtomically(packageRoot: string, installedSkillRoot: string, targetVersionDir: string, operationId: string): void {
    fs.mkdirSync(installedSkillRoot, { recursive: true });
    const tempDir = safeJoin(installedSkillRoot, `.tmp-${operationId}`);
    try {
      copyPackageTree(packageRoot, tempDir, { exclude: [".git"] });
      fs.renameSync(tempDir, targetVersionDir);
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  private registerManagedSkill(input: {
    readonly skillId: string;
    readonly version: string;
    readonly displayName: string;
    readonly description: string | undefined;
    readonly packageRoot: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
    readonly fileCount: number;
    readonly manifest: NormalizedSkillManifest;
    readonly compatibility: SkillCompatibilityReport | null;
    readonly provenance: SkillProvenance;
    readonly trust: boolean;
    readonly risks: readonly SkillRiskMarker[];
  }): RegisteredSkill {
    const candidate: SkillSourceCandidate = {
      sourceId: input.packageRoot,
      sourceKind: "managed",
      displayName: input.displayName,
      version: input.version,
      ...(input.description !== undefined ? { description: input.description } : {}),
      provenance: input.provenance,
    };
    const inspection: SkillSourceInspection = {
      sourceRef: input.packageRoot,
      packageRoot: input.packageRoot,
      manifest: input.manifest,
      compatibility: input.compatibility,
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      fileCount: input.fileCount,
      errors: [],
      risks: input.risks,
    };
    return this.deps.catalog.ingestCandidate({
      candidate,
      inspection,
      trusted: input.trust,
      environment: this.deps.environment,
    });
  }

  /** 失败补偿：清理 staging + 恢复已复制 Artifact（尽力而为）。 */
  private compensateInstall(operationId: string, installedSkillRoot: string | undefined, installedVersionDir: string | undefined): boolean {
    try {
      this.deps.stager.cleanup(operationId);
      if (installedVersionDir !== undefined) {
        fs.rmSync(installedVersionDir, { recursive: true, force: true });
      }
      if (installedSkillRoot !== undefined && isEmptyDirectory(installedSkillRoot)) {
        fs.rmSync(installedSkillRoot, { recursive: true, force: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  private adapterFor(kind: SkillSourceAdapterKind): SkillSourceAdapter {
    const adapter = this.deps.adapters.find((candidate) => candidate.kind === kind);
    if (adapter === undefined) {
      throw new SkillError("skill_source_unsupported", `来源适配器不受支持：${kind}`);
    }
    return adapter;
  }

  private emitSkillEvent(
    eventName: "skill.install.started" | "skill.install.completed" | "skill.install.failed" | "skill.rollback.started" | "skill.rollback.completed" | "skill.rollback.failed",
    status: "started" | "completed" | "failed",
    operationId: string,
    options: { readonly sessionId?: string; readonly agentId?: string },
    attributes: Record<string, string | number | boolean>,
  ): void {
    const scope = buildScope(options.sessionId, options.agentId);
    instrument.activity({
      eventName,
      status,
      operationId,
      actor: { kind: "system", id: "skill-installer" },
      executor: { kind: "service", id: "skill-installer" },
      ...(scope !== undefined ? { scope } : {}),
      payload: { summaryCode: eventName.replace(/\./g, "_"), attributes },
    });
  }
}

function buildScope(sessionId: string | undefined, agentId: string | undefined): EventScope | undefined {
  if (agentId !== undefined) {
    return { ownerAgentId: agentId, ...(sessionId !== undefined ? { sessionId } : {}) };
  }
  if (sessionId !== undefined) {
    return { sessionId };
  }
  return undefined;
}

function extractReasonCode(error: unknown): SkillErrorCode {
  if (error instanceof SkillError) {
    return error.code;
  }
  if (error instanceof SkillPathError) {
    return error.reasonCode;
  }
  return "skill_operation_failed";
}

function toSkillError(error: unknown, fallback: SkillErrorCode): SkillError {
  if (error instanceof SkillError) {
    return error;
  }
  return new SkillError(fallback, error instanceof Error ? error.message : String(error));
}

function versionOfInspection(inspection: SkillSourceInspection): string {
  const peek = peekSkillManifest(inspection.packageRoot);
  return peek.ok ? (peek.version ?? "0.0.0") : "0.0.0";
}

function isEmptyDirectory(target: string): boolean {
  try {
    return fs.readdirSync(target).length === 0;
  } catch {
    return false;
  }
}
