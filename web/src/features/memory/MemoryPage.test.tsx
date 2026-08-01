import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryPage } from "./MemoryPage.js";

const payloads: Record<string, unknown> = {
  "/api/agents/agent-1/memory/compiled": {
    agentId: "agent-1",
    content: "## 重要事实\n重要事实\n",
    sections: { today: "今天完成了记忆页面", week: "本周摘要", longterm: "项目背景", facts: "重要事实" },
  },
  "/api/agents/agent-1/memory/facts": { facts: [{ id: 1, fact: "偏好简洁回复", tags: ["preference"] }] },
  "/api/agents/agent-1/memory/events": { events: [{ id: "event-1", startedAt: "2026-08-01T10:00:00Z", summary: "完成 UI" }] },
  "/api/agents/agent-1/memory/pinned": { pinned: [{ id: "pin-1", content: "Pinned note" }] },
  "/api/agents/agent-1/memory/health": { health: { recallEpisode: { status: "completed", resultCount: 2, layer: "facts" }, pendingBatches: 1 } },
};

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/agents") return new Response(JSON.stringify({ agents: [{ identity: { id: "agent-1", name: "Hanako" } }] }), { status: 200 });
      return new Response(JSON.stringify(payloads[path] ?? {}), { status: 200 });
    }));
  });

  it("shows compiled sections, facts, timeline and health", async () => {
    render(<MemoryPage />);
    expect(await screen.findByText("今天完成了记忆页面")).toBeTruthy();
    expect(screen.getByText("偏好简洁回复")).toBeTruthy();
    expect(screen.getByText("完成 UI")).toBeTruthy();
    expect(screen.getByText("Pinned note")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("Pending batch")).toBeTruthy();
  });

  it("filters read-only content with the search box", async () => {
    render(<MemoryPage />);
    await screen.findByText("完成 UI");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "偏好" } });
    await waitFor(() => expect(screen.getByText("偏好简洁回复")).toBeTruthy());
    expect(screen.queryByText("完成 UI")).toBeNull();
  });
});
