import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SkillSourceCandidate, SkillSourceKind, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { peekSkillManifest, type ManifestPeek } from "../validator.js";
import { parseSkillDocument } from "../frontmatter.js";
import { normalizeSkillManifest } from "../manifest.js";
import { assertEcoInstallable, ecoErrorWithAdvice } from "../compat/ecosystem-migration.js";
import type { SkillResolvedVersion, SkillSourceInspection } from "./skill-source-adapter.js";
import { inspectLocalDirectory, nowIsoTimestamp } from "./skill-source-adapter.js";
import { buildStagedPackage, copyPackageTree, toSkillSourceError } from "./stage-utils.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 生态镜像共享层（plans/phase-13.md §8.3 / §15.2 / §18.7）
//
// OpenClaw（ClawHub）与 Hermes 适配器共用的"本地固定版本镜像"布局：
//
//   mirrorDir/<skillId>@<version>/SKILL.md
//
// - 镜像 = 固定版本本地副本（ClawHub/Hermes 市场下载固化或自建 fixture），
//   默认 CI 只读镜像，绝不请求外网；
// - sourceRef 规范形式：<prefix>:<skillId>@<version>（prefix ∈ openclaw|hermes），
//   不支持 latest 语义（锁定版本是安全基线）；
// - provenance：sourceRef + fetchedAt + originalUrl（生态规范 URI，仅展示）；
// - 兼容失败（metadata-only / unsupported / 需要人工迁移）在 stage 拒绝并给出
//   迁移建议，不生成表面成功但运行时空壳的 Skill；
// - 远程市场搜索/下载不是本层职责：无镜像目录时 discover 返回空、
//   inspect/stage 给出明确诊断（网络失败绝不伪装成"没有 Skill"）。
// ═══════════════════════════════════════════════════════════════

export interface EcosystemMirrorOptions {
  readonly mirrorDir?: string;
  readonly prefix: "openclaw" | "hermes";
  readonly sourceKind: SkillSourceKind;
  /** 生态规范 URI 模板（仅 provenance 展示，不发起请求） */
  readonly originalUrlFor: (skillId: string, version: string) => string;
  /** Hermes 适配器在 staging 副本上执行的 frontmatter 转换（可选） */
  readonly rewriteStaged?: (packageRoot: string) => { readonly changed: boolean; readonly conversions: readonly string[] };
  /** 转换后形态的文本级 peek（Hermes 适配器提供：scan/inspect 用它读取可安装形态） */
  readonly convertForPeek?: (source: string) => { readonly source: string };
}

export interface EcoEntryRef {
  readonly skillId: string;
  readonly version: string;
}

export interface EcoEntry {
  readonly skillId: string;
  readonly version: string;
  readonly entryDir: string;
}

/** 解析 <prefix>:<skillId>@<version>；格式非法抛 skill_source_not_found（fail-closed）。 */
export function parseEcoSkillRef(sourceRef: string, prefix: string): EcoEntryRef {
  const marker = `${prefix}:`;
  if (!sourceRef.startsWith(marker)) {
    throw new SkillSourceError("skill_source_not_found", `来源引用不是 ${prefix} 来源：${sourceRef.slice(0, 120)}`);
  }
  const rest = sourceRef.slice(marker.length);
  const at = rest.lastIndexOf("@");
  if (at <= 0 || at === rest.length - 1) {
    throw new SkillSourceError("skill_source_not_found", `${prefix} 来源必须锁定版本：<skillId>@<version>（不支持 latest）`);
  }
  const skillId = rest.slice(0, at);
  const version = rest.slice(at + 1);
  if (skillId.trim() === "" || version.trim() === "") {
    throw new SkillSourceError("skill_source_not_found", `${prefix} 来源引用格式非法：${sourceRef.slice(0, 120)}`);
  }
  if (version.toLowerCase() === "latest") {
    throw new SkillSourceError("skill_source_not_found", `${prefix} 来源不支持 latest 语义：锁定精确版本与内容哈希是安全基线`);
  }
  return { skillId, version };
}

/** 校验镜像目录存在且为常规目录（拒绝符号链接/Junction，fail-closed）。 */
export function requireMirrorDir(mirrorDir: string | undefined, prefix: string): string {
  if (mirrorDir === undefined || mirrorDir.trim() === "") {
    throw new SkillSourceError("skill_source_not_found", `未配置 ${prefix} 市场镜像目录（本地固定版本镜像），无法访问 ${prefix} 市场`);
  }
  const root = path.resolve(mirrorDir);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    throw new SkillSourceError("skill_source_not_found", `${prefix} 镜像目录不存在：${root}（请配置本地固定版本镜像）`);
  }
  if (stat.isSymbolicLink()) {
    throw new SkillSourceError("skill_source_unsupported", `${prefix} 镜像目录不允许是符号链接或 Junction：${root}`);
  }
  if (!stat.isDirectory()) {
    throw new SkillSourceError("skill_source_not_found", `${prefix} 镜像不是目录：${root}`);
  }
  return root;
}

/** 在镜像中解析 sourceRef → 条目目录（精确匹配 <skillId>@<version>）。 */
export function resolveEcoEntry(mirrorDir: string, sourceRef: string, prefix: string): EcoEntry {
  const { skillId, version } = parseEcoSkillRef(sourceRef, prefix);
  const root = requireMirrorDir(mirrorDir, prefix);
  const entryDir = path.join(root, `${skillId}@${version}`);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entryDir);
  } catch {
    throw new SkillSourceError("skill_source_not_found", `${prefix} 镜像中没有锁定版本 ${skillId}@${version}（只接受精确版本，不支持 latest）`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SkillSourceError("skill_source_unsupported", `${prefix} 镜像条目不是常规目录：${skillId}@${version}`);
  }
  return { skillId, version, entryDir };
}

const ECO_ENTRY_NAME = /^([^@\s]+)@(\S+)$/;

/**
 * 转换后形态的轻量 peek（scan/discover 用）：读取 SKILL.md → 文本级转换 →
 * 解析 + 标准化。与 peekSkillManifest 语义一致，但作用于转换后的文本
 * （真实 Hermes 包的块序列映射项在转换前无法被 T2 解析器读取）。
 */
export function peekConvertedEcoManifest(
  packageRoot: string,
  convert: (source: string) => { readonly source: string },
): ManifestPeek {
  const manifestPath = path.join(packageRoot, "SKILL.md");
  let source: string;
  try {
    source = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, name: null, version: null, description: null, manifest: null, error: { reasonCode: "skill_not_a_complete_package", message: "缺少 SKILL.md" } };
  }
  const converted = convert(source);
  const parsed = parseSkillDocument(converted.source);
  if (!parsed.ok) {
    return { ok: false, name: null, version: null, description: null, manifest: null, error: { reasonCode: parsed.reasonCode, message: parsed.reason } };
  }
  const normalized = normalizeSkillManifest(parsed.document.frontmatter, { body: parsed.document.body });
  if (!normalized.ok) {
    return { ok: false, name: null, version: null, description: null, manifest: null, error: { reasonCode: normalized.reasonCode, message: normalized.reason } };
  }
  const rawVersion = normalized.manifest.rawFrontmatter["version"];
  const version = typeof rawVersion === "string" && rawVersion.trim() !== "" ? rawVersion.trim() : null;
  return {
    ok: true,
    name: normalized.manifest.name,
    version,
    description: normalized.manifest.description,
    manifest: normalized.manifest,
    error: null,
  };
}

/** 扫描镜像一层目录：<skillId>@<version>/ 各含 SKILL.md 的条目是一个候选。 */
export function scanEcoMirror(mirrorDir: string | undefined, options: EcosystemMirrorOptions): readonly SkillSourceCandidate[] {
  if (mirrorDir === undefined) {
    return [];
  }
  const root = requireMirrorDir(mirrorDir, options.prefix);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const candidates: SkillSourceCandidate[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) {
      continue;
    }
    const match = ECO_ENTRY_NAME.exec(name);
    if (match === null) {
      continue;
    }
    const skillId = match[1] ?? "";
    const version = match[2] ?? "";
    const entryDir = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      continue;
    }
    const peek =
      options.convertForPeek !== undefined
        ? peekConvertedEcoManifest(entryDir, options.convertForPeek)
        : peekSkillManifest(entryDir);
    if (!peek.ok) {
      continue;
    }
    candidates.push({
      sourceId: `${options.prefix}:${skillId}@${version}`,
      sourceKind: options.sourceKind,
      displayName: peek.name ?? skillId,
      version,
      ...(peek.description !== null ? { description: peek.description } : {}),
      provenance: {
        sourceRef: `${options.prefix}:${skillId}@${version}`,
        fetchedAt: nowIsoTimestamp(),
        originalUrl: options.originalUrlFor(skillId, version),
        ...(peek.manifest?.license !== undefined ? { license: peek.manifest.license } : {}),
      },
    });
  }
  return candidates;
}

/**
 * 把镜像条目放入受控 staging（stagingRoot/package）：
 * 1) 解析并复制条目（只复制，绝不执行任何来源脚本/postinstall）；
 * 2) Hermes 适配器在副本上做 frontmatter 转换（原包不变）；
 * 3) 完整校验 + 确定性哈希；
 * 4) 兼容失败（requiresManualMigration）→ 迁移建议拒绝安装。
 */
export function stageEcoEntry(mirrorDir: string, sourceRef: string, stagingRoot: string, options: EcosystemMirrorOptions): SkillStagedPackage {
  const entry = resolveEcoEntry(mirrorDir, sourceRef, options.prefix);
  const packageRoot = path.join(path.resolve(stagingRoot), "package");
  try {
    copyPackageTree(entry.entryDir, packageRoot, { exclude: [".git"] });
  } catch (error) {
    throw toSkillSourceError(error);
  }
  if (options.rewriteStaged !== undefined) {
    options.rewriteStaged(packageRoot);
  }
  const peek = peekSkillManifest(packageRoot);
  if (!peek.ok || peek.manifest === null) {
    const code = peek.error?.reasonCode ?? "skill_package_invalid";
    throw ecoErrorWithAdvice(options.prefix, code, peek.error?.message ?? "暂存包缺少有效 SKILL.md", null);
  }
  // 兼容边界：requiresManualMigration → 迁移建议拒绝（不生成空壳）
  assertEcoInstallable(options.prefix, peek.manifest.compatibilityReport ?? null);
  try {
    const license = peek.manifest.license;
    return buildStagedPackage(packageRoot, {
      sourceRef,
      originalUrl: options.originalUrlFor(entry.skillId, entry.version),
      ...(license !== undefined ? { license } : {}),
    });
  } catch (error) {
    if (error instanceof SkillSourceError) {
      const isValidation = error.code === "skill_package_invalid" || error.code === "skill_manifest_invalid" || error.code === "skill_binary_denied";
      if (isValidation) {
        throw ecoErrorWithAdvice(options.prefix, error.code, error.message, peek.manifest.compatibilityReport ?? null);
      }
      throw error;
    }
    throw toSkillSourceError(error);
  }
}

/** inspect 镜像条目。Hermes（rewriteStaged）在临时副本上先转换再检查——展示的是
 * "将安装的形态"（含转换后的兼容报告与内容哈希）；镜像原包永不被修改。 */
export function inspectEcoEntry(mirrorDir: string, sourceRef: string, options: EcosystemMirrorOptions): SkillSourceInspection {
  const entry = resolveEcoEntry(mirrorDir, sourceRef, options.prefix);
  if (options.rewriteStaged === undefined) {
    const validation = peekSkillManifest(entry.entryDir);
    if (!validation.ok) {
      throw ecoErrorWithAdvice(options.prefix, validation.error?.reasonCode ?? "skill_package_invalid", validation.error?.message ?? "镜像条目缺少有效 SKILL.md", null);
    }
    return inspectLocalDirectory(entry.entryDir, { version: entry.version });
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-eco-inspect-"));
  try {
    const packageRoot = path.join(tmpRoot, "package");
    copyPackageTree(entry.entryDir, packageRoot, { exclude: [".git"] });
    options.rewriteStaged(packageRoot);
    const inspection = inspectLocalDirectory(packageRoot, { version: entry.version });
    return { ...inspection, sourceRef };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** 锁定版本与内容哈希（Hermes 条目按重写后内容哈希，与 stage 一致）。 */
export function resolveEcoVersion(mirrorDir: string, sourceRef: string, options: EcosystemMirrorOptions): SkillResolvedVersion {
  const entry = resolveEcoEntry(mirrorDir, sourceRef, options.prefix);
  if (options.rewriteStaged !== undefined) {
    const tmpRoot = fs.mkdtempSync(path.join(requireMirrorDir(mirrorDir, options.prefix), ".ocf-tmp-"));
    try {
      const packageRoot = path.join(tmpRoot, "package");
      copyPackageTree(entry.entryDir, packageRoot, { exclude: [".git"] });
      options.rewriteStaged(packageRoot);
      const staged = buildStagedPackage(packageRoot, { sourceRef });
      return { version: entry.version, contentHash: staged.contentHash };
    } catch (error) {
      throw toSkillSourceError(error);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
  const staged = buildStagedPackage(entry.entryDir, { sourceRef });
  return { version: entry.version, contentHash: staged.contentHash };
}
