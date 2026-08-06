import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import { SkillError } from "../errors.js";
import { slugifySkillId } from "../manifest.js";
import { peekSkillManifest, validateSkillPackage } from "../validator.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 Linked Source 登记（plans/phase-13.md §9.2 / §14.3 / §15.1）
//
// - `skills link` / `skills unlink` 只做登记/注销；Linked Source 是**只读引用**，
//   不复制到 Managed Store，不允许原地修改 Managed Artifact；
// - 登记文件：${OPENCOLORFUL_HOME}/skill-dev-sources/sources.json（专用文件，
//   不写 config/skill-sources.json 信任配置——信任与链接是两类设置）；
// - 内容变化"下一 turn 重新哈希生效"：list() 每次按需重新校验 + 重算哈希，
//   不缓存（源文件修改后下一次读取即反映新状态；in-flight turn 快照不受影响，
//   该语义由 Snapshot 层保证，本模块只负责登记与状态展示）；
// - 登记校验：目录存在、非符号链接/Junction、SKILL.md 可解析（完整包要求）；
// - 失败路径 fail-closed：损坏登记文件 → 空登记（不静默信任任何路径）；
// - 写入原子化（temp + rename）。
// ═══════════════════════════════════════════════════════════════

export interface LinkedSourceEntry {
  readonly sourceId: string;
  readonly rootPath: string;
  readonly linkedAt: string;
}

/** list() 返回的实时状态（每次读取重新校验 + 重算哈希）。 */
export interface LinkedSourceStatus extends LinkedSourceEntry {
  readonly valid: boolean;
  readonly skillName: string | null;
  readonly version: string | null;
  readonly contentHash: string | null;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly errors: readonly string[];
}

interface LinkedSourcesDocument {
  readonly version: 1;
  readonly linkedSources: readonly LinkedSourceEntry[];
}

function defaultDocument(): LinkedSourcesDocument {
  return { version: 1, linkedSources: [] };
}

export class LinkedSourceRegistry {
  constructor(private readonly paths: RuntimePaths) {}

  /** 登记文件绝对路径（paths.ts 生成，调用方不得自行拼接）。 */
  filePath(): string {
    return path.join(this.paths.skillDevSources, "sources.json");
  }

  /**
   * 登记源码目录为 Linked Source（只读引用，不复制）。
   * sourceId = `linked-<slugifySkillId(name)>`；重复登记同一路径/同一 sourceId
   * → 稳定 reasonCode（fail-closed）。
   */
  register(rootPathInput: string): LinkedSourceStatus {
    const rootPath = path.resolve(rootPathInput);
    const rootStat = this.assertLinkableDirectory(rootPath);
    void rootStat;
    const peek = peekSkillManifest(rootPath);
    if (!peek.ok) {
      throw new SkillError(
        peek.error?.reasonCode ?? "skill_not_a_complete_package",
        peek.error?.message ?? "Linked Source 必须包含可解析的 SKILL.md（不接受裸目录）",
      );
    }
    const sourceId = `linked-${slugifySkillId(peek.manifest?.name ?? peek.name ?? "skill")}`;

    const document = this.load();
    if (document.linkedSources.some((entry) => path.resolve(entry.rootPath) === rootPath)) {
      throw new SkillError("skill_already_installed", `该目录已是 Linked Source：${rootPath}`);
    }
    if (document.linkedSources.some((entry) => entry.sourceId === sourceId)) {
      throw new SkillError(
        "skill_version_conflict",
        `Linked Source sourceId 冲突：${sourceId}（同名不同目录请修改 SKILL.md 的 name）`,
      );
    }
    const entry: LinkedSourceEntry = { sourceId, rootPath, linkedAt: new Date().toISOString() };
    this.save({ version: 1, linkedSources: [...document.linkedSources, entry] });
    return this.statusOf(entry);
  }

  /** 注销 Linked Source（只删登记，不删源码目录）。 */
  unregister(sourceId: string): LinkedSourceEntry {
    const document = this.load();
    const entry = document.linkedSources.find((candidate) => candidate.sourceId === sourceId);
    if (entry === undefined) {
      throw new SkillError("skill_source_not_found", `Linked Source 未登记：${sourceId}`);
    }
    this.save({
      version: 1,
      linkedSources: document.linkedSources.filter((candidate) => candidate.sourceId !== sourceId),
    });
    return { ...entry };
  }

  /** 全部 Linked Source + 实时状态（每次重新校验/哈希，源文件修改后立即反映）。 */
  list(): readonly LinkedSourceStatus[] {
    return this.load().linkedSources.map((entry) => this.statusOf(entry));
  }

  get(sourceId: string): LinkedSourceStatus | null {
    const entry = this.load().linkedSources.find((candidate) => candidate.sourceId === sourceId);
    return entry === undefined ? null : this.statusOf(entry);
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private assertLinkableDirectory(rootPath: string): fs.Stats {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(rootPath);
    } catch {
      throw new SkillError("skill_source_not_found", `Linked Source 目录不存在：${rootPath}`);
    }
    if (stat.isSymbolicLink()) {
      throw new SkillError("skill_symlink_escape", "Linked Source 根目录不允许是符号链接或 Junction");
    }
    if (!stat.isDirectory()) {
      throw new SkillError("skill_package_invalid", "Linked Source 根路径不是目录");
    }
    return stat;
  }

  /** 实时状态：完整校验 + 确定性哈希（与 Managed Store 同一规则）。 */
  private statusOf(entry: LinkedSourceEntry): LinkedSourceStatus {
    const base: LinkedSourceStatus = {
      ...entry,
      valid: false,
      skillName: null,
      version: null,
      contentHash: null,
      sizeBytes: 0,
      fileCount: 0,
      errors: [],
    };
    const peek = peekSkillManifest(entry.rootPath);
    if (!peek.ok) {
      return { ...base, errors: [peek.error?.message ?? "SKILL.md 不可解析"] };
    }
    const version = peek.version ?? "0.0.0";
    const validation = validateSkillPackage({ packageRoot: entry.rootPath, version });
    if (!validation.ok) {
      return {
        ...base,
        skillName: peek.manifest?.name ?? peek.name,
        version,
        errors: validation.errors.map((error) => error.message),
      };
    }
    return {
      ...base,
      valid: true,
      skillName: validation.manifest?.name ?? peek.name,
      version,
      contentHash: validation.contentHash,
      sizeBytes: validation.sizeBytes,
      fileCount: validation.fileCount,
      errors: [],
    };
  }

  /** 读取登记文件；缺失/损坏 → 空登记（fail-closed，不静默信任任何路径）。 */
  private load(): LinkedSourcesDocument {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as unknown;
      return parseDocument(raw);
    } catch {
      return defaultDocument();
    }
  }

  /** 原子写（temp + rename；写入失败抛错，不产生半写状态）。 */
  private save(document: LinkedSourcesDocument): void {
    fs.mkdirSync(this.paths.skillDevSources, { recursive: true });
    const file = this.filePath();
    const temporary = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, file);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // 清理失败不掩盖原错误
      }
      throw error;
    }
  }
}

// ── 配置解析（跨函数边界输入显式校验，fail-closed） ─────────────

function parseDocument(input: unknown): LinkedSourcesDocument {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return defaultDocument();
  }
  const raw = input as Record<string, unknown>;
  if (raw["version"] !== 1) {
    return defaultDocument();
  }
  const rawSources = raw["linkedSources"];
  if (!Array.isArray(rawSources)) {
    return defaultDocument();
  }
  const linkedSources: LinkedSourceEntry[] = [];
  for (const item of rawSources) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record["sourceId"] !== "string" || record["sourceId"].length === 0) {
      continue;
    }
    if (typeof record["rootPath"] !== "string" || record["rootPath"].length === 0) {
      continue;
    }
    const linkedAt = typeof record["linkedAt"] === "string" && record["linkedAt"].length > 0
      ? record["linkedAt"]
      : new Date(0).toISOString();
    linkedSources.push({
      sourceId: record["sourceId"],
      rootPath: path.resolve(record["rootPath"]),
      linkedAt,
    });
  }
  return { version: 1, linkedSources };
}
