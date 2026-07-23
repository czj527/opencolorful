/**
 * Supervisor 日志过滤与查询。
 *
 * 设计要点：
 * - 控制器层只暴露原文（含敏感信息），脱敏由 Supervisor 路由负责——这里只做
 *   level/limit/since/query 过滤与增量 cursor，不感知凭据。
 * - 行解析容忍无前缀/无 level 的行，统一归为 info。
 * - cursor 是 Base64 编码的字节偏移坐标，使 `since` 在多次读取间稳定可重入。
 */
export interface LogQuery {
  readonly limit?: number;
  readonly since?: string | null;
  readonly level?: "all" | "info" | "warn" | "error";
  readonly query?: string;
}

export interface LogTail {
  readonly logs: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

const MAX_LIMIT = 2000;

interface ParsedLine {
  readonly level: "info" | "warn" | "error";
  readonly text: string;
}

/**
 * 解析单行日志。容忍不规范的行：没有 [level] 标记的行归为 info，
 * 未知 level 也归为 info。
 */
function parseLine(raw: string): ParsedLine {
  const match = /\[(info|warn|error|warning|err|i|w|e)\]/i.exec(raw);
  if (match) {
    const tagRaw = match[1];
    if (tagRaw !== undefined) {
      const tag = tagRaw.toLowerCase();
      const level: ParsedLine["level"] =
        tag.startsWith("w") ? "warn" : tag.startsWith("e") ? "error" : "info";
      return { level, text: raw };
    }
  }
  return { level: "info", text: raw };
}

/**
 * 把字节偏移编码成稳定 cursor。base64 避免路由查询串里的特殊字符。
 */
export function encodeCursor(byteOffset: number): string {
  return Buffer.from(`o:${byteOffset}`, "utf8").toString("base64");
}

export function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const match = /^o:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 对完整日志文本应用过滤查询。
 *
 * - `level`（warn/error）严格按行 level 标记过滤，不在 message 文本里匹配子串；
 * - `limit` 取过滤后结果的尾部 N 行；
 * - `since` 是上次返回的 cursor（字节偏移），若提供则跳过该偏移之前的行；
 * - `query` 对原文做大小写不敏感子串匹配；
 * - 返回的 `truncated` 标识是否因 limit 截断；`nextCursor` 指向已读行末偏移。
 *
 * 当 input 文本末尾不是换行时，仍按已有行处理。
 */
export function filterLogLines(input: string, query: LogQuery, sinceCursor: string | null): LogTail {
  const sinceOffset = sinceCursor !== null ? (decodeCursor(sinceCursor) ?? -1) : -1;
  const level = query.level ?? "all";
  const needle = query.query !== undefined && query.query.length > 0
    ? query.query.toLowerCase()
    : null;

  const allLines = input.split("\n");
  // split 会在末尾产生空串；若原文以 \n 结尾则忽略它，否则作为一行保留。
  const trailingNewline = input.endsWith("\n");
  const effective = trailingNewline ? allLines.slice(0, allLines.length - 1) : allLines;

  // 计算每行的字节边界。
  let byteOffset = 0;
  type IndexedLine = { readonly text: string; readonly start: number; readonly end: number };
  const indexed: IndexedLine[] = effective.map((line) => {
    const start = byteOffset;
    const end = byteOffset + Buffer.byteLength(line, "utf8") + 1; // +1 for \n
    byteOffset = end;
    return { text: line, start, end };
  });

  // 先按 since 跳过已读行（行末偏移 <= sinceOffset 视为已读）。
  const unread = sinceOffset >= 0
    ? indexed.filter((line) => line.start > sinceOffset)
    : indexed;

  // 再按 level / query 过滤。
  const filtered = unread.filter((line) => {
    if (needle !== null && !line.text.toLowerCase().includes(needle)) return false;
    if (level !== "all") {
      const parsed = parseLine(line.text);
      if (parsed.level !== level) return false;
    }
    return true;
  });

  // 应用 limit 取尾部。
  const limit = query.limit !== undefined ? Math.min(Math.max(1, query.limit), MAX_LIMIT) : MAX_LIMIT;
  const truncated = filtered.length > limit;
  const window = truncated ? filtered.slice(filtered.length - limit) : filtered;

  const logs = window.length > 0
    ? window.map((line) => line.text).join("\n") + "\n"
    : "";

  const lastLine = window.length > 0 ? window[window.length - 1] : null;
  const last = lastLine !== undefined ? lastLine : null;
  const nextCursor = last !== null ? encodeCursor(last.end - 1) : sinceCursor;

  return { logs, truncated, nextCursor };
}