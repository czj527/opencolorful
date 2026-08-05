import type { SkillDocument, SkillErrorCode } from "../../contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 SKILL.md frontmatter 解析（plans/phase-13.md §7.1/§7.2）
//
// - 无 frontmatter 视为 invalid（fail-closed，不猜测语义）；
// - 自包含的受限 YAML 子集解析器（映射/序列/流集合/块标量/引号/注释），
//   不引入外部 YAML 依赖，拒绝锚点/标签等不可控特性；
// - 解析失败返回显式 reasonCode（skill_manifest_invalid），不静默降级；
// - 未知字段保留在 frontmatter 原始对象，由 manifest.ts 决定是否进入 rawFrontmatter。
// ═══════════════════════════════════════════════════════════════

export const MAX_SKILL_FRONTMATTER_BYTES = 64 * 1024;

export type ParseSkillDocumentResult =
  | { readonly ok: true; readonly document: SkillDocument }
  | { readonly ok: false; readonly reasonCode: SkillErrorCode; readonly reason: string };

export class FrontmatterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterParseError";
  }
}

/** 解析 SKILL.md 全文：提取 `---` 分隔的 frontmatter 与正文。 */
export function parseSkillDocument(source: string): ParseSkillDocumentResult {
  const text = source.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const first = lines[0] ?? "";
  if (first.trimEnd() !== "---") {
    return { ok: false, reasonCode: "skill_manifest_invalid", reason: "缺少 YAML frontmatter（SKILL.md 必须以 --- 开头）" };
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
    return { ok: false, reasonCode: "skill_manifest_invalid", reason: "frontmatter 未闭合（缺少结尾 --- 分隔符）" };
  }
  const fmText = lines.slice(1, close).join("\n");
  if (fmText.length > MAX_SKILL_FRONTMATTER_BYTES) {
    return { ok: false, reasonCode: "skill_manifest_invalid", reason: `frontmatter 超过大小上限（${MAX_SKILL_FRONTMATTER_BYTES} 字节）` };
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYamlFrontmatter(fmText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reasonCode: "skill_manifest_invalid", reason: `frontmatter YAML 解析失败：${message}` };
  }
  const body = lines.slice(close + 1).join("\n");
  return { ok: true, document: { frontmatter, body } };
}

// ── 受限 YAML 子集解析 ─────────────────────────────────────────

interface YamlLine {
  readonly raw: string;
  readonly indent: number;
  readonly blank: boolean;
}

interface YamlState {
  readonly lines: readonly YamlLine[];
  pos: number;
}

const BLOCK_SCALAR_INDICATORS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

export function parseYamlFrontmatter(text: string): Record<string, unknown> {
  const lines = toYamlLines(text);
  const state: YamlState = { lines, pos: 0 };
  const value = parseBlock(state, 0);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FrontmatterParseError("frontmatter 顶层必须是键值映射");
  }
  return value as Record<string, unknown>;
}

function toYamlLines(text: string): readonly YamlLine[] {
  const lines: YamlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("\t")) {
      throw new FrontmatterParseError("frontmatter 不允许 tab 缩进");
    }
    const indent = raw.length - raw.trimStart().length;
    lines.push({ raw, indent, blank: raw.trim() === "" });
  }
  return lines;
}

function parseBlock(state: YamlState, indent: number): unknown {
  skipBlank(state);
  if (state.pos >= state.lines.length) {
    return null;
  }
  const line = state.lines[state.pos];
  if (line === undefined) {
    return null;
  }
  return isSequenceItem(stripComment(line.raw.trim())) ? parseSequence(state, indent) : parseMapping(state, indent);
}

function parseMapping(state: YamlState, indent: number): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (;;) {
    skipBlank(state);
    if (state.pos >= state.lines.length) {
      break;
    }
    const line = state.lines[state.pos];
    if (line === undefined) {
      break;
    }
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new FrontmatterParseError(`缩进错误（第 ${state.pos + 1} 行不应比父级更深）`);
    }
    const content = stripComment(line.raw.trim());
    if (content === "" ) {
      state.pos += 1;
      continue;
    }
    if (isSequenceItem(content)) {
      throw new FrontmatterParseError("序列项混入映射块，已拒绝");
    }
    const kv = splitKeyValue(content);
    if (kv === null) {
      throw new FrontmatterParseError(`无法解析键值行："${content}"`);
    }
    const key = unquoteKey(kv.key);
    if (key.length === 0) {
      throw new FrontmatterParseError("frontmatter 键不能为空");
    }
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new FrontmatterParseError(`frontmatter 出现重复键："${key}"`);
    }
    state.pos += 1;
    const rest = kv.rest.trim();
    if (rest === "") {
      skipBlank(state);
      if (state.pos < state.lines.length) {
        const next = state.lines[state.pos];
        if (next !== undefined && !next.blank && next.indent > indent) {
          map[key] = parseBlock(state, next.indent);
          continue;
        }
      }
      map[key] = null;
      continue;
    }
    map[key] = parseInlineValue(state, indent, rest);
  }
  return map;
}

function parseSequence(state: YamlState, indent: number): unknown[] {
  const arr: unknown[] = [];
  for (;;) {
    skipBlank(state);
    if (state.pos >= state.lines.length) {
      break;
    }
    const line = state.lines[state.pos];
    if (line === undefined) {
      break;
    }
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new FrontmatterParseError(`序列缩进错误（第 ${state.pos + 1} 行）`);
    }
    const content = stripComment(line.raw.trim());
    if (!isSequenceItem(content)) {
      break;
    }
    state.pos += 1;
    const rest = content.slice(1).trim();
    if (rest === "") {
      skipBlank(state);
      if (state.pos < state.lines.length) {
        const next = state.lines[state.pos];
        if (next !== undefined && !next.blank && next.indent > indent) {
          arr.push(parseBlock(state, next.indent));
          continue;
        }
      }
      arr.push(null);
      continue;
    }
    arr.push(parseInlineValue(state, indent, rest));
  }
  return arr;
}

function parseInlineValue(state: YamlState, parentIndent: number, rest: string): unknown {
  if (BLOCK_SCALAR_INDICATORS.has(rest)) {
    return parseBlockScalar(state, parentIndent, rest);
  }
  if (rest.startsWith("[")) {
    return parseFlowValue(rest);
  }
  if (rest.startsWith("{")) {
    return parseFlowValue(rest);
  }
  return parseScalar(rest);
}

function parseBlockScalar(state: YamlState, parentIndent: number, indicator: string): string {
  let blockIndent: number | null = null;
  const collected: string[] = [];
  for (;;) {
    if (state.pos >= state.lines.length) {
      break;
    }
    const line = state.lines[state.pos];
    if (line === undefined) {
      break;
    }
    if (!line.blank && line.indent <= parentIndent) {
      break;
    }
    state.pos += 1;
    if (line.blank) {
      collected.push("");
      continue;
    }
    if (blockIndent === null) {
      blockIndent = line.indent;
    }
    const cut = blockIndent;
    collected.push(line.raw.slice(cut));
  }
  return buildBlockScalar(collected, indicator);
}

function buildBlockScalar(collected: readonly string[], indicator: string): string {
  let text: string;
  if (indicator.startsWith(">")) {
    let out = "";
    for (const line of collected) {
      if (line === "") {
        out += "\n";
        continue;
      }
      out += out === "" || out.endsWith("\n") ? line : ` ${line}`;
    }
    text = out;
  } else {
    text = collected.join("\n");
  }
  if (indicator.endsWith("+")) {
    return text.length > 0 ? `${text}\n` : text;
  }
  const trimmed = text.replace(/\n+$/, "");
  if (indicator.endsWith("-")) {
    return trimmed;
  }
  return trimmed.length > 0 ? `${trimmed}\n` : trimmed;
}

// ── 词法辅助 ───────────────────────────────────────────────────

function isSequenceItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

interface KeyValue {
  readonly key: string;
  readonly rest: string;
}

/** 切分 `key: value`；仅当 `:` 后是空白/行尾时视为映射分隔符（URL 等普通标量不受影响）。 */
function splitKeyValue(content: string): KeyValue | null {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "[" || c === "{") {
      depth += 1;
      continue;
    }
    if (c === "]" || c === "}") {
      depth -= 1;
      continue;
    }
    if (c === ":" && depth === 0) {
      const after = content.slice(i + 1);
      if (after.trim() === "" || after.startsWith(" ")) {
        return { key: content.slice(0, i).trim(), rest: after };
      }
    }
  }
  return null;
}

function unquoteKey(key: string): string {
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    return parseDoubleQuoted(key.slice(1, -1));
  }
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) {
    return key.slice(1, -1).replace(/''/g, "'");
  }
  return key;
}

function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === "") {
    return null;
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'")) {
      throw new FrontmatterParseError("单引号字符串未闭合");
    }
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith('"')) {
    if (!t.endsWith('"')) {
      throw new FrontmatterParseError("双引号字符串未闭合");
    }
    return parseDoubleQuoted(t.slice(1, -1));
  }
  if (t === "null" || t === "Null" || t === "~") {
    return null;
  }
  if (t === "true" || t === "True" || t === "TRUE") {
    return true;
  }
  if (t === "false" || t === "False" || t === "FALSE") {
    return false;
  }
  if (/^-?\d+$/.test(t)) {
    return parseInt(t, 10);
  }
  if (/^-?\d+\.\d+$/.test(t)) {
    return parseFloat(t);
  }
  return t;
}

function parseDoubleQuoted(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === "\\") {
      const next = inner[i + 1];
      if (next === undefined) {
        throw new FrontmatterParseError("双引号字符串转义不完整");
      }
      i += 1;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        case "'":
          out += "'";
          break;
        case "/":
          out += "/";
          break;
        case "u": {
          const hex = inner.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new FrontmatterParseError("\\u 转义必须是 4 位十六进制");
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          out += next;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/** 解析流集合 `[...]` / `{...}`（支持嵌套与引号）。 */
function parseFlowValue(text: string): unknown {
  const state = { text, pos: 0 };
  const value = parseFlowNode(state);
  const rest = state.text.slice(state.pos).trim();
  if (rest !== "") {
    throw new FrontmatterParseError(`流集合存在多余内容："${rest}"`);
  }
  return value;
}

interface FlowState {
  readonly text: string;
  pos: number;
}

function parseFlowNode(state: FlowState): unknown {
  const text = state.text;
  const c = text[state.pos];
  if (c === "[") {
    state.pos += 1;
    const arr: unknown[] = [];
    skipFlowSpace(state);
    if (text[state.pos] === "]") {
      state.pos += 1;
      return arr;
    }
    for (;;) {
      arr.push(parseFlowNode(state));
      skipFlowSpace(state);
      const sep = text[state.pos];
      if (sep === ",") {
        state.pos += 1;
        skipFlowSpace(state);
        if (text[state.pos] === "]") {
          state.pos += 1;
          return arr;
        }
        continue;
      }
      if (sep === "]") {
        state.pos += 1;
        return arr;
      }
      throw new FrontmatterParseError("流数组缺少 , 或 ]");
    }
  }
  if (c === "{") {
    state.pos += 1;
    const map: Record<string, unknown> = {};
    skipFlowSpace(state);
    if (text[state.pos] === "}") {
      state.pos += 1;
      return map;
    }
    for (;;) {
      skipFlowSpace(state);
      let keyStart = state.pos;
      let inS = false;
      let inD = false;
      while (state.pos < text.length) {
        const ch = text[state.pos];
        if (inS) {
          if (ch === "'") inS = false;
        } else if (inD) {
          if (ch === "\\") {
            state.pos += 1;
          } else if (ch === '"') {
            inD = false;
          }
        } else if (ch === "'") {
          inS = true;
        } else if (ch === '"') {
          inD = true;
        } else if (ch === ":" && state.pos + 1 < text.length && text[state.pos + 1] === " ") {
          break;
        }
        state.pos += 1;
      }
      const keyText = text.slice(keyStart, state.pos).trim();
      if (keyText === "") {
        throw new FrontmatterParseError("流映射缺少键");
      }
      const key = unquoteKey(keyText);
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        throw new FrontmatterParseError(`流映射出现重复键："${key}"`);
      }
      if (text[state.pos] !== ":") {
        throw new FrontmatterParseError("流映射缺少冒号");
      }
      state.pos += 1;
      skipFlowSpace(state);
      map[key] = parseFlowNode(state);
      skipFlowSpace(state);
      const sep = text[state.pos];
      if (sep === ",") {
        state.pos += 1;
        skipFlowSpace(state);
        if (text[state.pos] === "}") {
          state.pos += 1;
          return map;
        }
        continue;
      }
      if (sep === "}") {
        state.pos += 1;
        return map;
      }
      throw new FrontmatterParseError("流映射缺少 , 或 }");
    }
  }
  // 标量或引号字符串
  const start = state.pos;
  let inS = false;
  let inD = false;
  while (state.pos < text.length) {
    const ch = text[state.pos];
    if (inS) {
      if (ch === "'") inS = false;
    } else if (inD) {
      if (ch === "\\") {
        state.pos += 1;
      } else if (ch === '"') {
        inD = false;
      }
    } else if (ch === "'") {
      inS = true;
    } else if (ch === '"') {
      inD = true;
    } else if (ch === "," || ch === "]" || ch === "}") {
      break;
    }
    state.pos += 1;
  }
  const raw = text.slice(start, state.pos).trim();
  if (raw === "") {
    throw new FrontmatterParseError("流集合中出现空值");
  }
  return parseScalar(raw);
}

function skipFlowSpace(state: FlowState): void {
  while (state.pos < state.text.length && /\s/.test(state.text[state.pos] ?? "")) {
    state.pos += 1;
  }
}

function skipBlank(state: YamlState): void {
  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (line === undefined || !line.blank) {
      return;
    }
    state.pos += 1;
  }
}

/** 去除行内注释：`#` 前有空白或在行首（引号内不受影响）。 */
function stripComment(content: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(content[i - 1] ?? ""))) {
      return content.slice(0, i);
    }
  }
  return content;
}
