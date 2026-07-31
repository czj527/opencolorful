// ═══════════════════════════════════════════════════════════════
// CJK n-gram 全文检索支持（FTS5 unicode61 的跨语言分词补充）
//
// 机制借自 openhanako fact-store（借机制不抄代码）：
// unicode61 不把中日韩连续文本切成可检索 token，因此在写入 FTS 前
// 把 CJK 连续段展开为 2/3-gram，与原文一起以空格分隔存入 search_text；
// 查询时用同一套规则展开并组 OR 查询。中文单字查询走安全 LIKE 降级。
// ═══════════════════════════════════════════════════════════════

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

const SINGLE_CJK_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

/** NFKC 归一 + 去首尾空白，检索文本的统一入口 */
export function normalizeSearchText(text: string): string {
  return String(text ?? "").normalize("NFKC").trim();
}

/** 提取文本中所有 CJK 连续段的 2/3-gram（保持出现顺序，未去重） */
export function cjkNgrams(text: string): string[] {
  const tokens: string[] = [];
  for (const match of normalizeSearchText(text).matchAll(CJK_RUN_RE)) {
    const chars = Array.from(match[0]);
    for (const size of [2, 3] as const) {
      if (chars.length < size) continue;
      for (let i = 0; i <= chars.length - size; i += 1) {
        tokens.push(chars.slice(i, i + size).join(""));
      }
    }
  }
  return tokens;
}

function uniqueTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeSearchText(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * 构建写入 FTS search_text 列的检索文本：
 * 原文（含完整 CJK 连续段，供 unicode61 拉丁分词与前缀展示）+ CJK 2/3-gram，
 * 归一去重后以空格连接。
 */
export function buildMemorySearchText(...parts: readonly string[]): string {
  const base = parts.map(normalizeSearchText).filter(Boolean).join(" ");
  if (!base) return "";
  return uniqueTokens([base, ...cjkNgrams(base)]).join(" ");
}

/**
 * 构建 FTS5 MATCH 查询：空白切分的词元 + CJK 2/3-gram，逐一转义加引号后 OR 连接。
 * 空查询返回空串（调用方应跳过 FTS，走全量或日期过滤）。
 */
export function buildMemoryFtsQuery(query: string): string {
  const normalized = normalizeSearchText(query);
  if (!normalized) return "";
  const lexicalTokens = normalized.split(/\s+/);
  return uniqueTokens([...lexicalTokens, ...cjkNgrams(normalized)])
    .map((word) => `"${word.replace(/"/g, '""')}"`)
    .join(" OR ");
}

/** 文本是否包含 CJK 字符 */
export function hasCjk(text: string): boolean {
  CJK_RUN_RE.lastIndex = 0;
  return CJK_RUN_RE.test(normalizeSearchText(text));
}

/**
 * 是否为中文单字查询。单字没有 2-gram，FTS 无法命中，
 * 调用方应降级为安全 LIKE（参数绑定 + 通配符转义）。
 */
export function isSingleCjkQuery(query: string): boolean {
  return SINGLE_CJK_RE.test(normalizeSearchText(query));
}

/**
 * LIKE 模式串安全转义（配合 `ESCAPE '\'` 使用）：
 * 转义 `\`、`%`、`_`，用户输入不会被当作通配符。
 */
export function escapeLikePattern(text: string): string {
  return normalizeSearchText(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
