import fs from "node:fs";
import path from "node:path";

import type {
  NormalizedSkillManifest,
  SkillCompatibilityReport,
  SkillProvenance,
  SkillSourceAdapterKind,
  SkillSourceCandidate,
  SkillSourceCapabilities,
  SkillSourceKind,
  SkillStagedPackage,
} from "../../../contracts/skill-protocol.js";
import { SkillSourceError } from "../errors.js";
import { peekSkillManifest, validateSkillPackage, type ManifestPeek, type SkillPackageErrorInfo } from "../validator.js";

// 供 Catalog/编排层复用冻结形状（discover 的返回元素）。
export type { SkillSourceCandidate, SkillSourceCapabilities } from "../../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 统一 SkillSourceAdapter（plans/phase-13.md §8.3）
//
// - discover(query, scope)：搜索候选，不安装；T2 只做本地/静态部分；
// - inspect(sourceRef)：读取 provenance、Manifest/frontmatter、依赖与风险摘要；
// - stage(sourceRef)：T3 安装器实现（T2 一律抛 skill_source_unsupported）；
// - resolveVersion(sourceRef)：固定版本与内容哈希；
// - capabilities()：声明搜索/安装/更新/离线能力（SkillSourceCapabilities）。
//
// 五类 catalog sourceKind（builtin/managed/plugin/workspace/external）由各适配器
// 的 discover 产生；git/http/openclaw/hermes 骨架放 T3/T9。
// ═══════════════════════════════════════════════════════════════

export interface SkillSourceDiscoveryScope {
  /** 限定扫描根目录（workspace 的 cwd / external 的来源目录） */
  readonly baseDir?: string;
}

/** inspect 结果：provenance + 已标准化 Manifest + 依赖/风险摘要（含失败诊断）。 */
export interface SkillSourceInspection {
  readonly sourceRef: string;
  readonly packageRoot: string;
  readonly manifest: NormalizedSkillManifest | null;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly errors: readonly SkillPackageErrorInfo[];
}

export interface SkillResolvedVersion {
  readonly version: string;
  readonly contentHash: string;
}

export interface SkillSourceAdapter {
  readonly kind: SkillSourceAdapterKind;
  /** 搜索候选（不安装）；扫描失败抛 SkillSourceError，不静默降级 */
  discover(query?: string, scope?: SkillSourceDiscoveryScope): readonly SkillSourceCandidate[];
  /** 读取 provenance / Manifest / 依赖与风险摘要 */
  inspect(sourceRef: string): SkillSourceInspection;
  /** 将完整 package 放入受控 staging（T3 实现；T2 未实现时抛 skill_source_unsupported） */
  stage(sourceRef: string): SkillStagedPackage;
  /** 固定版本与内容哈希 */
  resolveVersion(sourceRef: string): SkillResolvedVersion;
  /** 能力声明（搜索/安装/更新/离线） */
  capabilities(): SkillSourceCapabilities;
}

export function assertAdapterSupported(adapter: SkillSourceAdapter | undefined, kind: SkillSourceAdapterKind): asserts adapter is SkillSourceAdapter {
  if (adapter === undefined) {
    throw new SkillSourceError("skill_source_unsupported", `来源适配器不受支持：${kind}`);
  }
}

/** discover 返回的富候选：candidate（冻结形状）+ 包根目录 + 已定版本 + 轻量 peek。 */
export interface DiscoveredCandidate {
  readonly candidate: SkillSourceCandidate;
  /** 完整包根目录（注册/校验用） */
  readonly rootPath: string;
  readonly version: string;
  readonly peek: ManifestPeek;
}

/** 本地目录扫描基类选项：适配器通过 sourceId/version 映射定制各自语义。 */
export interface LocalDirectoryScanOptions {
  readonly sourceKind: SkillSourceKind;
  /** 候选稳定标识（本地适配器可复用为 sourceRef） */
  readonly sourceId: (rootPath: string, dirName: string) => string;
  /** 版本解析（缺省取 frontmatter version） */
  readonly versionFor?: (dirName: string, peek: ManifestPeek) => string;
  /** 无 frontmatter version 时的默认版本 */
  readonly defaultVersion: string;
  /** 目录名过滤（如跳过隐藏目录） */
  readonly filter?: (dirName: string) => boolean;
  readonly buildProvenance: (rootPath: string) => SkillProvenance;
}

/**
 * 一层目录扫描：baseDir 下每个含 SKILL.md 的子目录是一个 Skill 包。
 * 损坏/缺 SKILL.md 的条目跳过（发现期不抛错，inspect 阶段给完整诊断）。
 */
export function scanPackagesInDirectory(baseDir: string, options: LocalDirectoryScanOptions): readonly DiscoveredCandidate[] {
  const root = path.resolve(baseDir);
  const results: DiscoveredCandidate[] = [];
  let entries: string[];
  try {
    entries = requireDirectory(root);
  } catch {
    return results;
  }
  for (const dirName of entries) {
    if (options.filter !== undefined && !options.filter(dirName)) {
      continue;
    }
    const packageRoot = path.join(root, dirName);
    const peek = peekSkillManifest(packageRoot);
    if (!peek.ok) {
      continue;
    }
    const version = options.versionFor !== undefined ? options.versionFor(dirName, peek) : (peek.version ?? options.defaultVersion);
    const candidate: SkillSourceCandidate = {
      sourceId: options.sourceId(packageRoot, dirName),
      sourceKind: options.sourceKind,
      displayName: peek.name ?? dirName,
      version,
      ...(peek.description !== null ? { description: peek.description } : {}),
      provenance: options.buildProvenance(packageRoot),
    };
    results.push({ candidate, rootPath: packageRoot, version, peek });
  }
  return results;
}

/** 一层目录扫描 + query 过滤（名称/目录名不区分大小写匹配）。 */
export function scanPackagesInDirectoryWithQuery(
  baseDir: string,
  query: string | undefined,
  options: LocalDirectoryScanOptions,
): readonly DiscoveredCandidate[] {
  const needle = (query ?? "").trim().toLowerCase();
  const all = scanPackagesInDirectory(baseDir, options);
  if (needle === "") {
    return all;
  }
  return all.filter(
    (found) =>
      found.candidate.displayName.toLowerCase().includes(needle) || found.candidate.sourceId.toLowerCase().includes(needle),
  );
}

/** inspect 本地目录包：完整校验 + 内容哈希（sourceRef 即包根目录绝对路径）。 */
export function inspectLocalDirectory(sourceRef: string, options: { readonly version?: string } = {}): SkillSourceInspection {
  const packageRoot = path.resolve(sourceRef);
  const validation = validateSkillPackage({ packageRoot, ...(options.version !== undefined ? { version: options.version } : {}) });
  return {
    sourceRef,
    packageRoot,
    manifest: validation.manifest,
    compatibility: validation.compatibility,
    contentHash: validation.contentHash ?? "",
    sizeBytes: validation.sizeBytes,
    fileCount: validation.fileCount,
    errors: validation.errors,
  };
}

/** 校验 baseDir 存在且为目录（拒绝符号链接/Junction），返回条目名列表（fail-closed）。 */
export function requireDirectory(root: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    throw new SkillSourceError("skill_source_not_found", `来源目录不存在：${root}`);
  }
  if (stat.isSymbolicLink()) {
    throw new SkillSourceError("skill_source_unsupported", `来源目录不允许是符号链接或 Junction：${root}`);
  }
  if (!stat.isDirectory()) {
    throw new SkillSourceError("skill_source_not_found", `来源不是目录：${root}`);
  }
  return fs.readdirSync(root);
}

/** 本地来源时间戳（provenance.fetchedAt）。 */
export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}
