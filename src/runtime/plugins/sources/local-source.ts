import fs from "node:fs";
import path from "node:path";

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
// Local Source Adapter：本地目录（含原生 manifest.json）。
// ref = 本地目录绝对路径；baseDir 用于 search（扫描一层子目录）。
// ═══════════════════════════════════════════════════════════════

export class LocalSourceAdapter implements PluginSourceAdapter {
  readonly sourceType = "local" as const;

  constructor(private readonly options: { readonly baseDir?: string } = {}) {}

  private requireLocalDir(ref: string): string {
    const resolved = path.resolve(ref);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SourceResolveError("local_dir_missing", "本地插件目录不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new SourceResolveError("local_dir_symlink", "本地插件目录不允许是符号链接或 Junction");
    }
    if (!stat.isDirectory()) {
      throw new SourceResolveError("local_dir_not_dir", "本地来源不是目录");
    }
    return resolved;
  }

  search(query: string): readonly SourceSearchResult[] {
    const baseDir = this.options.baseDir;
    if (baseDir === undefined) {
      return [];
    }
    const root = this.requireLocalDir(baseDir);
    const needle = query.trim().toLowerCase();
    const results: SourceSearchResult[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(root, entry.name);
      const manifestPath = path.join(candidate, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
      } catch {
        continue; // 跳过损坏条目
      }
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const manifest = raw as Record<string, unknown>;
      if (typeof manifest.id !== "string" || typeof manifest.name !== "string") {
        continue;
      }
      const id = manifest.id;
      const name = manifest.name;
      if (needle !== "" && !name.toLowerCase().includes(needle) && !id.toLowerCase().includes(needle)) {
        continue;
      }
      const version = typeof manifest.version === "string" ? manifest.version : null;
      results.push({
        id,
        name,
        version,
        sourceType: "local",
        ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
      });
    }
    return results;
  }

  resolve(sourceRef: PluginSourceRef): ResolvedSource {
    const ref = assertPluginSourceRef(sourceRef);
    const dir = this.requireLocalDir(ref.ref);
    const raw = readManifestFile(dir);
    const version = manifestVersion(raw);
    return { sourceType: "local", ref: dir, version, lock: null, metadata: { manifest: raw } };
  }

  listVersions(sourceRef: PluginSourceRef): readonly SourceVersionInfo[] {
    const resolved = this.resolve(sourceRef);
    return resolved.version === null ? [] : [{ version: resolved.version, lock: null }];
  }

  fetchArtifact(sourceRef: PluginSourceRef, _options?: { readonly stagingDir?: string }): FetchedArtifact {
    const ref = assertPluginSourceRef(sourceRef);
    const dir = this.requireLocalDir(ref.ref);
    const raw = readManifestFile(dir);
    const version = manifestVersion(raw);
    if (version === null) {
      throw new SourceIntegrityError("manifest_version_missing", "插件 manifest 缺少 version");
    }
    if (ref.version !== undefined && ref.version !== version) {
      throw new SourceResolveError("version_mismatch", "请求版本与插件实际版本不一致");
    }
    return { sourceType: "local", ref: dir, version, lock: null, contentRoot: dir, metadata: { manifest: raw } };
  }

  verifyArtifact(artifact: FetchedArtifact): ArtifactVerification {
    return computeArtifactHash(artifact.contentRoot);
  }

  readProvenance(artifact: FetchedArtifact): unknown {
    return { sourceType: "local", ref: artifact.ref, manifest: readManifestFile(artifact.contentRoot) };
  }
}
