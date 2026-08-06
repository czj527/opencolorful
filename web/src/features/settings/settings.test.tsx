import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SETTINGS_SECTIONS,
  settingsNavReducer,
  initialSettingsNav,
  createInitialSettingsNav,
  settingsSectionUrl,
  type SettingsSectionId,
} from "./settings-state.js";
import { SettingsNav } from "./SettingsNav.js";
import { SettingsPage } from "./SettingsPage.js";

describe("SETTINGS_SECTIONS", () => {
  it("exposes fixed sections models/defaults/layout/agents/plugins/skills/logs/usage/runtime/future", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids).toEqual([
      "models",
      "defaults",
      "layout",
      "agents",
      "plugins",
      "skills",
      "logs",
      "usage",
      "runtime",
      "future",
    ]);
  });

  it("marks agents section as available", () => {
    const agents = SETTINGS_SECTIONS.find((s) => s.id === "agents");
    expect(agents?.available).toBe(true);
    expect(agents?.group).toBe("general");
  });

  it("marks usage section as available in general group", () => {
    const usage = SETTINGS_SECTIONS.find((s) => s.id === "usage");
    expect(usage?.available).toBe(true);
    expect(usage?.group).toBe("general");
    expect(usage?.label).toBe("用量统计");
  });

  it("marks future sections as unavailable", () => {
    const future = SETTINGS_SECTIONS.find((s) => s.id === "future");
    expect(future?.available).toBe(false);
  });
});

describe("settingsNavReducer", () => {
  it("switches the active section", () => {
    const next = settingsNavReducer(initialSettingsNav, { type: "SELECT_SECTION", sectionId: "layout" });
    expect(next.activeSection).toBe("layout");
  });

  it("filters sections by label and keeps the active section selected", () => {
    const next = settingsNavReducer(
      { ...initialSettingsNav, search: "日志", activeSection: "models" },
      { type: "SET_SEARCH", search: "日志" },
    );
    const visible = next.visibleSectionIds;
    expect(visible).toContain("logs");
    expect(visible).not.toContain("models");
    // 已激活 section 即使不在搜索结果中也仍保留为 activeSection
    expect(next.activeSection).toBe("models");
  });

  it("resets active to first visible section when search hides the current one and user confirms", () => {
    const afterSearch = settingsNavReducer(
      { ...initialSettingsNav, activeSection: "models" as SettingsSectionId },
      { type: "SET_SEARCH", search: "日志" },
    );
    // models 不在 visibleSectionIds 中，但 activeSection 不必自动跳走——
    // 用户点击搜索结果项时才切换。
    const afterSelect = settingsNavReducer(afterSearch, { type: "SELECT_SECTION", sectionId: "logs" });
    expect(afterSelect.activeSection).toBe("logs");
    expect(afterSelect.search).toBe("日志");
  });

  it("renders unavailable sections without throwing", () => {
    let state = settingsNavReducer(initialSettingsNav, { type: "SELECT_SECTION", sectionId: "future" });
    expect(state.activeSection).toBe("future");
    // 不可用 section 标志由 section metadata 携带，reducer 不阻止选中。
  });
});

describe("settings section URL state", () => {
  it("restores a valid section from the query string", () => {
    expect(createInitialSettingsNav("?section=logs").activeSection).toBe("logs");
    expect(createInitialSettingsNav("?section=unknown").activeSection).toBe("models");
  });

  it("serializes the active section into the settings URL", () => {
    expect(settingsSectionUrl("runtime")).toBe("/settings?section=runtime");
  });
});

describe("SettingsNav component", () => {
  it("renders settings navigation at /settings with all sections", () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        sections={SETTINGS_SECTIONS}
        activeSection={"models" as SettingsSectionId}
        visibleSectionIds={SETTINGS_SECTIONS.map((s) => s.id)}
        search=""
        onSelect={() => {}}
        onSearch={() => {}}
      />,
    );
    expect(html).toContain("models");
    expect(html).toContain("defaults");
    expect(html).toContain("layout");
    expect(html).toContain("logs");
  });

  it("renders unavailable sections disabled", () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        sections={SETTINGS_SECTIONS}
        activeSection={"future" as SettingsSectionId}
        visibleSectionIds={["future"]}
        search=""
        onSelect={() => {}}
        onSearch={() => {}}
      />,
    );
    expect(html).toContain("future");
    // 不可用项不应渲染成可点击按钮的 enabled 状态——通过 aria-disabled 标记。
    expect(html).toContain("aria-disabled");
  });
});

describe("SettingsPage shell", () => {
  it("renders a settings shell with nav + content area", () => {
    const html = renderToStaticMarkup(<SettingsPage api={null as never} onBack={() => {}} />);
    // SettingsPage 至少渲染导航容器与内容容器；section 实际数据由 API 异步加载。
    expect(html).toContain("settings");
  });
});
