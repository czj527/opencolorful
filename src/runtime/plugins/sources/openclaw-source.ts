import fs from "node:fs";
import path from "node:path";

import { Type } from "typebox";
import Value from "typebox/value";

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

// ═══════════════════════════════════════════════════════════════
// OpenClaw / ClawHub Source Adapter（plans/phase-12.md §12.3）
//
// - 识别 openclaw.plugin.json 与兼容 bundle（ClawHub 下载目录 /
//   单一外层包装目录）；sourceRef.sourceType = "openclaw"；
// - 只负责发现、解析、获取 Artifact 与返回元数据/provenance，
//   不直接启用或执行插件（Source Adapter 与 Runtime Adapter 分离）；
// - 离线优先：ref 指向本地固定 fixture/目录，禁止测试访问真实 ClawHub；
// - 版本来自 manifest（固定 SemVer），不支持 latest 语义；
// - OpenClaw → OpenColorful 的语义转换在
//   src/runtime/plugins/compat/openclaw-compat.ts，本模块只提供原始包。
// ═══════════════════════════════════════════════════════════════

// ── OpenClaw 原始 Manifest（openclaw.plugin.json）Schema ──────────
//
// 外部生态格式按"宽容解析 + 精确诊断"处理：结构宽松（additionalProperties
// 开启，容忍格式漂移），已知字段严格校验；不支持的高风险能力在兼容报告里
// 给出 blocked/degraded 精确诊断，不静默忽略。

const OpenClawAuthorSchema = Type.Union([
  Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 128 }),
      email: Type.Optional(Type.String({ minLength: 3, maxLength: 256 })),
      url: Type.Optional(Type.String({ minLength: 3, maxLength: 512 })),
    },
    { additionalProperties: true },
  ),
  Type.String({ minLength: 1, maxLength: 128 }),
]);

const OpenClawToolSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    schema: Type.Optional(Type.Unknown()),
    outputSchema: Type.Optional(Type.Unknown()),
    risk: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  },
  { additionalProperties: true },
);

const OpenClawMcpSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    args: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 })),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: true },
);

const OpenClawCommandSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    argumentsSchema: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const OpenClawSkillSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    dir: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: true },
);

const OpenClawPermissionsSchema = Type.Object(
  {
    allow: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 })),
    deny: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 })),
  },
  { additionalProperties: true },
);

const OpenClawCapabilitiesSchema = Type.Object(
  {
    gateway: Type.Optional(Type.Unknown()),
    channels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64 })),
    acp: Type.Optional(Type.Unknown()),
    hooks: Type.Optional(Type.Unknown()),
    schedules: Type.Optional(Type.Unknown()),
    events: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

export const OpenClawManifestSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    author: Type.Optional(OpenClawAuthorSchema),
    license: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    homepage: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    engines: Type.Optional(Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 128 }))),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 128 }))),
    entry: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    package: Type.Optional(
      Type.Object(
        {
          module: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          entry: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          register: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        },
        { additionalProperties: true },
      ),
    ),
    tools: Type.Optional(Type.Array(OpenClawToolSchema, { maxItems: 256 })),
    mcp: Type.Optional(Type.Array(OpenClawMcpSchema, { maxItems: 128 })),
    commands: Type.Optional(Type.Array(OpenClawCommandSchema, { maxItems: 256 })),
    skills: Type.Optional(Type.Array(OpenClawSkillSchema, { maxItems: 128 })),
    config: Type.Optional(
      Type.Object(
        {
          schema: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: true },
      ),
    ),
    permissions: Type.Optional(OpenClawPermissionsSchema),
    capabilities: Type.Optional(OpenClawCapabilitiesSchema),
  },
  { additionalProperties: true },
);

// ── OpenClaw Manifest 镜像类型（结构由上方 Schema 保证） ──────────

export interface OpenClawAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

export interface OpenClawTool {
  readonly name: string;
  readonly description?: string;
  readonly schema?: unknown;
  readonly outputSchema?: unknown;
  readonly risk?: "low" | "medium" | "high";
}

export interface OpenClawMcp {
  readonly id: string;
  readonly description?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
}

export interface OpenClawCommand {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly argumentsSchema?: unknown;
}

export interface OpenClawSkill {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly dir?: string;
}

export interface OpenClawPermissions {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface OpenClawCapabilities {
  readonly gateway?: unknown;
  readonly channels?: readonly string[];
  readonly acp?: unknown;
  readonly hooks?: unknown;
  readonly schedules?: unknown;
  readonly events?: unknown;
}

export interface OpenClawPackage {
  readonly module?: string;
  readonly entry?: string;
  readonly register?: string;
}

export interface OpenClawManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string | OpenClawAuthor;
  readonly license?: string;
  readonly homepage?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly entry?: string;
  readonly package?: OpenClawPackage;
  readonly tools?: readonly OpenClawTool[];
  readonly mcp?: readonly OpenClawMcp[];
  readonly commands?: readonly OpenClawCommand[];
  readonly skills?: readonly OpenClawSkill[];
  readonly config?: { readonly schema?: unknown };
  readonly permissions?: OpenClawPermissions;
  readonly capabilities?: OpenClawCapabilities;
}

/** OpenClaw 原始 Manifest 校验解析：不符合契约抛完整性错误。 */
export function parseOpenClawManifest(raw: unknown): OpenClawManifest {
  if (typeof raw !== "object" || raw === null || !Value.Check(OpenClawManifestSchema, raw)) {
    throw new SourceIntegrityError("openclaw_manifest_invalid", "openclaw.plugin.json 不符合 OpenClaw 插件契约");
  }
  return raw as OpenClawManifest;
}

/** 读取插件根目录下的 openclaw.plugin.json（原始内容，供 provenance 与校验）。 */
export function readOpenClawManifestFile(contentRoot: string): unknown {
  const manifestPath = path.join(contentRoot, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    throw new SourceIntegrityError("openclaw_manifest_missing", "插件包缺少 openclaw.plugin.json");
  }
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new SourceIntegrityError("openclaw_manifest_unreadable", "openclaw.plugin.json 无法读取");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SourceIntegrityError("openclaw_manifest_invalid_json", "openclaw.plugin.json 不是合法 JSON");
  }
}

/** OpenClaw 作者可为字符串或对象，统一归一化为 { name[, email, url] }。 */
export function normalizeOpenClawAuthor(
  author: string | OpenClawAuthor | undefined,
): { readonly name: string; readonly email?: string; readonly url?: string } | undefined {
  if (author === undefined) {
    return undefined;
  }
  if (typeof author === "string") {
    return { name: author };
  }
  const normalized: { name: string; email?: string; url?: string } = { name: author.name };
  if (author.email !== undefined) {
    normalized.email = author.email;
  }
  if (author.url !== undefined) {
    normalized.url = author.url;
  }
  return normalized;
}

// ── Source Adapter ────────────────────────────────────────────────

export class OpenClawSourceAdapter implements PluginSourceAdapter {
  readonly sourceType = "openclaw" as const;

  constructor(private readonly options: { readonly baseDir?: string } = {}) {}

  /** 普通目录校验（search 的 baseDir 不需要含 manifest）。 */
  private requirePlainDir(ref: string): string {
    const resolved = path.resolve(ref);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SourceResolveError("openclaw_dir_missing", "OpenClaw 插件目录不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new SourceResolveError("openclaw_dir_symlink", "OpenClaw 插件目录不允许是符号链接或 Junction");
    }
    if (!stat.isDirectory()) {
      throw new SourceResolveError("openclaw_dir_not_dir", "OpenClaw 来源不是目录");
    }
    return resolved;
  }

  /**
   * 定位 openclaw.plugin.json 所在目录：优先根目录；否则扫描一层子目录，
   * 恰好一个子目录含 openclaw.plugin.json 时视为兼容 bundle（ClawHub 下载
   * 常见单一外层包装目录），多个则判定歧义。
   */
  private resolvePluginRoot(dir: string): string {
    if (fs.existsSync(path.join(dir, "openclaw.plugin.json"))) {
      return dir;
    }
    const candidates: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (fs.existsSync(path.join(dir, entry.name, "openclaw.plugin.json"))) {
        candidates.push(path.join(dir, entry.name));
      }
    }
    if (candidates.length === 1) {
      return candidates[0] as string;
    }
    if (candidates.length > 1) {
      throw new SourceResolveError("openclaw_ambiguous_bundle", "OpenClaw bundle 存在多个含 openclaw.plugin.json 的子目录");
    }
    throw new SourceResolveError("openclaw_manifest_missing", "OpenClaw 来源缺少 openclaw.plugin.json");
  }

  private requirePluginDir(ref: string): string {
    const dir = this.requirePlainDir(ref);
    return this.resolvePluginRoot(dir);
  }

  /** 读取并解析 manifest，附带来源元数据（id/name/version/author/描述/依赖）。 */
  private readMetadata(dir: string): { readonly manifest: OpenClawManifest; readonly metadata: Record<string, unknown> } {
    const raw = readOpenClawManifestFile(dir);
    const manifest = parseOpenClawManifest(raw);
    const metadata: Record<string, unknown> = {
      manifest: raw,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
    };
    if (manifest.description !== undefined) metadata.description = manifest.description;
    if (manifest.license !== undefined) metadata.license = manifest.license;
    if (manifest.homepage !== undefined) metadata.homepage = manifest.homepage;
    const author = normalizeOpenClawAuthor(manifest.author);
    if (author !== undefined) metadata.author = author;
    if (manifest.dependencies !== undefined) metadata.dependencies = manifest.dependencies;
    if (manifest.engines !== undefined) metadata.engines = manifest.engines;
    return { manifest, metadata };
  }

  search(query: string): readonly SourceSearchResult[] {
    const baseDir = this.options.baseDir;
    if (baseDir === undefined) {
      return [];
    }
    const root = this.requirePlainDir(baseDir);
    const needle = query.trim().toLowerCase();
    const results: SourceSearchResult[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(root, entry.name);
      if (!fs.existsSync(path.join(candidate, "openclaw.plugin.json"))) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(candidate, "openclaw.plugin.json"), "utf8")) as unknown;
      } catch {
        continue; // 跳过损坏条目
      }
      let manifest: OpenClawManifest;
      try {
        manifest = parseOpenClawManifest(raw);
      } catch {
        continue;
      }
      if (needle !== "" && !manifest.name.toLowerCase().includes(needle) && !manifest.id.toLowerCase().includes(needle)) {
        continue;
      }
      results.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        sourceType: "openclaw",
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      });
    }
    return results;
  }

  resolve(sourceRef: PluginSourceRef): ResolvedSource {
    const ref = assertPluginSourceRef(sourceRef);
    const pluginDir = this.requirePluginDir(ref.ref);
    const { manifest, metadata } = this.readMetadata(pluginDir);
    if (ref.version !== undefined && ref.version !== manifest.version) {
      throw new SourceResolveError("version_mismatch", "请求版本与 OpenClaw 插件实际版本不一致");
    }
    return { sourceType: "openclaw", ref: pluginDir, version: manifest.version, lock: null, metadata };
  }

  listVersions(sourceRef: PluginSourceRef): readonly SourceVersionInfo[] {
    const resolved = this.resolve(sourceRef);
    return resolved.version === null ? [] : [{ version: resolved.version, lock: null }];
  }

  fetchArtifact(sourceRef: PluginSourceRef, _options?: { readonly stagingDir?: string }): FetchedArtifact {
    const ref = assertPluginSourceRef(sourceRef);
    const pluginDir = this.requirePluginDir(ref.ref);
    const { manifest, metadata } = this.readMetadata(pluginDir);
    if (ref.version !== undefined && ref.version !== manifest.version) {
      throw new SourceResolveError("version_mismatch", "请求版本与 OpenClaw 插件实际版本不一致");
    }
    return {
      sourceType: "openclaw",
      ref: pluginDir,
      version: manifest.version,
      lock: null,
      contentRoot: pluginDir,
      metadata,
    };
  }

  verifyArtifact(artifact: FetchedArtifact): ArtifactVerification {
    return computeArtifactHash(artifact.contentRoot, { exclude: [".git", "node_modules"] });
  }

  readProvenance(artifact: FetchedArtifact): unknown {
    const { manifest } = this.readMetadata(artifact.contentRoot);
    return {
      sourceType: "openclaw",
      ref: artifact.ref,
      sourceFormat: "openclaw.plugin.json@1",
      manifest: readOpenClawManifestFile(artifact.contentRoot),
      dependencies: manifest.dependencies ?? {},
      engines: manifest.engines ?? {},
    };
  }
}

/** 工厂函数：供主 Agent 在组合根统一接线（sources/ 下暂无独立 registry 结构）。 */
export function createOpenClawSourceAdapter(options?: { readonly baseDir?: string }): OpenClawSourceAdapter {
  return new OpenClawSourceAdapter(options);
}
