import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentCreatePage } from "./AgentCreatePage.js";
import { ApiClient } from "../../lib/api-client.js";

const fakeApi = new ApiClient("http://test.local");

describe("AgentCreatePage", () => {
  it("renders page title", () => {
    const html = renderToStaticMarkup(<AgentCreatePage api={fakeApi} />);
    expect(html).toContain("新建 Agent");
  });

  it("renders form with create mode sections", () => {
    const html = renderToStaticMarkup(<AgentCreatePage api={fakeApi} />);
    expect(html).toContain("名称（必填）");
    expect(html).toContain("选择底色起点");
    expect(html).toContain("创建 Agent");
  });

  it("renders ConfirmDiscard component (closed by default)", () => {
    // ConfirmDiscard with open=false renders nothing
    const html = renderToStaticMarkup(<AgentCreatePage api={fakeApi} />);
    // No discard text visible (closed state)
    expect(html).not.toContain("放弃创建？");
  });
});
