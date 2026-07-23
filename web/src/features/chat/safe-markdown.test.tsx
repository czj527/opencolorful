import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { renderSafeMarkdown } from "./safe-markdown.js";

function render(source: string): string {
  return renderToStaticMarkup(<>{renderSafeMarkdown(source)}</>);
}

describe("renderSafeMarkdown", () => {
  it("renders plain paragraphs", () => {
    const html = render("Hello world");
    expect(html).toContain("Hello world");
    expect(html).toContain("<p");
  });

  it("renders bold and italic", () => {
    const html = render("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders inline code and code blocks", () => {
    const html = render("use `npm test`\n\n```js\nconst a = 1;\n```");
    expect(html).toContain("<code");
    expect(html).toContain("npm test");
    expect(html).toContain("<pre");
    expect(html).toContain("const a = 1;");
  });

  it("renders headings and lists", () => {
    const html = render("# Title\n\n- item one\n- item two\n\n1. first\n2. second");
    expect(html).toContain("Title");
    expect(html).toContain("<ul");
    expect(html).toContain("item one");
    expect(html).toContain("<ol");
    expect(html).toContain("second");
  });

  it("renders safe links as anchors", () => {
    const html = render("[example](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("blocks javascript: links (rendered as plain text, no anchor)", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a");
    expect(html).toContain("click");
  });

  it("blocks data: links", () => {
    const html = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("<a");
  });

  it("does not render raw HTML (tags escaped as text)", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not render HTML img tags", () => {
    const html = render('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("handles mixed content safely", () => {
    const html = render("**重要**：查看 [文档](https://docs.example.com) 和 `代码`");
    expect(html).toContain("<strong>重要</strong>");
    expect(html).toContain('href="https://docs.example.com"');
    expect(html).toContain("<code");
  });
});
