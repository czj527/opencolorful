import fs from "node:fs";
import path from "node:path";

import { safeJoin } from "../paths.js";
import {
  SourceIntegrityError,
  SourceResolveError,
  assertPluginSourceRef,
  computeArtifactHash,
  manifestVersion,
  readManifestFile,
  type ArtifactVerification,
  type FetchedArtifact,
  type PluginSourceAdapter,
  type PluginSourceRef,
  type ResolvedSource,
  type SourceSearchResult,
  type SourceVersionInfo,
} from "./source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// npm-compatible Source Adapter：本地包目录（含 package.json）。
//
// - ref 可以是本地包目录路径，或 `包名` / `包名@版本`（registryRoot 内解析）；
// - 必须固定版本（ref.version / package.json.version 二选一），禁止 latest；
// - 内容根目录同时含 package.json（npm 契约）与可选 manifest.json（原生插件）。
// ═══════════════════════════════════════════════════════════════

interface NpmPackageInfo {
  readonly name: string;
  readonly version: string;
}

export class NpmSourceAdapter implements PluginSourceAdapter {
  readonly sourceType = "npm" as const;

  constructor(private readonly options: { readonly registryRoot?: string } = {}) {}

  private requirePackageDir(ref: string): string {
    const resolved = path.resolve(ref);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SourceResolveError("npm_package_missing", "npm 包目录不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new SourceResolveError("npm_package_symlink", "npm 包目录不允许是符号链接或 Junction");
    }
    if (!stat.isDirectory()) {
      throw new SourceResolveError("npm_package_not_dir", "npm 来源不是目录");
    }
    if (!fs.existsSync(path.join(resolved, "package.json"))) {
      throw new SourceResolveError("npm_package_json_missing", "npm 来源缺少 package.json");
    }
    return resolved;
  }

  private readPackage(dir: string): NpmPackageInfo {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as unknown;
    } catch {
      throw new SourceIntegrityError("npm_package_json_invalid", "package.json 不是合法 JSON");
    }
    if (typeof raw !== "object" || raw === null) {
      throw new SourceIntegrityError("npm_package_json_invalid", "package.json 不是合法 JSON");
    }
    const pkg = raw as Record<string, unknown>;
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
      throw new SourceIntegrityError("npm_package_fields_missing", "package.json 缺少 name/version");
    }
    return { name: pkg.name, version: pkg.version };
  }

  private parseSpec(ref: string): { dir: string; name?: string } {
    if (path.isAbsolute(ref) || fs.existsSync(path.resolve(ref))) {
      return { dir: path.resolve(ref) };
    }
    const atIndex = ref.lastIndexOf("@");
    if (atIndex > 0) {
      const name = ref.slice(0, atIndex);
      const version = ref.slice(atIndex + 1);
      if (name.length > 0 && /^[0-9]/.test(version)) {
        const registryRoot = this.options.registryRoot;
        if (registryRoot === undefined) {
          throw new SourceResolveError("npm_registry_missing", "npm 包名来源需要 registryRoot");
        }
        return { dir: safeJoin(registryRoot, name), name };
      }
    }
    const registryRoot = this.options.registryRoot;
    if (registryRoot === undefined) {
      throw new SourceResolveError("npm_registry_missing", "npm 包名来源需要 registryRoot");
    }
    return { dir: safeJoin(registryRoot, ref), name: ref };
  }

  search(query: string): readonly SourceSearchResult[] {
    const registryRoot = this.options.registryRoot;
    if (registryRoot === undefined || !fs.existsSync(registryRoot)) {
      return [];
    }
    const needle = query.trim().toLowerCase();
    const results: SourceSearchResult[] = [];
    for (const entry of fs.readdirSync(registryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packagePath = path.join(registryRoot, entry.name, "package.json");
      if (!fs.existsSync(packagePath)) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(packagePath, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const pkg = raw as Record<string, unknown>;
      if (typeof pkg.name !== "string") {
        continue;
      }
      const name = pkg.name;
      if (needle !== "" && !name.toLowerCase().includes(needle)) {
        continue;
      }
      const version = typeof pkg.version === "string" ? pkg.version : null;
      results.push({
        id: name,
        name,
        version,
        sourceType: "npm",
        ...(typeof pkg.description === "string" ? { description: pkg.description } : {}),
      });
    }
    return results;
  }

  resolve(sourceRef: PluginSourceRef): ResolvedSource {
    const ref = assertPluginSourceRef(sourceRef);
    const { dir } = this.parseSpec(ref.ref);
    const packageDir = this.requirePackageDir(dir);
    const pkg = this.readPackage(packageDir);
    if (ref.version !== undefined && ref.version !== pkg.version) {
      throw new SourceResolveError("npm_version_mismatch", "请求版本与 package.json 版本不一致");
    }
    return {
      sourceType: "npm",
      ref: packageDir,
      version: pkg.version,
      lock: null,
      metadata: { package: pkg },
    };
  }

  listVersions(sourceRef: PluginSourceRef): readonly SourceVersionInfo[] {
    const resolved = this.resolve(sourceRef);
    return resolved.version === null ? [] : [{ version: resolved.version, lock: null }];
  }

  fetchArtifact(sourceRef: PluginSourceRef, _options?: { readonly stagingDir?: string }): FetchedArtifact {
    const ref = assertPluginSourceRef(sourceRef);
    const { dir } = this.parseSpec(ref.ref);
    const packageDir = this.requirePackageDir(dir);
    const pkg = this.readPackage(packageDir);
    if (ref.version !== undefined && ref.version !== pkg.version) {
      throw new SourceResolveError("npm_version_mismatch", "请求版本与 package.json 版本不一致");
    }
    // npm 来源同样要求原生 manifest.json（否则无法进入安装流水线）
    const raw = readManifestFile(packageDir);
    const version = manifestVersion(raw);
    if (version === null) {
      throw new SourceIntegrityError("manifest_version_missing", "插件 manifest 缺少 version");
    }
    if (version !== pkg.version) {
      throw new SourceResolveError("npm_manifest_mismatch", "manifest 版本与 package.json 版本不一致");
    }
    return {
      sourceType: "npm",
      ref: packageDir,
      version,
      lock: null,
      contentRoot: packageDir,
      metadata: { package: pkg, manifest: raw },
    };
  }

  verifyArtifact(artifact: FetchedArtifact): ArtifactVerification {
    return computeArtifactHash(artifact.contentRoot, { exclude: [".git", "node_modules"] });
  }

  readProvenance(artifact: FetchedArtifact): unknown {
    return {
      sourceType: "npm",
      ref: artifact.ref,
      package: this.readPackage(artifact.contentRoot),
      manifest: readManifestFile(artifact.contentRoot),
    };
  }
}
