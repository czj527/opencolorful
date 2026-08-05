import type { ResourceDiagnostic, Skill, SourceInfo } from "@earendil-works/pi-coding-agent";

import { SKILL_BUDGETS, skillRefKey, type SkillRef, type SkillSourceKind } from "../contracts/skill-protocol.js";
import type { ResolutionDiagnostic, ResolveOutput, ResolvedSkill } from "../runtime/skills/resolver.js";
import { canonicalPathSync, safeJoin } from "../runtime/skills/path-safety.js";
import type { SkillSnapshot } from "../runtime/skills/snapshot/skill-snapshot.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 PI ResourceLoader 接入（plans/phase-13.md §10.1 / §10.3 / 偏差 T5）
//
// PI 0.80.10 实测事实（必须遵循）：
// - ResourceLoader.getSkills() 返回 { skills: Skill[], diagnostics }；
// - Skill = { name, description, filePath, baseDir, sourceInfo,
//   disableModelInvocation }——无 skillId/contentIsFull/metadata；
// - 无原生 get_skill 工具；模型用通用 read 工具按 filePath（绝对路径）读正文；
// - 元数据注入是 PI 职责（formatSkillsForPrompt → <available_skills> XML，
//   被 hasRead 门控），本模块只负责把 ResolveOutput/Snapshot 映射为 PI Skill。
//
// 映射规则：
// - name = displayName（manifest.name 规范化结果）；
// - description = manifest.description（参与元数据预算截断）；
// - filePath = rootPath/SKILL.md 绝对路径（safeJoin 受控，仅暴露 bundle 内路径）；
// - baseDir = rootPath；sourceInfo = { path, source: skillRefKey, scope, origin:
//   "package", baseDir }（scope: workspace → "project"，其余 → "user"）；
// - disableModelInvocation 从 manifest 透传（explicit-only 选择不与之混淆，
//   由 T6/T8 工具层处理显式加载）；
// - 元数据预算：构建 Skill[] 前按 maxMetadataChars 控制条目与字段长度，
//   超限截断并标记 truncated（pinned 优先于 implicit）；
// - 正文渐进披露：本模块只输出 pointer + 元数据，正文必须经
//   SkillContentService.readSkillBody（T5 提供受控入口；read 工具挂接决策
//   在 T6/T7，见 read 工具挂接点说明）。
// ═══════════════════════════════════════════════════════════════

export interface PiSkillLoadOptions {
  readonly maxSkills?: number;
  readonly maxMetadataChars?: number;
}

export interface PiSkillsLoadResult {
  readonly skills: Skill[];
  readonly diagnostics: ResourceDiagnostic[];
  /** 元数据预算截断（条目超限或字符超限） */
  readonly truncated: boolean;
}

const DEFAULT_LOAD_OPTIONS = {
  maxSkills: SKILL_BUDGETS.maxSkillsPerSnapshot,
  maxMetadataChars: SKILL_BUDGETS.maxMetadataChars,
};

/** ResolveOutput（当前 Agent/Session 解析结果）→ PI Skill pointer 列表。 */
export function buildPiSkills(resolveOutput: ResolveOutput, options: PiSkillLoadOptions = {}): PiSkillsLoadResult {
  const resolved = { ...DEFAULT_LOAD_OPTIONS, ...options };
  const ordered = [...resolveOutput.visible]
    .sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))
    .map(toPiSkillSource);
  return mapWithBudget(ordered, ordered.length > resolved.maxSkills, resolved.maxSkills, resolved.maxMetadataChars, resolveOutput.diagnostics);
}

/** Turn Snapshot（冻结视图）→ PI Skill pointer 列表（T6 在 turn 边界使用）。 */
export function buildPiSkillsFromSnapshot(snapshot: SkillSnapshot, options: PiSkillLoadOptions = {}): PiSkillsLoadResult {
  const resolved = { ...DEFAULT_LOAD_OPTIONS, ...options };
  const entries = [...snapshot.entries]
    .sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))
    .map((entry): PiSkillSource => ({
      displayName: entry.displayName,
      description: entry.description,
      rootPath: entry.rootPath,
      disableModelInvocation: entry.disableModelInvocation,
      skillRef: entry.skillRef,
      pinned: entry.pinned,
    }));
  return mapWithBudget(entries, snapshot.truncatedSkills, resolved.maxSkills, resolved.maxMetadataChars, snapshot.diagnostics);
}

// ── 内部实现 ───────────────────────────────────────────────────

function toPiSkillSource(skill: ResolvedSkill): PiSkillSource {
  return {
    displayName: skill.displayName,
    description: skill.description,
    rootPath: skill.rootPath,
    disableModelInvocation: skill.manifest?.disableModelInvocation ?? false,
    skillRef: skill.skillRef,
    pinned: skill.pinned,
  };
}

interface PiSkillSource {
  readonly displayName: string;
  readonly description: string | undefined;
  readonly rootPath: string;
  readonly disableModelInvocation: boolean;
  readonly skillRef: SkillRef;
  readonly pinned: boolean;
}

function mapWithBudget(
  sources: readonly PiSkillSource[],
  capTruncated: boolean,
  maxSkills: number,
  maxMetadataChars: number,
  diagnostics: readonly ResolutionDiagnostic[],
): PiSkillsLoadResult {
  const skills: Skill[] = [];
  let usedChars = 0;
  let truncated = capTruncated;
  for (const source of sources.slice(0, maxSkills)) {
    const name = source.displayName.slice(0, 128);
    if (usedChars + name.length + 1 > maxMetadataChars) {
      truncated = true;
      break;
    }
    const remaining = maxMetadataChars - usedChars - name.length - 1;
    const description = (source.description ?? "").slice(0, remaining);
    if (description.length < (source.description ?? "").length) {
      truncated = true;
    }
    usedChars += name.length + 1 + description.length;
    skills.push(toPiSkill(source, name, description));
  }
  if (sources.length > skills.length) {
    truncated = true;
  }
  return { skills, diagnostics: mapDiagnostics(diagnostics), truncated };
}

function toPiSkill(source: PiSkillSource, name: string, description: string): Skill {
  // filePath/baseDir 只暴露 bundle 内路径：canonical rootPath 下拼接 SKILL.md
  const rootPath = canonicalPathSync(source.rootPath);
  const filePath = safeJoin(rootPath, "SKILL.md");
  const sourceInfo: SourceInfo = {
    path: filePath,
    source: skillRefKey(source.skillRef),
    scope: mapScope(source.skillRef.sourceKind),
    origin: "package",
    baseDir: rootPath,
  };
  return {
    name,
    description,
    filePath,
    baseDir: rootPath,
    sourceInfo,
    disableModelInvocation: source.disableModelInvocation,
  };
}

/** 来源种类 → PI scope：workspace 即项目本地（project），其余视为平台层（user）。 */
function mapScope(sourceKind: SkillSourceKind): SourceInfo["scope"] {
  return sourceKind === "workspace" ? "project" : "user";
}

function mapDiagnostics(diagnostics: readonly ResolutionDiagnostic[]): ResourceDiagnostic[] {
  return diagnostics.map((diag) => ({
    type: isFatalCode(diag.code) ? "error" : "warning",
    message: diag.message,
    ...(diag.skillRef !== undefined ? { path: diag.skillRef.skillId } : {}),
  }));
}

function isFatalCode(code: string): boolean {
  return (
    code === "skill_unknown_skillref" ||
    code === "skill_manifest_invalid" ||
    code === "skill_path_escape" ||
    code === "skill_symlink_escape" ||
    code === "skill_not_a_complete_package"
  );
}

/**
 * read 工具挂接点现状（T5 交付说明）：
 * - PI 模型读取正文走通用 read 工具（filePath = 上文的受控绝对路径）；
 * - 该工具的执行入口在 src/pi-sdk/sandbox-extension.ts 与宿主工具策略
 *   （ToolPolicy.checkFilePath）处；T5 在平台侧提供受控入口
 *   SkillContentService.readSkillBody({snapshot, skillRef, relativePath, handle})，
 *   由它承担哈希/预算/超时/审计校验与首读冻结；
 * - 把 read 工具对 skill 路径的调用路由到 readSkillBody（含 loadHandle 消费）
 *   属于 T6/T7 接线决策（read 工具注册/沙箱桥接），T5 不实现；
 * - 记忆 Markdown 注入链与本模块无隐式耦合（§6.2）。
 */
