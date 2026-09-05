/**
 * 波次 B4 · L5 单测：压缩摘要卡渲染（§3.2.4 冻结显示规则）。
 * CompactionCard：tokens 「约」标注、长摘要默认折叠 + 展开切换、中止/失败分态、
 * 正文不做客户端截断、摘要正文不落 console。
 * 投影矩阵（无渲染）在 tests/unit/compaction-projection.test.ts。
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompactionCard } from "./components/CompactionCard.js";
import type { CompactionItem } from "./mock-data.js";

const SUMMARY = "此前讨论了桌面端亮暗主题的语义令牌方向，暗色主题通过 data-theme 整体覆盖，事件层默认收起为单行摘要。".repeat(4);
const SHORT_SUMMARY = "主题令牌已收敛为语义层。";

afterEach(cleanup);

describe("CompactionCard 渲染", () => {
  it("completed：tokens 行标注「约」；长摘要默认折叠，展开后完整显示（不截断）", async () => {
    const user = userEvent.setup();
    const item: CompactionItem = {
      id: "c1", type: "compaction", status: "completed", reason: "manual",
      tokensBefore: 39200, tokensAfter: 18600, summary: SUMMARY,
    };
    render(<CompactionCard item={item} />);
    const tokens = screen.getByTestId("oc-compaction-tokens");
    expect(tokens.textContent).toBe("39200 → 约18600 tokens");
    // 长摘要：默认无正文，有展开按钮
    expect(screen.queryByTestId("oc-compaction-summary")).toBeNull();
    await user.click(screen.getByTestId("oc-compaction-toggle"));
    const summary = screen.getByTestId("oc-compaction-summary");
    expect(summary.textContent).toBe(SUMMARY);
    // 正文不做客户端截断：完整长度保留
    expect(summary.textContent?.length).toBe(SUMMARY.length);
  });

  it("短摘要直接展示，无折叠按钮", () => {
    render(<CompactionCard item={{ id: "c2", type: "compaction", status: "completed", reason: "manual", summary: SHORT_SUMMARY }} />);
    expect(screen.getByTestId("oc-compaction-summary").textContent).toBe(SHORT_SUMMARY);
    expect(screen.queryByTestId("oc-compaction-toggle")).toBeNull();
  });

  it("aborted 与 failed 分态标题可区分；failed 显示错误行；compacting 无正文区", () => {
    const { unmount } = render(<CompactionCard item={{ id: "c3", type: "compaction", status: "aborted", reason: "manual" }} />);
    expect(screen.getByText("压缩未完成：已中止")).toBeTruthy();
    expect(screen.queryByTestId("oc-compaction-summary")).toBeNull();
    unmount();

    render(<CompactionCard item={{ id: "c4", type: "compaction", status: "failed", reason: "manual", errorMessage: "压缩失败：模型不可用" }} />);
    expect(screen.getByText("压缩未完成")).toBeTruthy();
    expect(screen.getByTestId("oc-compaction-error").textContent).toBe("压缩失败：模型不可用");
    unmount();

    render(<CompactionCard item={{ id: "c5", type: "compaction", status: "compacting", reason: "manual" }} />);
    expect(screen.getByText("正在压缩会话上下文…")).toBeTruthy();
    expect(screen.queryByTestId("oc-compaction-summary")).toBeNull();
    expect(screen.queryByTestId("oc-compaction-tokens")).toBeNull();
  });

  it("摘要正文不写入 console（冻结规则）", () => {
    const spy = vi.spyOn(console, "log");
    render(<CompactionCard item={{ id: "c6", type: "compaction", status: "completed", reason: "manual", summary: SUMMARY }} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
