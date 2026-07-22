import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { A2uiProjection, TokuiProjection, UnsafePayloadNotice, type A2uiEnvelope } from "./UiProjection.js";

describe("A2uiProjection", () => {
  it("renders whitelisted Text and Card components", () => {
    const messages: A2uiEnvelope[] = [
      { version: "v0.9.1", createSurface: { surfaceId: "s1", catalogId: "local" } },
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "s1",
          components: [
            { id: "c1", component: "Text", text: "Hello A2UI" },
            { id: "c2", component: "Card", title: "卡片标题", body: "卡片内容" },
          ],
        },
      },
    ];
    const html = renderToStaticMarkup(<A2uiProjection messages={messages} />);
    expect(html).toContain("Hello A2UI");
    expect(html).toContain("卡片标题");
    expect(html).toContain("卡片内容");
  });

  it("rejects non-whitelisted components with a safe notice", () => {
    const messages: A2uiEnvelope[] = [
      { version: "v0.9.1", createSurface: { surfaceId: "s1", catalogId: "local" } },
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "c1", component: "Button", text: "危险按钮" }],
        },
      },
    ];
    const html = renderToStaticMarkup(<A2uiProjection messages={messages} />);
    expect(html).toContain("非白名单组件");
    expect(html).not.toContain("危险按钮");
  });

  it("rejects components targeting an unknown surface", () => {
    const messages: A2uiEnvelope[] = [
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "ghost",
          components: [{ id: "c1", component: "Text", text: "orphan" }],
        },
      },
    ];
    const html = renderToStaticMarkup(<A2uiProjection messages={messages} />);
    expect(html).toContain("未知 Surface");
    expect(html).not.toContain("orphan");
  });

  it("removes surfaces on deleteSurface", () => {
    const messages: A2uiEnvelope[] = [
      { version: "v0.9.1", createSurface: { surfaceId: "s1", catalogId: "local" } },
      {
        version: "v0.9.1",
        updateComponents: { surfaceId: "s1", components: [{ id: "c1", component: "Text", text: "temp" }] },
      },
      { version: "v0.9.1", deleteSurface: { surfaceId: "s1" } },
    ];
    const html = renderToStaticMarkup(<A2uiProjection messages={messages} />);
    expect(html).not.toContain("temp");
  });

  it("rejects wrong protocol versions", () => {
    const messages = [
      { version: "v0.8.0", createSurface: { surfaceId: "s1", catalogId: "local" } } as unknown as A2uiEnvelope,
    ];
    const html = renderToStaticMarkup(<A2uiProjection messages={messages} />);
    expect(html).toContain("不支持的 A2UI 版本");
  });

  it("never renders script content from component properties", () => {
    const messages: A2uiEnvelope[] = [
      { version: "v0.9.1", createSurface: { surfaceId: "s1", catalogId: "local" } },
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "c1", component: "Text", text: "<script>alert(1)</script>" }],
        },
      },
    ];
    const html = renderToStaticMarkup(<A2uiProjection messages={messages} />);
    expect(html).not.toContain("<script>");
  });
});

describe("TokuiProjection", () => {
  it("renders plain chunks as text", () => {
    const html = renderToStaticMarkup(<TokuiProjection chunk="Hello TokUI" />);
    expect(html).toContain("Hello TokUI");
  });

  it("blocks chunks containing executable content", () => {
    const html = renderToStaticMarkup(<TokuiProjection chunk='<script>alert(1)</script>' />);
    expect(html).toContain("可执行内容");
    expect(html).not.toContain("<script>");
  });

  it("blocks chunks with inline event handlers", () => {
    const html = renderToStaticMarkup(<TokuiProjection chunk='<div onclick="steal()">x</div>' />);
    expect(html).toContain("可执行内容");
  });
});

describe("UnsafePayloadNotice", () => {
  it("shows the reason with alert role", () => {
    const html = renderToStaticMarkup(<UnsafePayloadNotice reason="测试原因" />);
    expect(html).toContain("测试原因");
    expect(html).toContain('role="alert"');
  });
});
