import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../config/paths.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 插件路径守卫与受控文件操作（plans/phase-12.md §7.2）
//
// - 所有插件用户数据目录由 src/config/paths.ts 统一生成，本模块只做派生与守卫；
// - 安装 Artifact 版本目录不可原地修改：pluginVersionDir 只被安装器在
//   安装/更新时写入，更新通过新版本目录 + active 切换（registry）；
// - staging 解包、ZIP 解包、Git checkout 与插件数据目录全部经过
//   canonical path、symlink/Junction 检查与目录包含判定；
// - 解包/复制一律拒绝符号链接（含 Windows Junction），防止越权文件访问；
// - canonical 判定与 src/sandbox/path-guard.ts 的 resolveCanonical 同模式。
// ═══════════════════════════════════════════════════════════════

export class PluginPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginPathError";
  }
}

/**
 * 归档/相对路径条目的安全校验：拒绝绝对路径、UNC 路径、盘符与父目录穿越
 * （ZIP Slip 第一道防线）。配合 isPathWithinRoot 的 canonical 判定完成第二道防线。
 */
export function assertSafeRelativeEntry(entry: string): void {
  if (entry.length === 0) {
    throw new PluginPathError("归档条目名称为空");
  }
  if (entry.includes("\0")) {
    throw new PluginPathError("归档条目名称包含非法字符");
  }
  if (path.isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry) || /^\\\\/.test(entry)) {
    throw new PluginPathError("归档条目使用了绝对路径，已拒绝");
  }
  const normalized = entry.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new PluginPathError("归档条目包含父目录穿越（ZIP Slip），已拒绝");
    }
  }
}

/**
 * canonical 路径：解析符号链接/Junction；路径不存在时向上回溯最近存在的祖先
 * 再拼接剩余相对路径（与 src/sandbox/path-guard.ts 的 resolveCanonical 同模式）。
 */
export function canonicalPathSync(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let current = resolved;
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      try {
        const realParent = fs.realpathSync.native(parent);
        return path.join(realParent, path.relative(parent, resolved));
      } catch {
        current = parent;
      }
    }
  }
}

/** 判断 candidate 是否位于 root（含 root 自身）内；两端都 canonical 后比较。 */
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const canonical = canonicalPathSync(path.resolve(candidate));
  const canonicalRoot = canonicalPathSync(path.resolve(root));
  const within = (base: string, target: string): boolean => {
    const relative = path.relative(base, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  if (process.platform === "win32") {
    return within(canonicalRoot.toLowerCase(), canonical.toLowerCase());
  }
  return within(canonicalRoot, canonical);
}

export function assertPathWithinRoot(candidate: string, root: string, what = "路径"): void {
  if (!isPathWithinRoot(candidate, root)) {
    throw new PluginPathError(`${what} 不在受控目录内，已拒绝`);
  }
}

/** 安全拼接：解析后必须仍位于 root 内（插件 id/版本做路径段前的第二道防线）。 */
export function safeJoin(root: string, ...segments: string[]): string {
  const joined = path.join(root, ...segments);
  assertPathWithinRoot(joined, root, "拼接路径");
  return joined;
}

/**
 * 拒绝符号链接/Junction（Windows Junction 在 Node 的 lstat 中报告为 symbolic link）。
 */
export function assertNotSymlinkOrJunction(target: string, what = "路径"): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new PluginPathError(`${what} 不允许是符号链接或 Junction，已拒绝`);
  }
}

/**
 * 受控目录复制：逐项 lstat，拒绝符号链接/Junction 与非常规文件类型，
 * 目标路径始终校验在 dest 根内（防止源目录内已有恶意嵌套）。.git 目录按需排除。
 */
export function copyTreeSafe(
  source: string,
  destination: string,
  options: { readonly exclude?: readonly string[] } = {},
): void {
  const root = path.resolve(destination);
  const sourceRoot = path.resolve(source);
  fs.mkdirSync(root, { recursive: true });
  const exclude = new Set((options.exclude ?? []).map((name) => name.replace(/\\/g, "/")));
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new PluginPathError("插件内容包含符号链接或 Junction，已拒绝");
    }
    const relative = path.relative(sourceRoot, current).replace(/\\/g, "/");
    if (relative !== "" && exclude.has(relative)) {
      continue;
    }
    if (stat.isDirectory()) {
      const targetDir = relative === "" ? root : safeJoin(root, relative);
      fs.mkdirSync(targetDir, { recursive: true });
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      const targetFile = relative === "" ? safeJoin(root, path.basename(current)) : safeJoin(root, relative);
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(current, targetFile);
    } else {
      throw new PluginPathError("插件内容包含非常规文件类型，已拒绝");
    }
  }
}

// ── 插件路径派生（调用方不得自行拼接用户数据目录） ─────────────

/** plugins/installed/<pluginId>：某插件的全部不可变版本目录根。 */
export function pluginInstalledRoot(paths: RuntimePaths, pluginId: string): string {
  return safeJoin(paths.pluginsInstalled, pluginId);
}

/** plugins/installed/<pluginId>/<version>：不可变安装 Artifact 版本目录。 */
export function pluginVersionDir(paths: RuntimePaths, pluginId: string, version: string): string {
  return safeJoin(paths.pluginsInstalled, pluginId, version);
}

/** plugins/staging/<operationId>：安装/更新暂存区。 */
export function pluginStagingDir(paths: RuntimePaths, operationId: string): string {
  return safeJoin(paths.pluginsStaging, operationId);
}

/** plugins/data/<pluginId>：插件业务数据目录（卸载默认保留）。 */
export function pluginDataDir(paths: RuntimePaths, pluginId: string): string {
  return safeJoin(paths.pluginsData, pluginId);
}
