/**
 * 记忆注入：将 memory.md 四段 + Pinned 组装为 system prompt 注入块。
 *
 * 组装顺序：
 * 1. # 记忆使用规则（一行规则）
 * 2. # Pinned Memories（独立保底预算，超出截断尾部）
 * 3. # Memory（四段，按 今天 > 重要事实 > Pinned > 本周 > 长期 截断）
 *
 * 注入前逐段威胁扫描，命中提示注入模式则替换为 [BLOCKED]。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MEMORY_INJECTION_BUDGET_CHARS,
  MEMORY_INJECTION_PINNED_BUDGET_CHARS,
  MEMORY_MD_EMPTY_PLACEHOLDER,
  MEMORY_MD_SECTION_TITLES,
  MEMORY_USAGE_RULE_HEADING,
  type PinnedMemory,
} from "../../contracts/memory.js";

// ═══════════════════════════════════════════════════════════════
// Threat scanning patterns
// ═══════════════════════════════════════════════════════════════

const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|(the\s+)?instructions?)/i,
  /忽略.{0,15}(指令|指示|说明|规则)/i,
  /(forget|disregard|override)\s+(all\s+)?(previous|prior|your)\s+(instructions?|rules?|prompts?)/i,
  /you\s+are\s+(now|actually|really)\s+(a|an)\s+(different|new)\s+(AI|assistant|model|agent)/i,
  /(print|repeat|output|say|tell\s+me)\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i,
  /(告诉我|打印|输出|重复|说出)(你的|系统)?(提示|指令|规则|prompt)/i,
  /call\s+(the\s+)?(\w+)\s+tool\s+(with|using|and)/i,
  /(please\s+)?use\s+(the\s+)?(\w+)\s+function/i,
  /<(system|instruction|prompt|rule)\s*>[\s\S]*?<\/(system|instruction|prompt|rule)\s*>/i,
] as const;

function isThreatContent(text: string): boolean {
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// Section parsing
// ═══════════════════════════════════════════════════════════════

interface MemoryMdSections {
  facts: string;
  today: string;
  week: string;
  longterm: string;
}

/**
 * 按 MEMORY_MD_SECTION_TITLES 四段标题切分 memory.md 正文（去掉 ## 标题行）。
 * 供注入组装与 /api/agents/:id/memory/compiled 共用，避免契约漂移。
 */
export function parseMemoryMdSections(content: string): MemoryMdSections {
  const sections: MemoryMdSections = {
    facts: "",
    today: "",
    week: "",
    longterm: "",
  };

  const lines = content.split("\n");
  let currentSection: keyof MemoryMdSections | null = null;
  const sectionLines: Record<keyof MemoryMdSections, string[]> = {
    facts: [],
    today: [],
    week: [],
    longterm: [],
  };

  const titleToKey: Record<string, keyof MemoryMdSections> = {};
  for (const [key, title] of Object.entries(MEMORY_MD_SECTION_TITLES)) {
    titleToKey[title] = key as keyof MemoryMdSections;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    // 仅四个已知段头切段；week 内部的 "## {date}" 等未知标题视为内容，
    // 否则四段契约内的子标题会清空当前段导致内容丢失
    const headerMatch = trimmed.match(/^##\s+(.+)$/);
    if (headerMatch) {
      const headerTitle = headerMatch[1]?.trim() ?? "";
      const matchedKey = titleToKey[headerTitle];
      if (matchedKey) {
        currentSection = matchedKey;
        continue;
      }
      // Unknown section header: keep current section, treat as content line
    }

    if (currentSection) {
      sectionLines[currentSection].push(line);
    }
  }

  for (const key of Object.keys(sectionLines) as (keyof MemoryMdSections)[]) {
    sections[key] = sectionLines[key].join("\n").trim();
  }

  return sections;
}

// ═══════════════════════════════════════════════════════════════
// Block building
// ═══════════════════════════════════════════════════════════════

// 四条行为契约参考 openhanako `core/agent.ts:1244-1262`（references/ 调研出处），
// 末条保留本项目的 search_memory 指引。措辞与 background-review 复盘提示词保持一致。
const MEMORY_USAGE_RULE = [
  "记忆和用户档案是你内化的背景知识。你和用户是认识很久的人，这些事你本来就知道。记忆的存在感应该是零，它的作用应该是满的。",
  "",
  "- 只有当用户提到了相关内容，记忆才参与进来。用户没有提起的话题，不要主动从记忆里翻出来讲。记忆参与的方式是无声的：影响你的角度、语气、判断，但不出现在文字里。",
  "- 永远不要让用户感觉到“记忆”这个东西的存在。禁止使用“我记得”“你之前说过”“根据记忆”这类表述，除非用户主动问“你还记得 xxx 吗”。",
  "- 记忆可能过时，当前对话永远优先。信息冲突时以对话为准，不要用旧记忆纠正用户。对长期事实不确定时，调用 search_memory 工具确认。",
].join("\n");

export interface MemoryInjectionInput {
  readonly memoryDir: string;
  readonly pinned: readonly PinnedMemory[];
  readonly budgetChars?: number;
  readonly pinnedBudgetChars?: number;
}

export interface MemoryInjectionOutput {
  readonly block: string;
  readonly revision: string;
}

/**
 * 构建记忆注入块。无 memory.md 且无 pinned 时返回 undefined。
 * 威胁扫描在组装前逐段执行，命中则替换为 [BLOCKED]。
 */
export function buildMemoryInjectionBlock(
  input: MemoryInjectionInput,
): MemoryInjectionOutput | undefined {
  const budgetChars = input.budgetChars ?? MEMORY_INJECTION_BUDGET_CHARS;
  const pinnedBudgetChars =
    input.pinnedBudgetChars ?? MEMORY_INJECTION_PINNED_BUDGET_CHARS;

  // Read memory.md
  let sections: MemoryMdSections = {
    facts: "",
    today: "",
    week: "",
    longterm: "",
  };
  let hasMemoryMd = false;

  const memoryMdPath = path.join(input.memoryDir, "memory.md");
  try {
    const content = fs.readFileSync(memoryMdPath, "utf8");
    hasMemoryMd = true;
    sections = parseMemoryMdSections(content);
  } catch {
    // File not found → treat as empty
  }

  // Check if we have anything to inject
  if (!hasMemoryMd && input.pinned.length === 0) {
    return undefined;
  }

  // ── Build pinned block ──────────────────────────────────────
  // 预算口径（T12 修订）：使用规则段是固定行为契约，不占预算、不随预算截断；
  // budgetChars 只约束 Pinned 段与 # Memory 四段内容。Pinned 段先占位，
  // 剩余预算（含 # Memory 头部）再分配给四段。
  const rulePart = `${MEMORY_USAGE_RULE_HEADING}\n${MEMORY_USAGE_RULE}`;

  let pinnedBlock = "";
  if (input.pinned.length > 0) {
    const pinnedLines: string[] = [];
    let pinnedUsed = 0;
    const pinnedHeader = "# Pinned Memories\n";

    for (const pin of input.pinned) {
      if (isThreatContent(pin.content)) {
        pinnedLines.push("[BLOCKED]");
        pinnedUsed += "[BLOCKED]\n".length;
      } else {
        const line = `- ${pin.content}`;
        const lineLen = line.length + 1; // +1 for \n
        if (pinnedUsed + pinnedHeader.length + lineLen > pinnedBudgetChars) {
          pinnedLines.push("…（已截断）");
          break;
        }
        pinnedLines.push(line);
        pinnedUsed += lineLen;
      }
    }

    if (pinnedLines.length > 0) {
      pinnedBlock = pinnedHeader + pinnedLines.join("\n");
    }
  }

  // ── Build memory block ──────────────────────────────────────
  // 优先级：今天 > 重要事实 > Pinned > 本周 > 长期
  // pinned 不重复计入 memory block（已在 pinned 段独立展示）
  // 剩余预算 = 总预算 - Pinned 段 - 段落分隔符 - "# Memory\n" 头部（规则段不占预算，T12）

  const memoryHeader = "# Memory\n";
  const joinersLength = 4; // rule/pinned/memory 之间的两个 "\n\n"
  const remainingBudget =
    budgetChars -
    pinnedBlock.length -
    (pinnedBlock.length > 0 ? joinersLength : 2) -
    memoryHeader.length;
  const memLines: string[] = [];
  let memUsed = 0;

  const sectionEntries: { key: keyof MemoryMdSections; title: string; priority: number }[] = [
    { key: "today" as const, title: MEMORY_MD_SECTION_TITLES.today, priority: 1 },
    { key: "facts" as const, title: MEMORY_MD_SECTION_TITLES.facts, priority: 2 },
    { key: "week" as const, title: MEMORY_MD_SECTION_TITLES.week, priority: 3 },
    { key: "longterm" as const, title: MEMORY_MD_SECTION_TITLES.longterm, priority: 4 },
  ].sort((a, b) => a.priority - b.priority);

  for (const { key, title } of sectionEntries) {
    let content = sections[key];
    if (!content) {
      content = MEMORY_MD_EMPTY_PLACEHOLDER;
    }
    if (isThreatContent(content)) {
      content = "[BLOCKED]";
    }

    const header = `## ${title}`;
    const sectionText = `${header}\n${content}`;
    // +1 段落内换行；后续段落另计段间 "\n\n" 分隔符
    const joinerLen = memLines.length > 0 ? 2 : 0;
    const sectionLen = sectionText.length + 1 + joinerLen;

    if (memUsed + sectionLen > remainingBudget) {
      // Truncate: include header + partial content
      const available = remainingBudget - memUsed - joinerLen;
      if (available > header.length + 10) {
        const truncated = content.slice(0, available - header.length - 10);
        memLines.push(`${header}\n${truncated}…（已截断）`);
      } else if (available > header.length + 3) {
        memLines.push(`${header}\n…（已截断）`);
      }
      // else: no space even for header, skip this section entirely
      break;
    }

    memLines.push(sectionText);
    memUsed += sectionLen;
  }

  const memoryBlock = memLines.length > 0 ? `# Memory\n${memLines.join("\n\n")}` : "";

  // ── Assemble ────────────────────────────────────────────────
  const parts: string[] = [];
  parts.push(rulePart);
  if (pinnedBlock) {
    parts.push(pinnedBlock);
  }
  if (memoryBlock) {
    parts.push(memoryBlock);
  }

  const block = parts.join("\n\n");
  const revision = crypto.createHash("sha256").update(block).digest("hex").slice(0, 12);

  return { block, revision };
}
