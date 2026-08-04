import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Value from "typebox/value";

import type { RuntimePaths } from "../../../config/paths.js";
import {
  CAPABILITY_KINDS,
  COMPATIBILITY_LEVELS,
  CONTRIBUTION_KINDS,
  ManifestV1Schema,
  NormalizedPluginManifestSchema,
  type CompatibilityItemStatus,
  type CompatibilityLevel,
  type CompatibilityReport,
  type Contributions,
  type ManifestCompatibility,
  type ManifestDev,
  type ManifestRuntime,
  type ManifestV1,
  type NormalizedPluginManifest,
  type PermissionRequest,
  type PluginAuthor,
  type PluginRuntimeKind,
  type PluginSourceType,
  type PluginTrust,
} from "../../../contracts/plugin-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import { assertPathWithinRoot, copyTreeSafe, PluginPathError, pluginStagingDir, pluginVersionDir } from "../paths.js";
import {
  assertPluginSourceRef,
  PluginSourceError,
  readManifestFile,
  SourceIntegrityError,
  type ArtifactVerification,
  type NormalizedSource,
  type PluginSourceAdapter,
  type PluginSourceRef,
} from "../sources/source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// 本地镜像类型（TypeBox 1.3.6 Static 缺陷 workaround，详见
// sources/source-adapter.ts 的说明）：冻结 Schema 仍用于运行时
// Value.Check 校验，这里仅提供结构相同的静态类型供内部标注。
// ═══════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════
// Phase 12 Plugin Installer（plans/phase-12.md §13）
//
// 流水线：staging → 解包 → hash/provenance 校验 → normalize → 兼容检查。
// 本模块只负责"准备"（不落库、不改 active），生命周期/事务/补偿由
// PluginRegistry 承担；任何失败抛 PluginInstallError（稳定 reasonCode），
// 由平台 wrapper 记录 plugin.integrity.failed / source.fetch_failed 等事件。
//
// 安全承诺：
// - 解包/复制经 PathGuard 系列（canonical + symlink/Junction + ZIP Slip）；
// - Manifest 用 Value.Check(ManifestV1Schema) 校验，未知字段拒绝；
// - 绝不执行来源包中的任何命令（postinstall/脚本一律不运行）。
// ═══════════════════════════════════════════════════════════════

export class PluginInstallError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "PluginInstallError";
    this.reasonCode = reasonCode;
  }
}

export interface PreparedPlugin {
  readonly operationId: string;
  readonly stagingDir: string;
  readonly contentRoot: string;
  readonly manifest: ManifestV1;
  readonly normalized: NormalizedPluginManifest;
  readonly verification: ArtifactVerification;
  readonly compatibility: CompatibilityReport;
  readonly sourceRef: PluginSourceRef;
  readonly sourceType: PluginSourceType;
}

export interface PluginHealthResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface PluginInstallerDeps {
  readonly paths: RuntimePaths;
  readonly adapters: readonly PluginSourceAdapter[];
  /** 平台版本（opencolorful 版本范围判定）。 */
  readonly hostVersion: string;
}

// ── SemVer 范围判定（本地实现，不引入额外依赖） ────────────────

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parsePluginVersion(input: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (match === null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function comparePluginVersions(a: string, b: string): number {
  const parsedA = parsePluginVersion(a);
  const parsedB = parsePluginVersion(b);
  if (parsedA === null || parsedB === null) {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (parsedA.major !== parsedB.major) return parsedA.major < parsedB.major ? -1 : 1;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor < parsedB.minor ? -1 : 1;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch < parsedB.patch ? -1 : 1;
  return 0;
}

function satisfiesSingle(version: ParsedVersion, constraint: string): boolean {
  const trimmed = constraint.trim();
  if (trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "x") {
    return true;
  }
  const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (caret !== null) {
    const major = Number(caret[1]);
    const minor = caret[2] !== undefined ? Number(caret[2]) : 0;
    const patch = caret[3] !== undefined ? Number(caret[3]) : 0;
    const lower = { major, minor, patch };
    const upper =
      major > 0
        ? { major: major + 1, minor: 0, patch: 0 }
        : minor > 0
          ? { major: 0, minor: minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: patch + 1 };
    return comparePluginVersions(fmt(version), fmt(lower)) >= 0 && comparePluginVersions(fmt(version), fmt(upper)) < 0;
  }
  const tilde = /^~(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (tilde !== null) {
    const major = Number(tilde[1]);
    const minor = tilde[2] !== undefined ? Number(tilde[2]) : 0;
    const patch = tilde[3] !== undefined ? Number(tilde[3]) : 0;
    const lower = { major, minor, patch };
    const upper = { major, minor: minor + 1, patch: 0 };
    return comparePluginVersions(fmt(version), fmt(lower)) >= 0 && comparePluginVersions(fmt(version), fmt(upper)) < 0;
  }
  const xRange = /^(\d+)(?:\.(\d+))?\.(?:x|X|\*)$/.exec(trimmed);
  if (xRange !== null) {
    const major = Number(xRange[1]);
    if (xRange[2] !== undefined) {
      const minor = Number(xRange[2]);
      return version.major === major && version.minor === minor;
    }
    return version.major === major;
  }
  const opRange = /^(>=|<=|>|<|=|==)?\s*v?(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (opRange !== null) {
    const operator = opRange[1] ?? "=";
    const target = { major: Number(opRange[2]), minor: Number(opRange[3]), patch: Number(opRange[4]) };
    const cmp = comparePluginVersions(fmt(version), fmt(target));
    switch (operator) {
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      default:
        return cmp === 0;
    }
  }
  const loose = /^(>=|<=|>|<|=|==)?\s*v?(\d+)\.(\d+)$/.exec(trimmed);
  if (loose !== null) {
    const operator = loose[1] ?? "=";
    const target = { major: Number(loose[2]), minor: Number(loose[3]), patch: 0 };
    const cmp = comparePluginVersions(fmt(version), fmt(target));
    switch (operator) {
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      default:
        return cmp === 0;
    }
  }
  return false;
}

function fmt(parsed: ParsedVersion): string {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/** 兼容范围判定：支持 ||（或）与逗号/空格（且）组合。 */
export function satisfiesOpenColorfulRange(hostVersion: string, range: string): boolean {
  const version = parsePluginVersion(hostVersion);
  if (version === null) {
    return false;
  }
  for (const orPart of range.split("||")) {
    const andParts = orPart.split(/[, ]+/).filter((part) => part.trim().length > 0);
    if (andParts.every((part) => satisfiesSingle(version, part))) {
      return true;
    }
  }
  return false;
}

/** 兼容性报告：结构等级 + 阻断原因 + full-access 标记（plans/phase-12.md §12.2）。 */
export function buildCompatibilityReport(
  normalized: NormalizedPluginManifest,
  hostVersion: string,
): CompatibilityReport {
  const contributions: Array<{
    id: string;
    kind: string;
    status: CompatibilityItemStatus;
    reason?: string;
  }> = [];
  const missingCapabilities: string[] = [];
  const blockedReasons: string[] = [];
  let level: CompatibilityLevel = "L1";

  const considerLevel = (candidate: CompatibilityLevel): void => {
    if (COMPATIBILITY_LEVELS.indexOf(candidate) > COMPATIBILITY_LEVELS.indexOf(level)) {
      level = candidate;
    }
  };

  const contributionMap = normalized.contributions as Record<string, unknown>;
  for (const kind of CONTRIBUTION_KINDS) {
    const list = contributionMap[kind];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        continue;
      }
      const id = entry.id;
      const required = Array.isArray(entry.requiredCapabilities) ? entry.requiredCapabilities : [];
      const missing = required.filter(
        (cap) => typeof cap !== "string" || !(CAPABILITY_KINDS as readonly string[]).includes(cap),
      );
      if (missing.length > 0) {
        missingCapabilities.push(...missing.map(String));
        contributions.push({ id, kind, status: "degraded", reason: "声明了平台不支持的能力" });
      } else {
        contributions.push({ id, kind, status: "supported" });
      }
    }
    if (list.length > 0) {
      if (kind === "tool") {
        considerLevel("L4");
      } else if (kind === "skill-bundle" || kind === "command") {
        considerLevel("L2");
      } else if (kind === "page" || kind === "widget" || kind === "chat-surface") {
        considerLevel("L6");
      }
    }
  }

  if (normalized.runtime.kind === "mcp") {
    considerLevel("L3");
  }
  if (normalized.runtime.kind === "node-process" || normalized.runtime.kind === "python-process") {
    considerLevel("L5");
  }

  if (!satisfiesOpenColorfulRange(hostVersion, normalized.compatibility.opencolorful)) {
    blockedReasons.push(
      `opencolorful 版本范围不满足（要求 ${normalized.compatibility.opencolorful}，当前 ${hostVersion}）`,
    );
  }
  const requiresCodeRuntime =
    normalized.runtime.kind === "node-process" || normalized.runtime.kind === "python-process";
  if (requiresCodeRuntime && normalized.trust !== "full-access") {
    blockedReasons.push("代码运行时（node-process/python-process）必须声明 full-access");
  }

  return {
    pluginId: normalized.id,
    version: normalized.version,
    level,
    supported: blockedReasons.length === 0,
    missingCapabilities: Array.from(new Set(missingCapabilities)),
    contributions,
    blockedReasons,
    requiresFullAccess: normalized.trust === "full-access",
    ...(normalized.runtime.kind !== "bundle" ? { requiresRuntime: normalized.runtime.kind } : {}),
  };
}

export class PluginInstaller {
  private readonly adapterByType: ReadonlyMap<PluginSourceType, PluginSourceAdapter>;

  constructor(private readonly deps: PluginInstallerDeps) {
    this.adapterByType = new Map(deps.adapters.map((adapter) => [adapter.sourceType, adapter]));
  }

  get hostVersion(): string {
    return this.deps.hostVersion;
  }

  adapterFor(sourceType: PluginSourceType): PluginSourceAdapter {
    const adapter = this.adapterByType.get(sourceType);
    if (adapter === undefined) {
      throw new PluginInstallError("unsupported_source", "该来源类型暂不受支持");
    }
    return adapter;
  }

  createOperationId(prefix: string): string {
    return `plugin-${prefix}-${crypto.randomUUID()}`;
  }

  /**
   * 准备阶段（不落库、不改 active）：
   * fetch → staging → hash/provenance → manifest 校验 → 规范化 → 兼容报告。
   * 来源/integrity 失败自动记录 plugin.source.fetch_failed / plugin.integrity.failed
   * （plans/phase-12.md §17.1 平台边界自动埋点），随后抛出原错误。
   */
  prepare(sourceRef: PluginSourceRef): PreparedPlugin {
    const ref = assertPluginSourceRef(sourceRef);
    try {
      return this.prepareInternal(ref);
    } catch (error) {
      if (!(error instanceof PluginInstallError)) {
        this.emitPrepareFailure(ref.sourceType, error);
      }
      throw error;
    }
  }

  private prepareInternal(ref: PluginSourceRef): PreparedPlugin {
    const adapter = this.adapterFor(ref.sourceType);
    const operationId = this.createOperationId("stage");
    const stagingDir = pluginStagingDir(this.deps.paths, operationId);
    fs.mkdirSync(stagingDir, { recursive: true });
    const artifact = adapter.fetchArtifact(ref, { stagingDir });
    const verification = adapter.verifyArtifact(artifact);
    const provenance = adapter.readProvenance(artifact);
    const rawManifest = readManifestFile(artifact.contentRoot);
    if (!Value.Check(ManifestV1Schema, rawManifest)) {
      throw new PluginInstallError("invalid_manifest", "插件 Manifest 不符合 v1 契约（未知字段或字段非法）");
    }
    const manifest = rawManifest as ManifestV1;
    const normalized = this.normalize(manifest, ref, verification, provenance);
    if (!Value.Check(NormalizedPluginManifestSchema, normalized)) {
      throw new PluginInstallError("invalid_normalized", "插件规范化清单不符合契约");
    }
    const compatibility = buildCompatibilityReport(normalized, this.deps.hostVersion);
    if (!compatibility.supported) {
      throw new PluginInstallError("incompatible", `插件不兼容：${compatibility.blockedReasons.join("；")}`);
    }
    this.emitDiscovered(normalized, ref.sourceType);
    this.emitStaged(normalized, ref.sourceType);
    return {
      operationId,
      stagingDir,
      contentRoot: artifact.contentRoot,
      manifest,
      normalized,
      verification,
      compatibility,
      sourceRef: ref,
      sourceType: ref.sourceType,
    };
  }

  /** 来源/完整性失败自动埋点（payload 只含安全摘要，不含来源路径原文）。 */
  private emitPrepareFailure(sourceType: PluginSourceType, error: unknown): void {
    const reasonCode = error instanceof PluginSourceError ? error.reasonCode : "prepare_failed";
    const isIntegrity = error instanceof SourceIntegrityError || error instanceof PluginPathError;
    const eventName = isIntegrity ? "plugin.integrity.failed" : "plugin.source.fetch_failed";
    instrument.activity({
      eventName,
      status: "failed",
      actor: { kind: "system", id: "plugin-installer" },
      executor: { kind: "service", id: "plugin-installer" },
      payload: {
        summaryCode: eventName.replace(/\./g, "_"),
        attributes: { sourceType, reasonCode },
      },
    });
  }

  normalize(
    manifest: ManifestV1,
    ref: PluginSourceRef,
    verification: ArtifactVerification,
    provenance: unknown,
  ): NormalizedPluginManifest {
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
          sourceType: ref.sourceType,
          ref: ref.ref,
          ...(ref.version !== undefined ? { version: ref.version } : {}),
        },
        verification: {
          sha256: verification.sha256,
          sizeBytes: verification.sizeBytes,
          ...(verification.provenance !== undefined ? { provenance: verification.provenance } : {}),
        },
        ...(provenance !== undefined ? { provenance } : {}),
      },
      normalizedAt: new Date().toISOString(),
    };
  }

  /** 复制内容为不可变版本目录（.git 按需排除）；复制前清空遗留目录。 */
  copyIntoVersionDir(prepared: PreparedPlugin, pluginId: string, version: string): string {
    const versionDir = pluginVersionDir(this.deps.paths, pluginId, version);
    assertPathWithinRoot(versionDir, this.deps.paths.pluginsInstalled, "版本目录");
    fs.rmSync(versionDir, { recursive: true, force: true });
    copyTreeSafe(prepared.contentRoot, versionDir, { exclude: prepared.sourceType === "git" ? [".git"] : [] });
    return versionDir;
  }

  /** 健康检查：版本目录存在、manifest 可解析且与规范化清单一致、代码入口存在。 */
  healthCheck(versionDir: string, normalized: NormalizedPluginManifest): PluginHealthResult {
    try {
      if (!fs.existsSync(path.join(versionDir, "manifest.json"))) {
        return { ok: false, reason: "版本目录缺少 manifest.json" };
      }
      const raw = readManifestFile(versionDir);
      if (!Value.Check(ManifestV1Schema, raw)) {
        return { ok: false, reason: "版本目录内 manifest 不符合 v1 契约" };
      }
      const manifest = raw as ManifestV1;
      if (manifest.id !== normalized.id || manifest.version !== normalized.version) {
        return { ok: false, reason: "版本目录 manifest 与规范化清单不一致" };
      }
      if (normalized.runtime.kind === "node-process" || normalized.runtime.kind === "python-process") {
        const entry = normalized.runtime.entry;
        if (entry !== undefined) {
          const entryPath = path.join(versionDir, entry);
          const stat = fs.lstatSync(entryPath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            return { ok: false, reason: "代码运行时入口文件缺失或为符号链接" };
          }
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "健康检查失败" };
    }
  }

  private emitDiscovered(normalized: NormalizedPluginManifest, sourceType: PluginSourceType): void {
    instrument.activity({
      eventName: "plugin.discovered",
      actor: { kind: "system", id: "plugin-installer" },
      executor: { kind: "service", id: "plugin-installer" },
      target: { kind: "plugin", id: normalized.id },
      scope: { pluginId: normalized.id },
      payload: {
        summaryCode: "plugin_discovered",
        attributes: { pluginId: normalized.id, version: normalized.version, sourceType },
      },
    });
  }

  private emitStaged(normalized: NormalizedPluginManifest, sourceType: PluginSourceType): void {
    instrument.activity({
      eventName: "plugin.staged",
      actor: { kind: "system", id: "plugin-installer" },
      executor: { kind: "service", id: "plugin-installer" },
      target: { kind: "plugin", id: normalized.id },
      scope: { pluginId: normalized.id },
      payload: {
        summaryCode: "plugin_staged",
        attributes: { pluginId: normalized.id, version: normalized.version, sourceType },
      },
    });
  }
}
