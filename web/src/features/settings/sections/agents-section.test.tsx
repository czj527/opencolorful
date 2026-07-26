import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsSection } from "./AgentsSection.js";
import type { AgentView } from "../../../lib/types.js";

const fakeAgents: AgentView[] = [
  {
    identity: {
      id: "agent-1",
      type: "assistant",
      name: "HelperBot",
      createdAt: "2025-01-01T00:00:00Z",
    },
    profile: {
      persona: "A helpful assistant",
      personality: ["helpful", "polite"],
      replyStyle: "conversational",
      updatedAt: "2025-01-02T00:00:00Z",
    },
    sessionCount: 5,
  },
  {
    identity: {
      id: "agent-2",
      type: "coding",
      name: "CodeBot",
      createdAt: "2025-03-01T00:00:00Z",
    },
    profile: null,
    sessionCount: 12,
  },
  {
    identity: {
      id: "agent-3",
      type: "work",
      name: "WorkMate",
      createdAt: "2025-06-01T00:00:00Z",
    },
    profile: {
      persona: "A professional work assistant",
      personality: ["professional", "efficient"],
      replyStyle: "formal",
      updatedAt: "2025-06-02T00:00:00Z",
    },
    sessionCount: 3,
  },
];

describe("AgentsSection", () => {
  it("renders agent list with names and session counts", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onSaveProfile={async () => {}}
        onArchive={async () => {}}
        onCreate={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("HelperBot");
    expect(html).toContain("CodeBot");
    expect(html).toContain("WorkMate");
    expect(html).toContain("5 会话");
    expect(html).toContain("12 会话");
    expect(html).toContain("3 会话");
  });

  it("renders type badges with semantic variants per agent type", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onSaveProfile={async () => {}}
        onArchive={async () => {}}
        onCreate={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    // Phase 7 重构后 badge 使用 ui/Badge 语义变体（info/success/warning），
    // 不再硬编码 rgba 颜色；验证每种类型的标签文本被渲染。
    expect(html).toContain("assistant");
    expect(html).toContain("coding");
    expect(html).toContain("work");
  });

  it("renders empty state when no agents", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={[]}
        onSaveProfile={async () => {}}
        onArchive={async () => {}}
        onCreate={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("暂无 Agent");
  });

  it("shows create form button", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onSaveProfile={async () => {}}
        onArchive={async () => {}}
        onCreate={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("+ 新建 Agent");
  });

  it("renders archive button for each agent", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onSaveProfile={async () => {}}
        onArchive={async () => {}}
        onCreate={async () => {}}
        saving={false}
        lastSaveError={null}
      />,
    );
    expect(html).toContain("归档");
    // Three agents, each should have an archive button
    const matches = html.match(/归档/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it("renders lastSaveError when provided", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onSaveProfile={async () => {}}
        onArchive={async () => {}}
        onCreate={async () => {}}
        saving={false}
        lastSaveError="创建失败：名称已存在"
      />,
    );
    expect(html).toContain("创建失败：名称已存在");
  });
});
