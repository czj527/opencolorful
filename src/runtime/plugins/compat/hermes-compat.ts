import fs from "node:fs";
import path from "node:path";

import Value from "typebox/value";

import {
  CompatibilityReportSchema,
  COMPATIBILITY_LEVELS,
  NormalizedPluginManifestSchema,
  SEMVER_PATTERN,
  type CompatibilityItemStatus,
  type CompatibilityLevel,
  type CompatibilityReport,
  type Contributions,
  type NormalizedPluginManifest,
  type PluginRuntimeKind,
  type PluginTrust,
  type ToolRiskLevel,
} from "../../../contracts/plugin-protocol.js";
import { isPathWithinRoot } from "../paths.js";
import { SourceIntegrityError } from "../sources/source-adapter.js";
import type { ArtifactVerification, PluginSourceRef } from "../sources/source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Hermes → OpenColorful 兼容转换（plans/phase-12.md §12.4）
//
// 输入：Hermes 插件目录（plugin.yaml + Python 入口 + 原始文件）+ sourceRef；
// 输出：NormalizedPluginManifest + CompatibilityReport。
//
// 映射规则：
// - L1 名称/版本/描述/作者/来源/入口（plugin.yaml → 固定 SemVer）；
// - L2 静态 Skills/资源只登记为未激活 skill-bundle，不进入技能系统；
// - L3/L4 工具 Schema 与调用结果/异常/超时/取消映射（toToolContribution /
//   mapHermesToolResult / detectHermesToolFailure）；
// - L5 受支持工具经 hermes-python-bridge（L5 worker）暴露为 OpenColorful Tool；
// - 依赖 Hermes Agent Loop / Gateway / 全局单例 / 内部数据库的插件 →
//   blocked/degraded + 精确中文诊断（detectHermesDependencyIssues）；
// - 不执行插件代码做静态分析：工具通过源码扫描 register_tool(...) 声明获取，
//   运行时注册由 worker 的 Mock PluginContext 完成（hermes-python-bridge）。
//
// 说明：本模块只做映射与报告，不做安装/启用/授权决策；Hermes 的权限声明
// 不被当作 OpenColorful 授权。
// ═══════════════════════════════════════════════════════════════

export const HERMES_MANIFEST_FILE = "plugin.yaml" as const;
/** L5 worker 入口（相对版本目录；由 hermes-python-bridge 具体化）。 */
export const HERMES_WORKER_ENTRY = "_ocf/worker.py" as const;
export const HERMES_WORKER_SUBDIR = "_ocf" as const;

export class HermesCompatError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "HermesCompatError";
    this.reasonCode = reasonCode;
  }
}

// ── Hermes 插件描述（plugin.yaml + 文件系统证据） ─────────────────

export interface HermesPluginDescriptor {
  /** 插件根目录（绝对路径） */
  readonly pluginDir: string;
  /** plugin.yaml 声明的插件名（Hermes 的 id/name 同源） */
  readonly name: string;
  /** 固定 SemVer；缺省拒绝（Hermes 不提供 latest 语义） */
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  /** Python 入口（相对插件根；Hermes 约定 __init__.py，可显式声明 entry） */
  readonly entry: string;
  /** standalone | backend | exclusive | platform */
  readonly kind: string;
  /** plugin.yaml hooks 字段（Hermes 生命周期 Hook 名） */
  readonly hooks: readonly string[];
  /** plugin.yaml provides_tools 字段（静态声明的工具名） */
  readonly providesTools: readonly string[];
  readonly requiresEnv: readonly string[];
  /** 可选：声明需要 pip 安装的 Python 依赖名 */
  readonly dependencies: readonly string[];
  /** 可选：插件声明的受控解释器（绝对路径/venv 内命令），平台只校验不下载 */
  readonly interpreter?: string;
  /** plugin.yaml 原始解析结果（provenance） */
  readonly rawYaml: Record<string, unknown>;
}

export interface HermesStaticTool {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly riskLevel: ToolRiskLevel;
  /** 静态证据：register_tool(...) 所在文件（仅诊断） */
  readonly declaredIn?: string;
}

export type HermesDependencyCode =
  | "agent-loop-hook"
  | "agent-loop-inject"
  | "gateway-platform"
  | "internal-module"
  | "internal-db"
  | "host-llm"
  | "cli-singleton"
  | "tool-override"
  | "host-env"
  | "python-deps";

export interface HermesHostDependencyIssue {
  readonly code: HermesDependencyCode;
  readonly severity: "blocked" | "degraded";
  readonly message: string;
  /** 静态证据（import 行 / 字段名），仅诊断展示 */
  readonly evidence?: string;
}

// ── YAML 子集解析（plugin.yaml；无第三方依赖） ─────────────────────
//
// 只支持 Hermes plugin.yaml 实际用到的子集：注释、缩进映射、列表、
// 引号字符串、布尔/数字/空值；未知标量按字符串处理（宽容解析 +
// 精确诊断原则）。

interface YamlLine {
  readonly indent: number;
  readonly text: string;
}

/** 解析 Hermes plugin.yaml 文本为记录；非映射内容返回 {}。 */
export function parseHermesYaml(text: string): Record<string, unknown> {
  const lines: YamlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripYamlComment(raw);
    if (stripped.trim() === "") {
      continue;
    }
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  const first = lines[0];
  if (first === undefined) {
    return {};
  }
  const parsed = parseBlock(lines, 0, first.indent).value;
  return isRecord(parsed) ? parsed : {};
}

function stripYamlComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseBlock(
  lines: readonly YamlLine[],
  index: number,
  baseIndent: number,
): { readonly value: unknown; readonly next: number } {
  const line = lines[index];
  if (line === undefined) {
    return { value: undefined, next: index };
  }
  if (line.text.startsWith("- ")) {
    return parseList(lines, index, baseIndent);
  }
  return parseMap(lines, index, baseIndent);
}

function parseMap(
  lines: readonly YamlLine[],
  start: number,
  baseIndent: number,
): { readonly value: Record<string, unknown>; readonly next: number } {
  const map: Record<string, unknown> = {};
  let index = start;
  for (;;) {
    const line = lines[index];
    if (line === undefined || line.indent < baseIndent || line.text.startsWith("- ")) {
      break;
    }
    if (line.indent > baseIndent) {
      index += 1;
      continue;
    }
    const separator = indexOfYamlColon(line.text);
    if (separator === -1) {
      index += 1;
      continue;
    }
    const key = stripQuotes(line.text.slice(0, separator).trim());
    if (key === "") {
      index += 1;
      continue;
    }
    const rest = line.text.slice(separator + 1).trim();
    if (rest === "") {
      const nextLine = lines[index + 1];
      if (nextLine !== undefined && nextLine.indent > baseIndent) {
        const nested = parseBlock(lines, index + 1, nextLine.indent);
        map[key] = nested.value;
        index = nested.next;
      } else {
        map[key] = null;
        index += 1;
      }
      continue;
    }
    map[key] = parseScalar(rest);
    index += 1;
  }
  return { value: map, next: index };
}

function parseList(
  lines: readonly YamlLine[],
  start: number,
  baseIndent: number,
): { readonly value: unknown[]; readonly next: number } {
  const list: unknown[] = [];
  let index = start;
  for (;;) {
    const line = lines[index];
    if (line === undefined || line.indent < baseIndent) {
      break;
    }
    if (line.indent > baseIndent || !line.text.startsWith("- ")) {
      index += 1;
      continue;
    }
    const rest = line.text.slice(2).trim();
    if (rest === "") {
      const nextLine = lines[index + 1];
      if (nextLine !== undefined && nextLine.indent > baseIndent) {
        const nested = parseBlock(lines, index + 1, nextLine.indent);
        list.push(nested.value);
        index = nested.next;
      } else {
        list.push(null);
        index += 1;
      }
      continue;
    }
    const separator = indexOfYamlColon(rest);
    if (separator !== -1) {
      // "- key: value" → 单键内联映射（嵌套块归给该键）
      const key = stripQuotes(rest.slice(0, separator).trim());
      const valueText = rest.slice(separator + 1).trim();
      const nextLine = lines[index + 1];
      if (valueText === "" && nextLine !== undefined && nextLine.indent > baseIndent) {
        const nested = parseBlock(lines, index + 1, nextLine.indent);
        list.push({ [key]: nested.value });
        index = nested.next;
      } else {
        list.push({ [key]: valueText === "" ? null : parseScalar(valueText) });
        index += 1;
      }
      continue;
    }
    list.push(parseScalar(rest));
    index += 1;
  }
  return { value: list, next: index };
}

/** 跳过已消费的嵌套块（indent > baseIndent 的行），返回下一个顶层行下标。 */

function indexOfYamlColon(text: string): number {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "]" || char === "}" || char === ")") {
      depth -= 1;
      continue;
    }
    if (char === ":" && depth === 0) {
      return i;
    }
  }
  return -1;
}

function stripQuotes(value: string): string {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0] as string;
    const last = text[text.length - 1] as string;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function parseScalar(text: string): unknown {
  const value = text.trim();
  if (value === "") {
    return null;
  }
  const first = value[0] as string;
  const last = value[value.length - 1] as string;
  if (first === '"' && last === '"') {
    return value.slice(1, -1);
  }
  if (first === "'" && last === "'") {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

// ── Hermes 插件目录识别 ──────────────────────────────────────────

/** 判断目录是否包含 Hermes plugin.yaml（L1 识别入口）。 */
export function detectHermesPluginDir(dir: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(dir, HERMES_MANIFEST_FILE));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 读取并解析 Hermes 插件目录；缺 plugin.yaml / version / 入口抛完整性错误。 */
export function readHermesPluginDir(pluginDir: string): HermesPluginDescriptor {
  const manifestPath = path.join(pluginDir, HERMES_MANIFEST_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new SourceIntegrityError("hermes_manifest_missing", "Hermes 插件包缺少 plugin.yaml");
  }
  const yaml = parseHermesYaml(raw);
  const name = stringField(yaml, "name");
  if (name === undefined || name === "") {
    throw new SourceIntegrityError("hermes_name_missing", "Hermes plugin.yaml 缺少 name");
  }
  const version = stringField(yaml, "version");
  if (version === undefined || !new RegExp(SEMVER_PATTERN).test(version.trim())) {
    throw new SourceIntegrityError(
      "hermes_version_invalid",
      `Hermes 插件版本不是合法 SemVer：${version ?? "(缺省)"}（Hermes 来源不支持 latest，必须固定版本）`,
    );
  }
  const declaredEntry = stringField(yaml, "entry") ?? "__init__.py";
  const entryPath = path.resolve(pluginDir, declaredEntry);
  if (!isPathWithinRoot(entryPath, pluginDir) || !declaredEntry.endsWith(".py")) {
    throw new SourceIntegrityError("hermes_entry_invalid", `Hermes 插件入口不是受控 Python 文件：${declaredEntry}`);
  }
  const entryStat = fs.existsSync(entryPath) ? fs.lstatSync(entryPath) : undefined;
  if (entryStat === undefined || !entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new SourceIntegrityError("hermes_entry_missing", `Hermes 插件 Python 入口不存在：${declaredEntry}`);
  }
  const hooks = stringListField(yaml, "hooks");
  const providesTools = stringListField(yaml, "provides_tools");
  const requiresEnv = stringListField(yaml, "requires_env");
  const dependencies = stringListField(yaml, "dependencies");
  const interpreter = stringField(yaml, "interpreter");
  const kind = stringField(yaml, "kind") ?? "standalone";
  const descriptor: HermesPluginDescriptor = {
    pluginDir,
    name,
    version: version.trim(),
    ...(typeof stringField(yaml, "description") === "string" ? { description: stringField(yaml, "description") as string } : {}),
    ...(typeof stringField(yaml, "author") === "string" ? { author: stringField(yaml, "author") as string } : {}),
    entry: declaredEntry,
    kind,
    hooks,
    providesTools,
    requiresEnv,
    dependencies,
    ...(interpreter !== undefined && interpreter !== "" ? { interpreter } : {}),
    rawYaml: yaml,
  };
  return descriptor;
}

function stringField(yaml: Record<string, unknown>, key: string): string | undefined {
  const value = yaml[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringListField(yaml: Record<string, unknown>, key: string): readonly string[] {
  const value = yaml[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

// ── Hermes 宿主依赖诊断（Agent Loop / Gateway / 全局单例 / 内部 DB） ──

const HERMES_HOST_IMPORT_PREFIXES = ["hermes_cli", "hermes_constants", "hermes_agent", "hermes."] as const;

/** 静态扫描 Python 源码中的 Hermes 宿主能力使用点并给出精确中文诊断。 */
export function detectHermesDependencyIssues(descriptor: HermesPluginDescriptor): readonly HermesHostDependencyIssue[] {
  const issues: HermesHostDependencyIssue[] = [];
  const push = (code: HermesDependencyCode, severity: "blocked" | "degraded", message: string, evidence?: string): void => {
    issues.push(evidence === undefined ? { code, severity, message } : { code, severity, message, evidence });
  };

  // 生命周期 Hook（Agent Loop）
  for (const hook of descriptor.hooks) {
    push(
      "agent-loop-hook",
      "blocked",
      `Hermes 生命周期 Hook「${hook}」依赖 Hermes Agent Loop 的调用时机，OpenColorful 不提供等价 Hook 点，无法运行`,
      `plugin.yaml hooks.${hook}`,
    );
  }

  // Platform 插件（Gateway）
  if (descriptor.kind === "platform") {
    push(
      "gateway-platform",
      "blocked",
      "Hermes Platform 插件（kind=platform）依赖 Hermes Gateway 消息网关，OpenColorful 不提供等价平台适配，无法运行",
      "plugin.yaml kind=platform",
    );
  }

  // 环境变量与 Python 依赖（degraded：需插件专属环境显式提供）
  if (descriptor.requiresEnv.length > 0) {
    push(
      "host-env",
      "degraded",
      `声明依赖 Hermes 宿主环境变量（${descriptor.requiresEnv.join("、")}），OpenColorful 不自动注入，需在受控环境中显式提供`,
    );
  }
  if (descriptor.dependencies.length > 0) {
    push(
      "python-deps",
      "degraded",
      `声明 Python 依赖（${descriptor.dependencies.join("、")}），需要插件专属环境安装；平台不自动下载解释器、不执行 pip install，请声明受控解释器/venv 或内置依赖`,
    );
  }

  // Python 源码静态扫描（只读，不执行）
  const pySources = readPythonSources(descriptor.pluginDir);
  for (const file of pySources) {
    const source = fs.readFileSync(file, "utf8");
    const relFile = path.relative(descriptor.pluginDir, file).replace(/\\/g, "/");

    // 内部模块 import（全局单例 / 内部数据库 / CLI 单例）
    for (const line of splitLines(source)) {
      const trimmed = line.trim();
      if (!/^\s*(import|from)\s+/.test(trimmed)) {
        continue;
      }
      const moduleName = /^(?:from\s+)?([A-Za-z0-9_.]+)/.exec(trimmed)?.[1];
      if (moduleName === undefined) {
        continue;
      }
      const matchesHostPrefix = HERMES_HOST_IMPORT_PREFIXES.some(
        (prefix) => moduleName === prefix || moduleName.startsWith(prefix),
      );
      if (matchesHostPrefix) {
        push(
          "internal-module",
          "blocked",
          `Python 入口 import 了 Hermes 宿主内部模块「${moduleName}」，这些模块依赖 Hermes 进程内全局单例与内部数据库，OpenColorful 无法提供`,
          `${relFile}: ${trimmed.slice(0, 120)}`,
        );
      }
    }

    // 内部数据库 / 日志库写入
    if (/(sqlite3\.connect|create_engine|\.db\b|HERMES_HOME.*(?:logs|db))/i.test(source)) {
      push(
        "internal-db",
        "blocked",
        "插件疑似直接访问 Hermes 内部数据库/日志目录（sqlite3/.db/HERMES_HOME），OpenColorful 不开放宿主内部存储，拒绝运行",
        relFile,
      );
    }

    // Host LLM 门面
    if (/\.llm\b/.test(source)) {
      push(
        "host-llm",
        "blocked",
        "插件使用 Hermes PluginContext.llm（宿主托管的模型门面），OpenColorful 不向外部插件开放模型调用，无法运行",
        relFile,
      );
    }

    // Agent Loop 消息注入
    if (/\binject_message\s*\(/.test(source)) {
      push(
        "agent-loop-inject",
        "blocked",
        "插件使用 Hermes inject_message 向活跃会话注入消息，依赖 Agent Loop 的运行时队列，OpenColorful 不支持",
        relFile,
      );
    }

    // CLI 全局单例
    if (/_cli_ref|_interrupt_queue|_pending_input/.test(source)) {
      push(
        "cli-singleton",
        "blocked",
        "插件访问 Hermes CLI 进程内全局单例（_cli_ref/_interrupt_queue/_pending_input），OpenColorful 不在交互 CLI 进程内运行插件代码",
        relFile,
      );
    }

    // 工具 override（信任门控）
    if (/register_tool\s*\([\s\S]*?override\s*=\s*True|register_tool\s*\([\s\S]*?override=True/.test(source)) {
      push(
        "tool-override",
        "blocked",
        "插件试图以 override 替换 Hermes 内置工具，OpenColorful 不允许外部插件覆盖平台内置工具，已拒绝",
        relFile,
      );
    }
  }
  return issues;
}

function readPythonSources(pluginDir: string): readonly string[] {
  const files: string[] = [];
  const pending = [pluginDir];
  const exclude = new Set([HERMES_WORKER_SUBDIR, ".git", "__pycache__"]);
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!exclude.has(entry.name)) {
          pending.push(path.join(current, entry.name));
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".py")) {
        files.push(path.join(current, entry.name));
      }
    }
  }
  return files;
}

function splitLines(source: string): readonly string[] {
  return source.split(/\r?\n/);
}

// ── 静态工具扫描（register_tool 调用；只读，不执行） ───────────────

/** 扫描插件 Python 源码中的 register_tool(...) 声明（L3/L4 工具 Schema 映射）。 */
export function scanStaticTools(descriptor: HermesPluginDescriptor): readonly HermesStaticTool[] {
  const tools: HermesStaticTool[] = [];
  const seen = new Set<string>();
  for (const file of readPythonSources(descriptor.pluginDir)) {
    const source = fs.readFileSync(file, "utf8");
    for (const call of extractCallSites(source, "register_tool")) {
      const args = splitTopLevelArgs(call.inner);
      const named = parseNamedArgs(args);
      const rawName = named.name ?? (typeof args[0] === "string" ? args[0] : undefined);
      const name = typeof rawName === "string" ? rawName : undefined;
      if (name === undefined || name === "") {
        continue;
      }
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const description = typeof named.description === "string" ? named.description : undefined;
      const schema = mapHermesToolSchema(named.schema);
      const relFile = path.relative(descriptor.pluginDir, file).replace(/\\/g, "/");
      const tool: HermesStaticTool = {
        id: name,
        name,
        ...(description !== undefined ? { description } : {}),
        ...(schema !== undefined ? { inputSchema: schema } : {}),
        riskLevel: "medium",
        declaredIn: relFile,
      };
      tools.push(tool);
    }
  }
  // plugin.yaml provides_tools 里声明但源码未扫描到的工具 → degraded 提示
  return tools;
}

interface CallSite {
  readonly inner: string;
}

/** 提取 fnName( ... ) 调用点（顶层括号内文本；跳过字符串与注释）。 */
function extractCallSites(source: string, fnName: string): readonly CallSite[] {
  const sites: CallSite[] = [];
  let cursor = 0;
  for (;;) {
    const at = source.indexOf(fnName, cursor);
    if (at === -1) {
      break;
    }
    cursor = at + fnName.length;
    let open = -1;
    for (let i = cursor; i < source.length; i += 1) {
      const char = source[i] as string;
      if (char === "(") {
        open = i;
        break;
      }
      if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
        break; // 不是调用（如属性名）
      }
    }
    if (open === -1) {
      continue;
    }
    const closing = findClosingParen(source, open);
    if (closing === -1) {
      continue;
    }
    sites.push({ inner: source.slice(open + 1, closing) });
    cursor = closing + 1;
  }
  return sites;
}

function findClosingParen(source: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let triple = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quote !== null) {
      if (triple) {
        if (char === quote && source[i + 1] === quote && source[i + 2] === quote) {
          i += 2;
          quote = null;
          triple = false;
        }
      } else if (char === "\\") {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      triple = source[i + 1] === char && source[i + 2] === char;
      if (triple) {
        i += 2;
      }
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 按顶层逗号切分参数（跳过字符串/括号/注释）。 */
function splitTopLevelArgs(inner: string): readonly string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] as string;
    if (quote !== null) {
      if (char === "\\") {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last !== "") {
    args.push(last);
  }
  return args;
}

function parseNamedArgs(args: readonly string[]): Record<string, unknown> {
  const named: Record<string, unknown> = {};
  for (const arg of args) {
    const trimmed = arg.trim();
    if (trimmed === "") {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(trimmed);
    if (match === null) {
      continue;
    }
    const key = match[1] as string;
    const valueText = (match[2] as string).trim();
    named[key] = parseNamedValue(valueText);
  }
  return named;
}

/** 解析 register_tool 具名参数：引号字符串 / 数字 / True/False/None / 字典/列表字面量。 */
function parseNamedValue(text: string): unknown {
  const value = text.trim();
  if (value === "") {
    return undefined;
  }
  const first = value[0] as string;
  const last = value[value.length - 1] as string;
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  if (first === "{" || first === "[") {
    try {
      return parsePythonLiteral(value);
    } catch {
      return undefined;
    }
  }
  if (value === "True") return true;
  if (value === "False") return false;
  if (value === "None") return null;
  if (/^-?\d+\.?\d*$/.test(value)) return Number(value);
  return value;
}

// ── Python 字典/列表字面量（静态 Schema 提取；Python/JS 子集） ──

interface LiteralState {
  readonly text: string;
  pos: number;
}

function parsePythonLiteral(text: string): unknown {
  const state: LiteralState = { text: text.trim(), pos: 0 };
  return parseLiteralValue(state);
}

function skipLiteralWs(state: LiteralState): void {
  while (state.pos < state.text.length && /\s/.test(state.text[state.pos] as string)) {
    state.pos += 1;
  }
}

function parseLiteralValue(state: LiteralState): unknown {
  skipLiteralWs(state);
  const char = state.text[state.pos];
  if (char === "{") return parseLiteralObject(state);
  if (char === "[") return parseLiteralArray(state);
  if (char === '"' || char === "'") return parseLiteralString(state);
  const match = /^([A-Za-z0-9_.\-+]+)/.exec(state.text.slice(state.pos));
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  state.pos += match[1].length;
  const token = match[1];
  if (token === "true" || token === "True") return true;
  if (token === "false" || token === "False") return false;
  if (token === "null" || token === "None") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
  return token;
}

function parseLiteralString(state: LiteralState): string {
  const quote = state.text[state.pos] as "'" | '"';
  state.pos += 1;
  let result = "";
  for (;;) {
    const char = state.text[state.pos];
    if (char === undefined) {
      break;
    }
    if (char === quote) {
      state.pos += 1;
      break;
    }
    if (char === "\\") {
      const next = state.text[state.pos + 1];
      if (next === "n") result += "\n";
      else if (next === "t") result += "\t";
      else if (next !== undefined) result += next;
      state.pos += 2;
      continue;
    }
    result += char;
    state.pos += 1;
  }
  return result;
}

function parseLiteralObject(state: LiteralState): Record<string, unknown> {
  state.pos += 1; // {
  const result: Record<string, unknown> = {};
  for (;;) {
    skipLiteralWs(state);
    if (state.text[state.pos] === "}") {
      state.pos += 1;
      break;
    }
    const key = parseLiteralObjectKey(state);
    skipLiteralWs(state);
    if (state.text[state.pos] === ":") {
      state.pos += 1;
    }
    skipLiteralWs(state);
    const value = parseLiteralValue(state);
    if (key !== undefined) {
      result[key] = value;
    }
    skipLiteralWs(state);
    if (state.text[state.pos] === ",") {
      state.pos += 1;
    } else if (state.text[state.pos] === "}") {
      state.pos += 1;
      break;
    }
  }
  return result;
}

function parseLiteralObjectKey(state: LiteralState): string | undefined {
  skipLiteralWs(state);
  const char = state.text[state.pos];
  if (char === '"' || char === "'") {
    return parseLiteralString(state);
  }
  const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(state.text.slice(state.pos));
  if (match === null || match[0] === undefined) {
    return undefined;
  }
  state.pos += match[0].length;
  return match[0];
}

function parseLiteralArray(state: LiteralState): unknown[] {
  state.pos += 1; // [
  const result: unknown[] = [];
  for (;;) {
    skipLiteralWs(state);
    if (state.text[state.pos] === "]") {
      state.pos += 1;
      break;
    }
    result.push(parseLiteralValue(state));
    skipLiteralWs(state);
    if (state.text[state.pos] === ",") {
      state.pos += 1;
    } else if (state.text[state.pos] === "]") {
      state.pos += 1;
      break;
    }
  }
  return result;
}

/** Hermes 工具 Schema（JSON Schema 字典字面量）→ OpenColorful inputSchema。 */
export function mapHermesToolSchema(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }
  return raw;
}

// ── 工具调用结果 / 异常 / 超时 / 取消映射 ─────────────────────────

export interface HermesToolFailure {
  readonly code:
    | "tool-error"
    | "result-not-serializable"
    | "tool-not-found"
    | "timeout"
    | "cancelled"
    | "worker-crashed"
    | "worker-error";
  readonly message: string;
  readonly data?: {
    readonly type?: string;
    readonly traceback?: string;
    readonly stderrTail?: string;
    readonly exitCode?: number | null;
  };
}

/** worker 回传的错误标记（成功帧内嵌，避免污染 JSON-RPC error 语义）。 */
const HERMES_TOOL_ERROR_MARKER = "__ocf_hermes_error__" as const;

/** 检测 worker 结果帧是否携带 Hermes 工具级错误（Python 异常/结果不可序列化）。 */
export function detectHermesToolFailure(result: unknown): HermesToolFailure | null {
  if (!isRecord(result) || result[HERMES_TOOL_ERROR_MARKER] !== true) {
    return null;
  }
  const type = typeof result.type === "string" ? result.type : undefined;
  const traceback = typeof result.traceback === "string" ? result.traceback : undefined;
  const message = typeof result.message === "string" && result.message.length > 0 ? result.message : "Hermes 工具执行失败";
  const code = type === "ResultNotSerializable" ? "result-not-serializable" : "tool-error";
  const data = type !== undefined || traceback !== undefined ? { ...(type !== undefined ? { type } : {}), ...(traceback !== undefined ? { traceback } : {}) } : undefined;
  return data === undefined ? { code, message } : { code, message, data };
}

/** 工具结果映射：Hermes 返回 → OpenColorful Tool 调用结果（异常经统一诊断）。 */
export function mapHermesToolResult(result: unknown): { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly failure: HermesToolFailure } {
  const failure = detectHermesToolFailure(result);
  if (failure !== null) {
    return { ok: false, failure };
  }
  return { ok: true, result };
}

// ── 规范化清单与兼容报告构建 ─────────────────────────────────────

export interface HermesConversionInput {
  readonly descriptor: HermesPluginDescriptor;
  readonly sourceRef: PluginSourceRef;
  readonly verification: ArtifactVerification;
  readonly provenance?: unknown;
  /** 当前 OpenColorful 宿主版本（plugin.yaml 未声明范围时默认 *）。 */
  readonly hostVersion: string;
}

export interface HermesConversionResult {
  readonly normalized: NormalizedPluginManifest;
  readonly compatibility: CompatibilityReport;
  readonly staticTools: readonly HermesStaticTool[];
  readonly issues: readonly HermesHostDependencyIssue[];
  readonly warnings: readonly string[];
}

/** Hermes 插件名 → 合法插件 ID（小写、非字母数字转 -、前缀校验）。 */
export function normalizeHermesPluginId(rawName: string): { readonly pluginId: string; readonly changed: boolean } {
  const trimmed = rawName.trim();
  const sanitized = trimmed.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(sanitized)) {
    throw new HermesCompatError("hermes_id_invalid", `Hermes 插件名「${rawName}」无法转换为合法插件 ID`);
  }
  return { pluginId: sanitized, changed: sanitized !== trimmed };
}

/** Hermes 插件 → NormalizedPluginManifest + CompatibilityReport（主转换入口）。 */
export function convertHermesPlugin(input: HermesConversionInput): HermesConversionResult {
  const warnings: string[] = [];
  const { pluginId, changed } = normalizeHermesPluginId(input.descriptor.name);
  if (changed) {
    warnings.push(`Hermes 插件名「${input.descriptor.name}」不满足插件 ID 规则，已归一化为「${pluginId}」`);
  }
  const version = input.descriptor.version.trim();
  if (!new RegExp(SEMVER_PATTERN).test(version)) {
    throw new HermesCompatError("hermes_version_invalid", `Hermes 插件版本不是合法 SemVer：${version}`);
  }

  const staticTools = scanStaticTools(input.descriptor);
  const issues = detectHermesDependencyIssues(input.descriptor);

  // 静态声明的工具（provides_tools）但源码未扫描到 register_tool
  for (const declared of input.descriptor.providesTools) {
    if (!staticTools.some((tool) => tool.name === declared)) {
      warnings.push(`Hermes 声明提供了工具「${declared}」，但源码中未扫描到 register_tool 声明（运行时由 worker 校验）`);
    }
  }

  const normalized = buildNormalizedManifest(input, pluginId, version, staticTools);
  if (!Value.Check(NormalizedPluginManifestSchema, normalized)) {
    throw new HermesCompatError("hermes_normalized_invalid", "Hermes 插件转换后的规范化清单不符合 OpenColorful 契约");
  }
  const compatibility = buildHermesCompatibilityReport(input.descriptor, pluginId, version, staticTools, issues, normalized);
  if (!Value.Check(CompatibilityReportSchema, compatibility)) {
    throw new HermesCompatError("hermes_report_invalid", "Hermes 插件兼容性报告不符合契约");
  }
  return { normalized, compatibility, staticTools, issues, warnings };
}

function buildNormalizedManifest(
  input: HermesConversionInput,
  pluginId: string,
  version: string,
  staticTools: readonly HermesStaticTool[],
): NormalizedPluginManifest {
  const contributions = collectContributions(input.descriptor, pluginId, staticTools);
  const hasTools = staticTools.length > 0;
  const runtime: { readonly kind: PluginRuntimeKind; readonly entry?: string } = hasTools
    ? { kind: "python-process", entry: HERMES_WORKER_ENTRY }
    : { kind: "bundle" };
  const trust: PluginTrust = runtime.kind === "python-process" ? "full-access" : "restricted";
  const permissions = hasTools ? [{ capability: "tool.register" as const, reason: "Hermes 工具映射到 OpenColorful 工具" }] : [];

  return {
    id: pluginId,
    name: input.descriptor.name,
    version,
    ...(input.descriptor.description !== undefined ? { description: input.descriptor.description } : {}),
    ...(input.descriptor.author !== undefined ? { author: { name: input.descriptor.author } } : {}),
    compatibility: { opencolorful: "*", pluginApi: 1 },
    trust,
    runtime,
    permissions,
    contributions,
    source: {
      sourceRef: {
        sourceType: "hermes",
        ref: input.sourceRef.ref,
        ...(input.sourceRef.version !== undefined ? { version: input.sourceRef.version } : {}),
      },
      verification: {
        sha256: input.verification.sha256,
        sizeBytes: input.verification.sizeBytes,
        ...(input.verification.provenance !== undefined ? { provenance: input.verification.provenance } : {}),
      },
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    },
    normalizedAt: new Date().toISOString(),
  };
}

function collectContributions(
  descriptor: HermesPluginDescriptor,
  pluginId: string,
  staticTools: readonly HermesStaticTool[],
): Contributions {
  const contributions: Contributions = {};
  const tools = staticTools.map((tool) => {
    const base: { id: string; name: string; description?: string; inputSchema?: unknown; riskLevel?: ToolRiskLevel } = {
      id: tool.id,
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      riskLevel: tool.riskLevel,
    };
    return base;
  });
  if (tools.length > 0) {
    contributions.tool = tools;
  }
  const skillsDir = path.join(descriptor.pluginDir, "skills");
  if (fs.existsSync(skillsDir) && fs.lstatSync(skillsDir).isDirectory()) {
    contributions["skill-bundle"] = [
      {
        id: "skills",
        name: `${pluginId} 静态技能`,
        description: "Hermes 插件携带的静态 Skills/资源（仅登记，不激活）",
        skillsDir: "skills",
      },
    ];
  }
  return contributions;
}

// ── 兼容性报告（L1-L6；Hermes 专属诊断并入 blocked/degraded） ──────

function buildHermesCompatibilityReport(
  descriptor: HermesPluginDescriptor,
  pluginId: string,
  version: string,
  staticTools: readonly HermesStaticTool[],
  issues: readonly HermesHostDependencyIssue[],
  normalized: NormalizedPluginManifest,
): CompatibilityReport {
  const contributions: Array<{ id: string; kind: string; status: CompatibilityItemStatus; reason?: string }> = [];
  const missingCapabilities: string[] = [];
  const blockedReasons: string[] = [];
  let level: CompatibilityLevel = "L1";

  const considerLevel = (candidate: CompatibilityLevel): void => {
    if (COMPATIBILITY_LEVELS.indexOf(candidate) > COMPATIBILITY_LEVELS.indexOf(level)) {
      level = candidate;
    }
  };
  const push = (id: string, kind: string, status: CompatibilityItemStatus, reason?: string): void => {
    contributions.push(reason === undefined ? { id, kind, status } : { id, kind, status, reason });
  };

  // L4 工具
  for (const tool of staticTools) {
    considerLevel("L4");
    push(tool.id, "tool", "supported");
  }

  // L2 静态 Skills（只登记不激活）
  if (fs.existsSync(path.join(descriptor.pluginDir, "skills"))) {
    push("skills", "skill-bundle", "supported", "仅登记为未激活资源，技能系统未启用");
    considerLevel("L2");
  }

  // L5 Python 运行形态（受支持工具经 L5 worker 暴露）
  if (normalized.runtime.kind === "python-process") {
    considerLevel("L5");
  }

  // ── Hermes 专属能力 → blocked/degraded + 精确中文诊断 ──────────
  for (const issue of issues) {
    push(`hermes.${issue.code}`, issue.code, issue.severity, issue.message);
    if (issue.severity === "blocked") {
      blockedReasons.push(issue.message);
    } else {
      missingCapabilities.push(issue.code);
    }
  }

  // 声明了工具但运行时无法提供（全部 blocked）时标记为不可运行
  const requiresFullAccess = normalized.trust === "full-access";
  const requiresRuntime = normalized.runtime.kind === "bundle" ? undefined : normalized.runtime.kind;

  return {
    pluginId,
    version,
    level,
    supported: blockedReasons.length === 0,
    missingCapabilities: Array.from(new Set(missingCapabilities)),
    contributions,
    blockedReasons,
    requiresFullAccess,
    ...(requiresRuntime !== undefined ? { requiresRuntime } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
