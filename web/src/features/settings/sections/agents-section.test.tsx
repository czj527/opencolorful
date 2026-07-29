import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentsSection } from "./AgentsSection.js";
import type { AgentView } from "../../../lib/types.js";

const fakeAgents: AgentView[] = [
  {
    identity: { version: 2, id: "agent-1", name: "HelperBot", createdAt: "2025-01-01T00:00:00Z" },
    baseColor: { version: 1, persona: "A helper", personality: ["helpful"], replyStyle: "casual", innerSetting: "", updatedAt: "2025-01-01T00:00:00Z" },
    settings: { version: 2, defaultCwd: null, updatedAt: "2025-01-01T00:00:00Z" },
    sessionCount: 5,
    decorColor: "blue",
  },
  {
    identity: { version: 2, id: "agent-2", name: "CodeBot", createdAt: "2025-03-01T00:00:00Z" },
    baseColor: { version: 1, persona: "A coder", personality: ["precise"], replyStyle: "concise", innerSetting: "", updatedAt: "2025-03-01T00:00:00Z" },
    settings: { version: 2, defaultCwd: "D:\\projects\\demo", updatedAt: "2025-03-01T00:00:00Z" },
    sessionCount: 12,
    decorColor: "green",
  },
];

describe("AgentsSection", () => {
  it("renders agent names and session counts", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onNavigateNew={() => {}}
        onNavigateEdit={() => {}}
        onArchive={async () => {}}
      />,
    );
    expect(html).toContain("HelperBot");
    expect(html).toContain("CodeBot");
    expect(html).toContain("5 会话");
    expect(html).toContain("12 会话");
  });

  it("shows cwd summary when set", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onNavigateNew={() => {}}
        onNavigateEdit={() => {}}
        onArchive={async () => {}}
      />,
    );
    expect(html).toContain("D:\\projects\\demo");
  });

  it("shows 未设置 when cwd is null", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onNavigateNew={() => {}}
        onNavigateEdit={() => {}}
        onArchive={async () => {}}
      />,
    );
    expect(html).toContain("未设置");
  });

  it("renders new agent button", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onNavigateNew={() => {}}
        onNavigateEdit={() => {}}
        onArchive={async () => {}}
      />,
    );
    expect(html).toContain("+ 新建 Agent");
  });

  it("renders empty state when no agents", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={[]}
        onNavigateNew={() => {}}
        onNavigateEdit={() => {}}
        onArchive={async () => {}}
      />,
    );
    expect(html).toContain("暂无 Agent");
  });

  it("does not render create/edit forms (degraded to list-only)", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onNavigateNew={() => {}}
        onNavigateEdit={() => {}}
        onArchive={async () => {}}
      />,
    );
    // No template picker, no inner editor fields
    expect(html).not.toContain("BaseColorTemplatePicker");
    expect(html).not.toContain("Persona（");
    expect(html).not.toContain("保存底色");
  });

  it("shows archive menu button for each agent", () => {
    const html = renderToStaticMarkup(
      <AgentsSection
        agents={fakeAgents}
        onNavigateNew={() => {}}
        onNavigateEdit={() => {}}
        onArchive={async () => {}}
      />,
    );
    // Menu trigger button (⋮) rendered for each agent
    expect(html).toContain("⋮");
    expect(html).toContain('aria-label="更多操作"');
  });
});
