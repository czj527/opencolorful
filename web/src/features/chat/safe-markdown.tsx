import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

import { isSafeUrl } from "./chat-state.js";

/**
 * 最小安全 Markdown 渲染器。
 *
 * 安全约束：
 * - 输出 React 节点，绝不使用 dangerouslySetInnerHTML；
 * - 不解析 raw HTML（标签按纯文本显示）；
 * - 链接必须经过 isSafeUrl 校验（拒绝 javascript:/data:/vbscript:）。
 *
 * 支持：标题、段落、粗体、斜体、行内代码、代码块、有序/无序列表、链接。
 */

type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = source;
  let plain = "";

  const flush = () => {
    if (plain) {
      tokens.push({ kind: "text", text: plain });
      plain = "";
    }
  };

  while (rest.length > 0) {
    // 链接 [text](url)
    const linkMatch = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (linkMatch) {
      flush();
      tokens.push({ kind: "link", text: linkMatch[1] ?? "", url: linkMatch[2] ?? "" });
      rest = rest.slice(linkMatch[0].length);
      continue;
    }
    // 行内代码 `code`
    const codeMatch = /^`([^`]+)`/.exec(rest);
    if (codeMatch) {
      flush();
      tokens.push({ kind: "code", text: codeMatch[1] ?? "" });
      rest = rest.slice(codeMatch[0].length);
      continue;
    }
    // 粗体 **text**
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(rest);
    if (boldMatch) {
      flush();
      tokens.push({ kind: "bold", text: boldMatch[1] ?? "" });
      rest = rest.slice(boldMatch[0].length);
      continue;
    }
    // 斜体 *text*
    const italicMatch = /^\*([^*]+)\*/.exec(rest);
    if (italicMatch) {
      flush();
      tokens.push({ kind: "italic", text: italicMatch[1] ?? "" });
      rest = rest.slice(italicMatch[0].length);
      continue;
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
  return tokens;
}

function renderInline(source: string, keyPrefix: string): ReactNode[] {
  return parseInline(source).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.kind) {
      case "bold":
        return createElement("strong", { key }, token.text);
      case "italic":
        return createElement("em", { key }, token.text);
      case "code":
        return createElement("code", { key, style: { background: "var(--bg-tertiary)", padding: "1px 4px", borderRadius: 3, fontSize: "0.9em" } }, token.text);
      case "link":
        if (!isSafeUrl(token.url)) {
          // 不安全链接降级为纯文本
          return createElement("span", { key }, token.text);
        }
        return createElement(
          "a",
          { key, href: token.url, target: "_blank", rel: "noopener noreferrer", style: { color: "var(--accent)" } },
          token.text,
        );
      default:
        return createElement(Fragment, { key }, token.text);
    }
  });
}

export function renderSafeMarkdown(source: string): ReactNode {
  const blocks: ReactNode[] = [];
  const lines = source.split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let codeBlock: { lang: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const text = paragraph.join(" ");
      blocks.push(
        createElement("p", { key: `p-${blocks.length}`, style: { margin: "0 0 8px" } }, renderInline(text, `p-${blocks.length}`)),
      );
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list !== null) {
      const { ordered, items } = list;
      blocks.push(
        createElement(
          ordered ? "ol" : "ul",
          { key: `list-${blocks.length}`, style: { margin: "0 0 8px", paddingLeft: 20 } },
          items.map((item, i) => createElement("li", { key: `li-${i}` }, renderInline(item, `li-${blocks.length}-${i}`))),
        ),
      );
      list = null;
    }
  };
  const flushCode = () => {
    if (codeBlock !== null) {
      blocks.push(
        createElement(
          "pre",
          { key: `pre-${blocks.length}`, style: { background: "var(--bg-tertiary)", padding: 8, borderRadius: 6, overflowX: "auto", fontSize: 12, margin: "0 0 8px" } },
          createElement("code", null, codeBlock.lines.join("\n")),
        ),
      );
      codeBlock = null;
    }
  };

  for (const line of lines) {
    // 代码块边界
    if (line.trimStart().startsWith("```")) {
      if (codeBlock !== null) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        codeBlock = { lang: line.trimStart().slice(3).trim(), lines: [] };
      }
      continue;
    }
    if (codeBlock !== null) {
      codeBlock.lines.push(line);
      continue;
    }

    // 空行：段落分隔
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    // 标题
    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(headingMatch[1]!.length + 2, 6) as 3 | 4 | 5 | 6;
      blocks.push(
        createElement(`h${level}`, { key: `h-${blocks.length}`, style: { margin: "8px 0 4px" } }, renderInline(headingMatch[2] ?? "", `h-${blocks.length}`)),
      );
      continue;
    }

    // 无序列表
    const ulMatch = /^[-*]\s+(.*)$/.exec(line.trimStart());
    if (ulMatch) {
      flushParagraph();
      if (list === null || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ulMatch[1] ?? "");
      continue;
    }

    // 有序列表
    const olMatch = /^\d+[.)]\s+(.*)$/.exec(line.trimStart());
    if (olMatch) {
      flushParagraph();
      if (list === null || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(olMatch[1] ?? "");
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  flushCode();

  return createElement(Fragment, null, ...blocks);
}
