import fs from "node:fs";
import path from "node:path";

import { parseYamlFrontmatter } from "../frontmatter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 Hermes Skill frontmatter 转换（plans/phase-13.md §8.4 / §15.2）
//
// T2 已转换 platform/prerequisites{os,bins,env}/requires；T9 在 Hermes
// 适配器 staging 阶段补全真实 Hermes Agent 技能包（NousResearch/hermes-agent、
// 社区包）中 T2 尚未覆盖的字段（只改 staging 副本，镜像/原包保持原样）：
//
//   platforms: [macos]                    → platform: [macos]（T2 再做 os 映射）
//   prerequisites: {commands: [memo]}     → prerequisites: {bins: [memo], ...}（commands 并入 bins）
//   required_environment: python3         → prerequisites: {bins: [python3]}
//   required_environment_variables:
//     - name: TOKEN                      → prerequisites: {env: [TOKEN, ...]}
//   user-invocable: false                → disable-model-invocation: true
//
// 实现方式：
// 1) 预归一化：T2 受限解析器不支持"块序列内联映射项"（- name: X 换行多键），
//    真实 Hermes 包的 required_environment_variables 正是此形态；先把这类
//    块序列项改写为流映射（- {name: X, ...}），使解析器可读；
// 2) 用 T2 解析器解析 → 应用转换 → 用本模块的确定性 YAML 发射器重写
//    frontmatter（值语义不变，注释不保留；原包在镜像中永不被修改）；
// 3) 发射器只产生受限解析器可读的子集，并以 round-trip 测试锁定。
// ═══════════════════════════════════════════════════════════════

export interface HermesRewriteResult {
  /** 重写后的完整 SKILL.md 文本（未改变时为原文本） */
  readonly source: string;
  readonly changed: boolean;
  /** 人读转换清单（诊断用） */
  readonly conversions: readonly string[];
}

const OS_ALL = ["linux", "darwin", "win32"] as const;

// ── 预归一化：块序列内联映射项 → 流映射项 ────────────────────────

/**
 * 把 frontmatter 文本中形如
 *   required_environment_variables:
 *     - name: TOKEN
 *       prompt: ...
 * 的块序列映射项改写为
 *   required_environment_variables:
 *     - {name: TOKEN, prompt: ...}
 * 使 T2 受限解析器可读。解析器不支持"序列项为多键映射块"；改写失败返回 null
 * （fail-closed：保持原文，由校验器给出精确诊断）。
 */
export function normalizeBlockSequenceMaps(frontmatterText: string): string | null {
  const lines = frontmatterText.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const item = ITEM_KEY_VALUE.exec(line);
    if (item === null) {
      out.push(line);
      i += 1;
      continue;
    }
    const itemIndent = item[1]?.length ?? 0;
    const itemKey = item[2] ?? "";
    const firstValue = item[3] ?? "";
    const keys: Array<{ key: string; value: string }> = [{ key: itemKey, value: firstValue }];
    let j = i + 1;
    let ok = true;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      if (trimmed === "") {
        break;
      }
      const indent = next.length - next.trimStart().length;
      if (indent <= itemIndent) {
        break;
      }
      const kv = KEY_VALUE.exec(next);
      if (kv === null) {
        // 续行为嵌套块（如 key: 后跟子块）——不支持，放弃本次改写
        ok = false;
        break;
      }
      keys.push({ key: kv[2] ?? "", value: kv[3] ?? "" });
      j += 1;
    }
    if (!ok) {
      return null;
    }
    const flowItems = keys.map((entry) => `${quoteKey(entry.key)}: ${flowValue(entry.value)}`).join(", ");
    out.push(`${" ".repeat(itemIndent)}- {${flowItems}}`);
    i = j;
  }
  return out.join("\n");
}

const ITEM_KEY_VALUE = /^(\s*)- ([^\s:]+):\s*(.*)$/;
const KEY_VALUE = /^(\s*)([^\s:]+):\s*(.*)$/;

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * 重写 SKILL.md 全文：预归一化 → 解析 → 转换 → 确定性发射。
 * 任何一步失败都返回原文本（changed=false），绝不产出损坏的 frontmatter。
 */
export function rewriteHermesSkillFrontmatter(source: string): HermesRewriteResult {
  const text = source.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trimEnd() ?? "";
  if (first !== "---") {
    return { source, changed: false, conversions: [] };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const candidate = lines[i]?.trimEnd() ?? "";
    if (candidate === "---" || candidate === "...") {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return { source, changed: false, conversions: [] };
  }
  const rawFrontmatter = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");

  const normalized = normalizeBlockSequenceMaps(rawFrontmatter);
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYamlFrontmatter(normalized ?? rawFrontmatter);
  } catch {
    return { source, changed: false, conversions: [] };
  }

  const conversions: string[] = [];
  const mutated = applyHermesConversions(frontmatter, conversions);
  if (!mutated) {
    return { source, changed: false, conversions: [] };
  }

  const emitted = emitYamlFrontmatter(frontmatter);
  const rewritten = `---\n${emitted}\n---\n${body}`;
  return { source: rewritten, changed: true, conversions };
}

/**
 * 应用转换到解析后的 frontmatter 记录（就地修改）。
 * 返回是否发生任何变更；失败（值形态不支持）返回 false，不产生半成品。
 */
function applyHermesConversions(frontmatter: Record<string, unknown>, conversions: string[]): boolean {
  let changed = false;

  // 1) platforms（真实 Hermes 用复数）→ platform（T2 读单数并做 os 映射）
  if (frontmatter["platform"] === undefined && frontmatter["platforms"] !== undefined) {
    const platforms = frontmatter["platforms"];
    if (typeof platforms === "string") {
      if (platforms.trim().toLowerCase() === "all") {
        frontmatter["platform"] = [...OS_ALL];
        conversions.push("platforms: all → platform: [linux, darwin, win32]");
      } else {
        frontmatter["platform"] = platforms;
        conversions.push("platforms → platform（T2 os 名称映射）");
      }
      changed = true;
    } else if (Array.isArray(platforms) && platforms.every((item) => typeof item === "string")) {
      frontmatter["platform"] = [...platforms];
      conversions.push("platforms → platform（T2 os 名称映射）");
      changed = true;
    } else {
      conversions.push("platforms 形态不支持（既非字符串也非字符串列表），已保留原字段");
    }
  }

  // 2) prerequisites：commands 并入 bins；required_environment 并入 bins；
  //    required_environment_variables 并入 env
  const bins = new Set<string>(stringList(frontmatter["prerequisites"]));
  const env = new Set<string>();
  const prereq = frontmatter["prerequisites"];
  if (isPlainObject(prereq)) {
    for (const key of Object.keys(prereq)) {
      if (key !== "bins" && key !== "env" && key !== "os" && key !== "commands" && key !== "packages") {
        conversions.push(`prerequisites.${key} 保留原字段（不进入 opencolorful.requires）`);
      }
    }
    for (const item of stringList(prereq["bins"])) {
      bins.add(item);
    }
    for (const item of stringList(prereq["env"])) {
      env.add(item);
    }
    for (const item of stringList(prereq["commands"])) {
      bins.add(item);
      if ((prereq["commands"] as unknown) !== undefined) {
        conversions.push("prerequisites.commands → prerequisites.bins");
      }
    }
  }

  if (frontmatter["required_environment"] !== undefined) {
    const items = stringList(frontmatter["required_environment"]);
    if (items.length === 0) {
      conversions.push("required_environment 形态不支持，已保留原字段");
    } else {
      for (const item of items) {
        bins.add(item);
      }
      conversions.push("required_environment → prerequisites.bins");
      changed = true;
    }
  }

  const envVars = parseEnvVariableNames(frontmatter["required_environment_variables"]);
  if (envVars !== null) {
    for (const item of envVars) {
      env.add(item);
    }
    if (envVars.length > 0) {
      conversions.push("required_environment_variables → prerequisites.env（仅变量名）");
      changed = true;
    }
  }

  if (bins.size > 0 || env.size > 0) {
    const merged: Record<string, unknown> = { ...(isPlainObject(prereq) ? prereq : {}) };
    if (bins.size > 0) {
      merged["bins"] = [...bins];
    }
    if (env.size > 0) {
      merged["env"] = [...env];
    }
    frontmatter["prerequisites"] = merged;
    changed = true;
  }

  // 3) user-invocable: false → disable-model-invocation: true（Hermes 语义相反）
  if (frontmatter["user-invocable"] === false && frontmatter["disable-model-invocation"] === undefined) {
    frontmatter["disable-model-invocation"] = true;
    conversions.push("user-invocable: false → disable-model-invocation: true（仅显式触发）");
    changed = true;
  }

  return changed;
}

/** 解析 required_environment_variables：{name} 映射列表或字符串列表 → 变量名列表；形态不支持返回 null。 */
function parseEnvVariableNames(value: unknown): string[] | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() === "" ? null : [value.trim()];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item.trim() !== "") {
        names.push(item.trim());
      }
    } else if (isPlainObject(item)) {
      const name = item["name"];
      if (typeof name === "string" && name.trim() !== "") {
        names.push(name.trim());
      }
    } else {
      return null;
    }
  }
  return names;
}

/** prerequisites 的标量形态 → bins 字符串列表（list → 列表，string → 单元素）。 */
function stringList(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return value.trim() === "" ? [] : [value.trim()];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  }
  if (isPlainObject(value)) {
    return [];
  }
  return [];
}

// ── 确定性 YAML 发射器（受限解析器可读子集）─────────────────────

/**
 * 发射 frontmatter 记录为 YAML 文本（不带 --- 分隔符）。
 * 只输出受限解析器支持的形态：块映射、块/流序列、标量；键值稳定排序
 * （按 Object 键序），结果确定；与 parseYamlFrontmatter 互为 round-trip。
 */
export function emitYamlFrontmatter(record: Record<string, unknown>): string {
  return emitMapping(record, 0).join("\n");
}

function emitMapping(map: Record<string, unknown>, indent: number): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const prefix = `${" ".repeat(indent)}${quoteKey(key)}:`;
    if (isScalar(value)) {
      lines.push(`${prefix} ${emitScalar(value)}`);
    } else if (value === null || value === undefined) {
      lines.push(`${prefix} null`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${prefix} []`);
      } else if (value.every(isScalar)) {
        lines.push(`${prefix} [${value.map((item) => flowValue(item)).join(", ")}]`);
      } else {
        lines.push(prefix);
        lines.push(...emitSequence(value, indent + 2));
      }
    } else if (isPlainObject(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        lines.push(`${prefix} {}`);
      } else {
        lines.push(prefix);
        lines.push(...emitMapping(value as Record<string, unknown>, indent + 2));
      }
    } else {
      // 未知复杂值：安全降级为 null 占位（发射器只处理受限子集；调用方已保证可解析）
      lines.push(`${prefix} null`);
    }
  }
  return lines;
}

function emitSequence(arr: readonly unknown[], indent: number): string[] {
  const lines: string[] = [];
  for (const item of arr) {
    if (isScalar(item) || item === null || item === undefined) {
      lines.push(`${" ".repeat(indent)}- ${item === null || item === undefined ? "null" : emitScalar(item)}`);
    } else if (isPlainObject(item)) {
      lines.push(`${" ".repeat(indent)}- {${Object.entries(item as Record<string, unknown>)
        .map(([k, v]) => `${quoteKey(k)}: ${flowValue(v)}`)
        .join(", ")}}`);
    } else if (Array.isArray(item)) {
      lines.push(`${" ".repeat(indent)}- [${item.map((v) => flowValue(v)).join(", ")}]`);
    } else {
      lines.push(`${" ".repeat(indent)}- null`);
    }
  }
  return lines;
}

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function emitScalar(value: Scalar): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return quoteIfNeeded(value);
}

/** 流上下文值（序列内联）：字符串一律双引号，数组/映射递归为流形态，其余按标量。 */
function flowValue(value: unknown): string {
  if (typeof value === "string") {
    return doubleQuote(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => flowValue(item)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${quoteKey(k)}: ${flowValue(v)}`)
      .join(", ")}}`;
  }
  return "null";
}

function quoteKey(key: string): string {
  return keyNeedsQuote(key) ? doubleQuote(key) : key;
}

/**
 * 与 T2 解析器 parseScalar 精确镜像的歧义检测：值若会被解析为非字符串，
 * 或含破坏块结构的字符，则必须加引号（round-trip 保证）。
 */
function quoteIfNeeded(value: string): string {
  if (value === "") {
    return '""';
  }
  const trimmed = value;
  if (/^-?\d+$/.test(trimmed) || /^-?\d+\.\d+$/.test(trimmed)) {
    return doubleQuote(value);
  }
  if (trimmed === "null" || trimmed === "Null" || trimmed === "~" || trimmed === "true" || trimmed === "True" || trimmed === "TRUE" || trimmed === "false" || trimmed === "False" || trimmed === "FALSE") {
    return doubleQuote(value);
  }
  if (keyNeedsQuote(value)) {
    return doubleQuote(value);
  }
  return value;
}

/** 键/字符串含 YAML 结构字符或首尾空白时需要引号。 */
function keyNeedsQuote(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (/^\s|\s$/.test(value)) {
    return true;
  }
  if (/^[-?:,[\]{}#&*!|>'"%@`~]/.test(value)) {
    return true;
  }
  if (/[\n\t\r]/.test(value)) {
    return true;
  }
  if (/['"\\]/.test(value)) {
    return true;
  }
  if (/: /.test(value) || /:$/.test(value) || / #/.test(value) || /^#/.test(value) || /[:,]/.test(value)) {
    return true;
  }
  return false;
}

/** 双引号字符串（T2 解析器支持的转义子集：\\ \" \n \t \r \b \f \/ \uXXXX）。 */
function doubleQuote(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        if (ch.charCodeAt(0) < 0x20) {
          out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        } else {
          out += ch;
        }
    }
  }
  return `${out}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── 包级入口（Hermes 适配器 staging 使用）────────────────────────

export interface HermesPackageRewriteResult {
  readonly changed: boolean;
  readonly conversions: readonly string[];
}

/**
 * 重写暂存副本（绝不动镜像/原包）：读取 SKILL.md，有转换则原子写回。
 * 返回是否发生改写与转换清单；无转换时文件字节保持不变（内容哈希不变）。
 */
export function rewriteHermesSkillPackage(packageRoot: string): HermesPackageRewriteResult {
  const manifestPath = path.join(packageRoot, "SKILL.md");
  let source: string;
  try {
    source = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return { changed: false, conversions: [] };
  }
  const result = rewriteHermesSkillFrontmatter(source);
  if (!result.changed) {
    return { changed: false, conversions: [] };
  }
  fs.writeFileSync(manifestPath, result.source, "utf8");
  return { changed: true, conversions: result.conversions };
}
