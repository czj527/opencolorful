/**
 * Summary 格式契约：必须包含 `### 重要事实` 与 `### 时间线` 两个节。
 * 容忍 `##` vs `###`、全角/半角冒号变体。
 */

export type SummarySectionKey = "facts" | "timeline";

const SECTION_LABELS: Record<SummarySectionKey, string[]> = {
  facts: ["重要事实"],
  timeline: ["时间线"],
};

/** 全角/半角冒号 */
const COLON_RE = /[：:]/;

// 预编译匹配模式：##/### + 节标题 + 冒号（可选）
function buildSectionPattern(labels: readonly string[]): RegExp {
  const labelGroup = labels.join("|");
  return new RegExp(
    `^#{2,3}\\s+(?:${labelGroup})\\s*${COLON_RE.source}?\\s*$`,
    "um",
  );
}

const FACT_SECTION_RE = buildSectionPattern(SECTION_LABELS.facts);
const TIMELINE_SECTION_RE = buildSectionPattern(SECTION_LABELS.timeline);

/** 查找某个 section 在文本中的起始行位置，找不到返回 -1 */
function findSectionStart(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

/** 提取某个节之后到下一个 ##/### 行之前的内容 */
function extractSectionBody(text: string, startPos: number): string {
  // 从 match 后的换行符开始
  const afterHeading = text.indexOf("\n", startPos);
  if (afterHeading < 0) return "";
  const bodyStart = afterHeading + 1;

  // 找到下一个 ## 或 ### 行
  const nextHeading = text.slice(bodyStart).search(/^#{2,3}\s/um);
  if (nextHeading < 0) {
    return text.slice(bodyStart).trim();
  }
  return text.slice(bodyStart, bodyStart + nextHeading).trim();
}

/**
 * 验证 summary 格式是否包含必须的节。
 */
export function validateSummaryFormat(
  text: string,
): { ok: true } | { ok: false; missing: SummarySectionKey[] } {
  const missing: SummarySectionKey[] = [];
  if (findSectionStart(text, FACT_SECTION_RE) < 0) missing.push("facts");
  if (findSectionStart(text, TIMELINE_SECTION_RE) < 0) missing.push("timeline");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

/**
 * 检查 summary 是否含有所有必须节。
 */
export function hasRequiredSections(text: string): boolean {
  return validateSummaryFormat(text).ok;
}

/**
 * 提取指定节的内容文本（不含标题行）。
 * 返回空字符串表示节不存在或内容为空。
 */
export function extractSummarySection(
  text: string,
  section: SummarySectionKey,
): string {
  const pattern = section === "facts" ? FACT_SECTION_RE : TIMELINE_SECTION_RE;
  const startPos = findSectionStart(text, pattern);
  if (startPos < 0) return "";
  return extractSectionBody(text, startPos);
}
