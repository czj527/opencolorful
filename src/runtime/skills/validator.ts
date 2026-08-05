import fs from "node:fs";
import path from "node:path";

import { SKILL_BUDGETS, type NormalizedSkillManifest, type SkillCompatibilityReport, type SkillErrorCode } from "../../contracts/skill-protocol.js";
import { parseSkillDocument } from "./frontmatter.js";
import { computeSkillContentHash } from "./hash.js";
import { normalizeSkillManifest } from "./manifest.js";
import { SkillPathError, walkSafeFiles, type SafeFileEntry } from "./path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Skill 包结构与完整性校验（plans/phase-13.md §7.3）
//
// - 只接受完整 package（根目录必须含 SKILL.md，且带 frontmatter）；
// - 单文件大小上限取自 SKILL_BUDGETS.maxSingleFileBytes；总大小/文件数为
//   本阶段自有预算（冻结预算未覆盖总包大小，见 SKILL_PACKAGE_LIMITS 注释）；
// - canonical path / symlink / 非法文件类型 / 大小超限直接拒绝（fail-closed）；
// - 内容哈希确定性（路径 + 内容 + 版本），frontmatter 作为 SKILL.md 内容参与；
// - 校验结果以显式错误数组表达，不允许用 undefined/空成功表示"已通过"。
// ═══════════════════════════════════════════════════════════════

export interface SkillPackageLimits {
  /** 单文件大小上限（字节）；沿用 SKILL_BUDGETS.maxSingleFileBytes */
  readonly maxFileBytes: number;
  /** 整包总大小上限（字节）；冻结预算未覆盖，本阶段定义 32MB */
  readonly maxPackageBytes: number;
  /** 包内文件数上限 */
  readonly maxFiles: number;
  /** 允许的扩展名（无扩展名文件放行，常见 LICENSE/README） */
  readonly allowedExtensions: readonly string[];
}

export const DENIED_SKILL_FILE_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".node", ".jar", ".wasm", ".o", ".obj", ".class", ".app", ".msi", ".deb",
  ".rpm", ".apk", ".a", ".lib", ".pyc", ".pyd", ".whl", ".egg",
]);

export const ALLOWED_SKILL_FILE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".csv", ".tsv",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".pdf",
  ".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts",
  ".hbs", ".mustache", ".liquid", ".jinja", ".jinja2", ".tmpl", ".ipynb",
]);

export const DEFAULT_SKILL_PACKAGE_LIMITS: SkillPackageLimits = {
  maxFileBytes: SKILL_BUDGETS.maxSingleFileBytes,
  maxPackageBytes: 32 * 1024 * 1024,
  maxFiles: 4096,
  allowedExtensions: [...ALLOWED_SKILL_FILE_EXTENSIONS],
};

export interface SkillPackageErrorInfo {
  readonly reasonCode: SkillErrorCode;
  readonly message: string;
  readonly path?: string;
}

export interface SkillPackageValidationResult {
  readonly ok: boolean;
  readonly manifest: NormalizedSkillManifest | null;
  readonly compatibility: SkillCompatibilityReport | null;
  readonly contentHash: string | null;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly errors: readonly SkillPackageErrorInfo[];
  readonly warnings: readonly string[];
}

export interface ValidateSkillPackageInput {
  readonly packageRoot: string;
  /** 版本参与哈希（Managed Store 用版本目录名） */
  readonly version?: string;
  readonly limits?: Partial<SkillPackageLimits>;
  readonly exclude?: readonly string[];
}

/**
 * 完整包校验：目录结构 + 完整性 + frontmatter 标准化 + 确定性哈希。
 * 任一硬性错误 → ok=false 且 errors 非空（fail-closed）。
 */
export function validateSkillPackage(input: ValidateSkillPackageInput): SkillPackageValidationResult {
  const limits: SkillPackageLimits = { ...DEFAULT_SKILL_PACKAGE_LIMITS, ...(input.limits ?? {}) };
  const errors: SkillPackageErrorInfo[] = [];
  const warnings: string[] = [];

  const root = path.resolve(input.packageRoot);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    return failResult([{ reasonCode: "skill_package_invalid", message: `Skill 包根目录不存在：${root}` }]);
  }
  if (rootStat.isSymbolicLink()) {
    return failResult([{ reasonCode: "skill_symlink_escape", message: "Skill 包根目录不允许是符号链接或 Junction" }]);
  }
  if (!rootStat.isDirectory()) {
    return failResult([{ reasonCode: "skill_package_invalid", message: "Skill 包根目录不是目录" }]);
  }

  const manifestPath = path.join(root, "SKILL.md");
  try {
    const manifestStat = fs.lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink()) {
      errors.push({ reasonCode: "skill_symlink_escape", message: "SKILL.md 不允许是符号链接或 Junction", path: "SKILL.md" });
    } else if (!manifestStat.isFile()) {
      errors.push({ reasonCode: "skill_not_a_complete_package", message: "SKILL.md 不是常规文件" });
    }
  } catch {
    errors.push({ reasonCode: "skill_not_a_complete_package", message: "缺少 SKILL.md（不接受裸 skill_content 冒充完整 Skill）" });
  }

  let entries: readonly SafeFileEntry[] = [];
  try {
    entries = walkSafeFiles(root, { ...(input.exclude !== undefined ? { exclude: input.exclude } : {}) });
  } catch (error) {
    if (error instanceof SkillPathError) {
      errors.push({ reasonCode: error.reasonCode, message: error.message });
    } else {
      errors.push({ reasonCode: "skill_package_invalid", message: `包遍历失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  let sizeBytes = 0;
  for (const entry of entries) {
    if (entry.sizeBytes > limits.maxFileBytes) {
      errors.push({
        reasonCode: "skill_too_large",
        message: `单文件超过上限（${limits.maxFileBytes} 字节）`,
        path: entry.rel,
      });
    }
    const extension = path.extname(entry.rel).toLowerCase();
    if (extension !== "" && DENIED_SKILL_FILE_EXTENSIONS.has(extension)) {
      errors.push({ reasonCode: "skill_binary_denied", message: `禁止的二进制/可执行文件类型：${extension}`, path: entry.rel });
    } else if (extension !== "" && !limits.allowedExtensions.includes(extension)) {
      errors.push({ reasonCode: "skill_file_type_denied", message: `非法文件类型：${extension}`, path: entry.rel });
    }
    sizeBytes += entry.sizeBytes;
  }
  if (sizeBytes > limits.maxPackageBytes) {
    errors.push({ reasonCode: "skill_too_large", message: `整包超过总大小上限（${limits.maxPackageBytes} 字节）` });
  }
  if (entries.length > limits.maxFiles) {
    errors.push({ reasonCode: "skill_too_large", message: `包内文件数超过上限（${limits.maxFiles}）` });
  }

  // frontmatter + manifest（SKILL.md 存在且为常规文件才解析）
  let manifest: NormalizedSkillManifest | null = null;
  if (!errors.some((error) => error.path === "SKILL.md")) {
    try {
      const source = fs.readFileSync(manifestPath, "utf8");
      const parsed = parseSkillDocument(source);
      if (!parsed.ok) {
        errors.push({ reasonCode: parsed.reasonCode, message: parsed.reason, path: "SKILL.md" });
      } else {
        const normalized = normalizeSkillManifest(parsed.document.frontmatter, { body: parsed.document.body });
        if (!normalized.ok) {
          errors.push({ reasonCode: normalized.reasonCode, message: normalized.reason, path: "SKILL.md" });
          warnings.push(...normalized.issues);
        } else {
          manifest = normalized.manifest;
          warnings.push(...normalized.issues);
        }
      }
    } catch (error) {
      errors.push({
        reasonCode: "skill_manifest_invalid",
        message: `SKILL.md 读取失败：${error instanceof Error ? error.message : String(error)}`,
        path: "SKILL.md",
      });
    }
  }

  // 内容哈希（路径 + 内容 + 版本；失败仅影响无效包的记录，不影响错误收集）
  let contentHash: string | null = null;
  try {
    contentHash = computeSkillContentHash(root, {
      ...(input.exclude !== undefined ? { exclude: input.exclude } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
  } catch {
    if (errors.length === 0) {
      errors.push({ reasonCode: "skill_package_invalid", message: "内容哈希计算失败（包内容不可读）" });
    }
  }

  return {
    ok: errors.length === 0,
    manifest,
    compatibility: manifest?.compatibilityReport ?? null,
    contentHash,
    sizeBytes,
    fileCount: entries.length,
    errors,
    warnings,
  };
}

function failResult(errors: readonly SkillPackageErrorInfo[]): SkillPackageValidationResult {
  return {
    ok: false,
    manifest: null,
    compatibility: null,
    contentHash: null,
    sizeBytes: 0,
    fileCount: 0,
    errors,
    warnings: [],
  };
}

export interface ManifestPeek {
  readonly ok: boolean;
  readonly name: string | null;
  readonly version: string | null;
  readonly description: string | null;
  readonly manifest: NormalizedSkillManifest | null;
  readonly error: SkillPackageErrorInfo | null;
}

/** 轻量读取：只解析 SKILL.md 的 name/version/description（discover 用，不做完整校验）。 */
export function peekSkillManifest(packageRoot: string): ManifestPeek {
  const manifestPath = path.join(packageRoot, "SKILL.md");
  let source: string;
  try {
    source = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, name: null, version: null, description: null, manifest: null, error: { reasonCode: "skill_not_a_complete_package", message: "缺少 SKILL.md" } };
  }
  const parsed = parseSkillDocument(source);
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
