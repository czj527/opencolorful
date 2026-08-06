import fs from "node:fs";
import path from "node:path";

import { SkillError } from "./errors.js";
import { computeSkillContentHash } from "./hash.js";
import { slugifySkillId } from "./manifest.js";
import { peekSkillManifest } from "./validator.js";
import { assertSkillZipTarget, writeSkillZipFile } from "./zip-builder.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 `skills pack`（plans/phase-13.md §14.3 / §15.1）
//
// - 先完整校验（复用 T2 validator），再生成 .skill（ZIP）包；
// - 输出内容哈希 = 包目录确定性哈希（与 Managed Store 安装校验同源，
//   `skills pack` 产出的哈希与 `skills validate` 一致）；
// - 纯文件操作（不经过 Server），与安装/绑定逻辑严格分离。
// ═══════════════════════════════════════════════════════════════

export interface PackSkillResult {
  readonly zipPath: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly skillId: string;
  readonly version: string;
  readonly name: string;
}

/**
 * 校验并打包 Skill 目录为 .skill 文件。
 * - packageRoot：Skill 包根目录（必须含 SKILL.md）；
 * - targetZipPath：输出 .zip/.skill 文件（缺省 `<cwd>/<skillId>-<version>.skill`）。
 */
export function packSkillPackage(packageRootInput: string, targetZipPath?: string): PackSkillResult {
  const packageRoot = path.resolve(packageRootInput);
  const peek = peekSkillManifest(packageRoot);
  if (!peek.ok) {
    throw new SkillError(peek.error?.reasonCode ?? "skill_not_a_complete_package", peek.error?.message ?? "Skill 包缺少有效 SKILL.md");
  }
  const version = peek.version ?? "0.0.0";
  const skillId = slugifySkillId(peek.manifest?.name ?? peek.name ?? "skill");
  const contentHash = computeSkillContentHash(packageRoot, { version, exclude: [".git"] });

  const zipPath = targetZipPath ?? defaultZipName(skillId, version);
  assertSkillZipTarget(zipPath);
  const built = writeSkillZipFile(packageRoot, zipPath, { exclude: [".git"] });
  return {
    zipPath: path.resolve(zipPath),
    contentHash,
    sizeBytes: built.sizeBytes,
    fileCount: built.fileCount,
    skillId,
    version,
    name: peek.manifest?.name ?? peek.name ?? "skill",
  };
}

function defaultZipName(skillId: string, version: string): string {
  return path.join(process.cwd(), `${skillId}-${version}.skill`);
}

/** 便捷：把已生成的目标文件写入校验（存在性 + 非空）。 */
export function assertPackOutputExists(zipPath: string): void {
  const stat = fs.lstatSync(zipPath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    throw new SkillError("skill_package_invalid", `打包输出文件不存在：${zipPath}`);
  }
  if (stat.size === 0) {
    throw new SkillError("skill_package_invalid", `打包输出文件为空：${zipPath}`);
  }
}
