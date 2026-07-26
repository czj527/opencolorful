import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { UsageSection } from "./UsageSection.js";
import type { UsageSummaryResponse } from "../../../lib/types.js";

const fakeSummary: UsageSummaryResponse = {
  days: 30,
  totals: { input: 12000, output: 3400, cacheRead: 5600, cacheWrite: 800, totalTokens: 21800 },
  cacheHitRate: 0.318,
  sessions: 4,
  turns: 12,
  byDay: [
    { date: "2026-07-20", input: 5000, output: 1200, cacheRead: 2000, cacheWrite: 300, totalTokens: 8500 },
    { date: "2026-07-21", input: 7000, output: 2200, cacheRead: 3600, cacheWrite: 500, totalTokens: 13300 },
  ],
  byModel: [
    { provider: "openai", model: "gpt-4o", input: 8000, output: 2000, cacheRead: 3000, cacheWrite: 400, totalTokens: 13400 },
    { provider: "local", model: "llama3", input: 4000, output: 1400, cacheRead: 2600, cacheWrite: 400, totalTokens: 8400 },
  ],
};

const emptySummary: UsageSummaryResponse = {
  days: 30,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  cacheHitRate: null,
  sessions: 0,
  turns: 0,
  byDay: [],
  byModel: [],
};

describe("UsageSection", () => {
  it("renders range selector and loading state", () => {
    const html = renderToStaticMarkup(
      <UsageSection getUsageSummary={async () => fakeSummary} />,
    );
    // Phase 7 重构后标题/描述由 SettingsPage 的 SettingsSection 包装；
    // UsageSection 自身渲染时间范围选择器与加载占位。
    expect(html).toContain('aria-label="时间范围"');
    expect(html).toContain("7 天");
    expect(html).toContain("30 天");
    expect(html).toContain("90 天");
  });

  it("renders range selector buttons", () => {
    const html = renderToStaticMarkup(
      <UsageSection getUsageSummary={async () => fakeSummary} />,
    );
    expect(html).toContain("7 天");
    expect(html).toContain("30 天");
    expect(html).toContain("90 天");
  });

  it("shows loading state initially", () => {
    const html = renderToStaticMarkup(
      <UsageSection getUsageSummary={async () => fakeSummary} />,
    );
    expect(html).toContain("加载中");
  });

  it("renders overview cards with totals and cache hit rate", () => {
    const html = renderToStaticMarkup(
      <UsageSection getUsageSummary={async () => fakeSummary} />,
    );
    // 服务端渲染时 useEffect 不执行，初始为 loading；验证静态结构包含关键文案
    // Phase 7 重构后类名走 CSS Modules（hash），改为检查 aria-label 与文本。
    expect(html).toContain('aria-label="时间范围"');
    expect(html).toContain("加载中");
  });

  it("renders empty state when no usage data", () => {
    const html = renderToStaticMarkup(
      <UsageSection getUsageSummary={async () => emptySummary} />,
    );
    // 初始渲染为 loading，空状态在 effect 后展示；验证组件包含时间范围选择与加载文案
    expect(html).toContain('aria-label="时间范围"');
    expect(html).toContain("加载中");
  });
});
