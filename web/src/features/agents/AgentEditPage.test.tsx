import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, waitFor } from "@testing-library/react";
import { AgentEditPage } from "./AgentEditPage.js";
import { ApiClient } from "../../lib/api-client.js";
import type { AgentView } from "../../lib/types.js";

const fakeAgent: AgentView = {
  identity: {
    version: 2,
    id: "agent-1",
    name: "测试助手",
    createdAt: "2025-01-01T00:00:00Z",
  },
  baseColor: {
    version: 1,
    persona: "你是一个测试助手",
    personality: ["友善", "耐心"],
    replyStyle: "简洁直接",
    innerSetting: "帮助用户",
    updatedAt: "2025-01-01T00:00:00Z",
  },
  settings: {
    version: 1,
    defaultCwd: null,
    updatedAt: "2025-01-01T00:00:00Z",
  },
  sessionCount: 0,
  decorColor: "blue",
};

function makeApi(): ApiClient {
  const api = new ApiClient("http://test.local");
  vi.spyOn(api, "getAgent").mockResolvedValue(fakeAgent);
  return api;
}

describe("AgentEditPage", () => {
  it("renders loading state initially", () => {
    const api = new ApiClient("http://test.local");
    vi.spyOn(api, "getAgent").mockReturnValue(new Promise(() => {})); // never resolves
    const html = renderToStaticMarkup(<AgentEditPage api={api} />);
    expect(html).toContain("加载中");
  });

  it("renders edit mode content after loading", async () => {
    const api = makeApi();
    const { getByText } = render(<AgentEditPage api={api} />);
    await waitFor(() => {
      expect(getByText("编辑 测试助手")).toBeDefined();
    });
  });

  it("does not render create-only sections after loading", async () => {
    const api = makeApi();
    const { container } = render(<AgentEditPage api={api} />);
    await waitFor(() => {
      expect(container.textContent).not.toContain("选择底色起点");
    });
  });
});
