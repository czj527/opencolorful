import fs from "node:fs";
import path from "node:path";

import {
  SourceIntegrityError,
  SourceResolveError,
  assertPluginSourceRef,
  computeArtifactHash,
  type ArtifactVerification,
  type FetchedArtifact,
  type PluginSourceAdapter,
  type PluginSourceRef,
  type ResolvedSource,
  type SourceSearchResult,
  type SourceVersionInfo,
} from "./source-adapter.js";
import {
  detectHermesPluginDir,
  HERMES_MANIFEST_FILE,
  readHermesPluginDir,
  type HermesPluginDescriptor,
} from "../compat/hermes-compat.js";

// ═══════════════════════════════════════════════════════════════
// Hermes Source Adapter（plans/phase-12.md §12.4）
//
// - 识别 Hermes 插件目录（plugin.yaml + Python 入口）；
//   sourceRef.sourceType = "hermes"；
// - 只负责发现、解析、获取 Artifact 与返回元数据/provenance，
//   不直接启用或执行插件（Source Adapter 与 Runtime Adapter 分离）；
// - 离线优先：ref 指向本地固定 fixture/目录，禁止测试访问真实 Hermes 仓库；
// - 版本来自 plugin.yaml（固定 SemVer），不支持 latest 语义；
// - Hermes → OpenColorful 的语义转换在
//   src/runtime/plugins/compat/hermes-compat.ts，本模块只提供原始包。
// ═══════════════════════════════════════════════════════════════

export class HermesSourceAdapter implements PluginSourceAdapter {
  readonly sourceType = "hermes" as const;

  constructor(private readonly options: { readonly baseDir?: string } = {}) {}

  /** 普通目录校验（search 的 baseDir 不需要含 plugin.yaml）。 */
  private requirePlainDir(ref: string): string {
    const resolved = path.resolve(ref);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SourceResolveError("hermes_dir_missing", "Hermes 插件目录不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new SourceResolveError("hermes_dir_symlink", "Hermes 插件目录不允许是符号链接或 Junction");
    }
    if (!stat.isDirectory()) {
      throw new SourceResolveError("hermes_dir_not_dir", "Hermes 来源不是目录");
    }
    return resolved;
  }

  private requirePluginDir(ref: string): string {
    const dir = this.requirePlainDir(ref);
    if (!detectHermesPluginDir(dir)) {
      throw new SourceResolveError("hermes_manifest_missing", "Hermes 来源缺少 plugin.yaml");
    }
    return dir;
  }

  /** 读取 plugin.yaml 并附带来源元数据（名称/版本/入口/hooks/依赖）。 */
  private readMetadata(dir: string): { readonly descriptor: HermesPluginDescriptor; readonly metadata: Record<string, unknown> } {
    const descriptor = readHermesPluginDir(dir);
    const metadata: Record<string, unknown> = {
      id: descriptor.name,
      name: descriptor.name,
      version: descriptor.version,
      entry: descriptor.entry,
      kind: descriptor.kind,
      hooks: [...descriptor.hooks],
    };
    if (descriptor.description !== undefined) metadata.description = descriptor.description;
    if (descriptor.author !== undefined) metadata.author = descriptor.author;
    if (descriptor.providesTools.length > 0) metadata.providesTools = [...descriptor.providesTools];
    if (descriptor.requiresEnv.length > 0) metadata.requiresEnv = [...descriptor.requiresEnv];
    if (descriptor.dependencies.length > 0) metadata.dependencies = [...descriptor.dependencies];
    if (descriptor.interpreter !== undefined) metadata.interpreter = descriptor.interpreter;
    return { descriptor, metadata };
  }

  search(query: string): readonly SourceSearchResult[] {
    const baseDir = this.options.baseDir;
    if (baseDir === undefined) {
      return [];
    }
    const root = this.requirePlainDir(baseDir);
    const needle = query.trim().toLowerCase();
    const results: SourceSearchResult[] = [];
    const scanned = new Set<string>();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidates: string[] = [];
      const direct = path.join(root, entry.name);
      if (detectHermesPluginDir(direct)) {
        candidates.push(direct);
      } else {
        // 兼容 Hermes 分类布局：<root>/<category>/<plugin-name>/plugin.yaml
        for (const sub of fs.readdirSync(direct, { withFileTypes: true })) {
          if (sub.isDirectory() && detectHermesPluginDir(path.join(direct, sub.name))) {
            candidates.push(path.join(direct, sub.name));
          }
        }
      }
      for (const candidate of candidates) {
        if (scanned.has(candidate)) {
          continue;
        }
        scanned.add(candidate);
        let descriptor: HermesPluginDescriptor;
        try {
          descriptor = readHermesPluginDir(candidate);
        } catch {
          continue; // 跳过损坏条目
        }
        if (needle !== "" && !descriptor.name.toLowerCase().includes(needle)) {
          continue;
        }
        results.push({
          id: descriptor.name,
          name: descriptor.name,
          version: descriptor.version,
          sourceType: "hermes",
          ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
        });
      }
    }
    return results;
  }

  resolve(sourceRef: PluginSourceRef): ResolvedSource {
    const ref = assertPluginSourceRef(sourceRef);
    const pluginDir = this.requirePluginDir(ref.ref);
    const { descriptor, metadata } = this.readMetadata(pluginDir);
    if (ref.version !== undefined && ref.version !== descriptor.version) {
      throw new SourceResolveError("version_mismatch", "请求版本与 Hermes 插件实际版本不一致");
    }
    return { sourceType: "hermes", ref: pluginDir, version: descriptor.version, lock: null, metadata };
  }

  listVersions(sourceRef: PluginSourceRef): readonly SourceVersionInfo[] {
    const resolved = this.resolve(sourceRef);
    return resolved.version === null ? [] : [{ version: resolved.version, lock: null }];
  }

  fetchArtifact(sourceRef: PluginSourceRef, _options?: { readonly stagingDir?: string }): FetchedArtifact {
    const ref = assertPluginSourceRef(sourceRef);
    const pluginDir = this.requirePluginDir(ref.ref);
    const { descriptor, metadata } = this.readMetadata(pluginDir);
    if (ref.version !== undefined && ref.version !== descriptor.version) {
      throw new SourceResolveError("version_mismatch", "请求版本与 Hermes 插件实际版本不一致");
    }
    return {
      sourceType: "hermes",
      ref: pluginDir,
      version: descriptor.version,
      lock: null,
      contentRoot: pluginDir,
      metadata,
    };
  }

  verifyArtifact(artifact: FetchedArtifact): ArtifactVerification {
    return computeArtifactHash(artifact.contentRoot, { exclude: [".git", "__pycache__"] });
  }

  readProvenance(artifact: FetchedArtifact): unknown {
    const { descriptor } = this.readMetadata(artifact.contentRoot);
    return {
      sourceType: "hermes",
      ref: artifact.ref,
      sourceFormat: `${HERMES_MANIFEST_FILE}@hermes`,
      pluginYaml: descriptor.rawYaml,
      entry: descriptor.entry,
      kind: descriptor.kind,
      hooks: [...descriptor.hooks],
      providesTools: [...descriptor.providesTools],
      requiresEnv: [...descriptor.requiresEnv],
      dependencies: [...descriptor.dependencies],
    };
  }
}

/** 工厂函数：供主 Agent 在组合根统一接线（sources/ 下暂无独立 registry 结构）。 */
export function createHermesSourceAdapter(options?: { readonly baseDir?: string }): HermesSourceAdapter {
  return new HermesSourceAdapter(options);
}

/** 完整性错误别名（compat 解析层抛 SourceIntegrityError，统一来源语义）。 */
export { SourceIntegrityError as HermesSourceIntegrityError };
