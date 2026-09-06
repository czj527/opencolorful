// ═══════════════════════════════════════════════════════════════
// Phase 12 插件 import 边界检查（plans/phase-12.md §19.4 / §23）
//
// 约束（plans/phase-12.md §19.1、§21.2）：
// - packages/*（plugin-protocol 及后续 plugin-runtime/sdk/components）
//   不得 import Server 内部实现（src/ 相对路径或包名）；
// - packages/* 不得 import @earendil-works/pi-*（PI SDK 只归 src/pi-sdk）；
// - Server src/ 只允许消费协议类型（@opencolorful/plugin-protocol），
//   不得 import packages/ 的实现细节（dist 深路径）。
// ═══════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const IMPORT_PATTERN = /(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g;

function collectTypeScriptFiles(dir, out = []) {
  // 目录不存在时静默跳过（与 verify-pi-sdk-imports.mjs 一致），
  // 避免扫描无 src/ 的仓库根或插件包时以 ENOENT 崩溃。
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTypeScriptFiles(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 扫描插件包源码的违规 import。
 * @param {string} projectRoot 仓库根目录
 * @returns {string[]} 违规描述列表（空 = 通过）
 */
export function findPluginImportViolations(projectRoot) {
  const violations = [];
  const packagesDir = join(projectRoot, "packages");
  let packageDirs = [];
  try {
    packageDirs = readdirSync(packagesDir)
      .map((name) => join(packagesDir, name))
      .filter((dir) => statSync(dir).isDirectory());
  } catch {
    // 尚无 packages/ 目录时不视为违规
  }
  for (const packageDir of packageDirs) {
    for (const file of collectTypeScriptFiles(join(packageDir, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const spec = match[1];
        const rel = relative(projectRoot, file);
        // 1) 禁止 import Server 内部（相对路径进入 src/）
        if (/^\.\.?\/.*\/src\//.test(spec) || spec.includes(`${sep}src${sep}`)) {
          violations.push(`${rel}: import Server 内部实现 "${spec}"`);
        }
        // 2) 禁止 import PI SDK（只归 src/pi-sdk）
        if (spec.startsWith("@earendil-works/")) {
          violations.push(`${rel}: import PI SDK "${spec}"（插件包不得依赖 PI SDK）`);
        }
        // 3) 禁止 import 其他 packages 的 dist 深路径（协议只通过包名消费）
        if (spec.startsWith("@opencolorful/") && spec.includes("/dist/")) {
          violations.push(`${rel}: import 协议包 dist 深路径 "${spec}"（应使用包名）`);
        }
      }
    }
  }
  // Server src/ 不得 import 协议包 dist 深路径（应走 src/contracts/plugin-protocol.ts 的包名）
  for (const file of collectTypeScriptFiles(join(projectRoot, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const spec = match[1];
      if (spec.startsWith("@opencolorful/") && spec.includes("/dist/")) {
        violations.push(`${relative(projectRoot, file)}: import 协议包 dist 深路径 "${spec}"`);
      }
    }
  }
  return violations;
}

// CLI 入口判断：仅当本模块作为脚本被直接执行时才运行扫描
// （比较 argv[1] 的 file URL 与本模块 URL；此前误比磁盘路径与 file:// 字符串，恒为假）。
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const violations = findPluginImportViolations(projectRoot);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exitCode = 1;
  } else {
    console.log("verify-plugin-imports: OK（插件包 import 边界无违规）");
  }
}
