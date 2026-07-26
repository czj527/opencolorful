/**
 * MessageComposer / ContextUsageRing 在 CSS Module 重构后的回归测试。
 *
 * 断言重点（与既有 chat.test / commands.test / usage.test 的意图对齐）：
 *  - 结构类名（chat-composer-card / chat-composer-input-area / chat-composer-controls /
 *    composer-separator / command-panel*）以普通字符串渲染，供 SSR 测试匹配；
 *  - 命令面板交互（输入 / → 面板出现 → 点击 → 触发回调并清空输入框）；
 *  - 控件行使用 UI 原语（Select / IconButton），aria-label 保持稳定；
 *  - ContextUsageRing 颜色阈值逻辑（data-level）与 data-testid 保持稳定。
 *
 * 该文件聚焦 T6 迁移后不再回归；既有覆盖请见 commands.test / chat.test / usage.test。
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, screen } from "@testing-library/react";

import { ContextUsageRing } from "./ContextUsageRing.js";
import { MessageComposer } from "./MessageComposer.js";
import type { ContextUsage, ModelSummary, TokenUsage } from "../../lib/types.js";
import { renderWithTheme } from "../../test/render.js";

const zeroTotals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

const fakeModels: ModelSummary[] = [
  {
    providerId: "p1",
    modelId: "m1",
    name: "Model One",
    protocol: "openai-completions",
    baseUrl: "http://localhost/v1",
    capabilities: { reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
    credentialConfigured: true,
  },
];

const baseComposerProps = {
  disabled: false,
  running: false,
  onSend: () => {},
  onAbort: () => {},
  models: fakeModels,
  selectedModel: null,
  onSelectModel: () => {},
  toolMode: "off",
  onToolModeChange: () => {},
  thinkingLevel: "off",
  onThinkingLevelChange: () => {},
} as const;

describe("MessageComposer 结构类名（SSR 兼容）", () => {
  it("渲染一体化卡片容器与控件行结构类名", () => {
    const html = renderToStaticMarkup(
      <MessageComposer {...baseComposerProps} />,
    );
    expect(html).toContain("chat-composer-card");
    expect(html).toContain("chat-composer-input-area");
    expect(html).toContain("chat-composer-controls");
    expect(html).toContain("composer-separator");
  });

  it("控件行 aria-label 保持稳定（工具模式/思考级别/选择模型/发送消息）", () => {
    const html = renderToStaticMarkup(
      <MessageComposer {...baseComposerProps} />,
    );
    expect(html).toContain('aria-label="工具模式"');
    expect(html).toContain('aria-label="思考级别"');
    expect(html).toContain('aria-label="选择模型"');
    expect(html).toContain('aria-label="发送消息"');
  });

  it("运行态渲染中断按钮（aria-label=中断生成），无发送按钮", () => {
    const html = renderToStaticMarkup(
      <MessageComposer {...baseComposerProps} running={true} />,
    );
    expect(html).toContain('aria-label="中断生成"');
    expect(html).not.toContain('aria-label="发送消息"');
  });
});

describe("MessageComposer 命令面板交互（render + fireEvent）", () => {
  it("初始空输入不渲染命令面板", () => {
    renderWithTheme(<MessageComposer {...baseComposerProps} onExecuteCommand={() => {}} />);
    expect(screen.queryByTestId("command-panel")).toBeNull();
  });

  it("输入 / 后出现命令面板并列出候选项", () => {
    renderWithTheme(<MessageComposer {...baseComposerProps} onExecuteCommand={() => {}} />);
    fireEvent.change(screen.getByLabelText("消息输入"), { target: { value: "/" } });
    expect(screen.getByTestId("command-panel")).toBeDefined();
    expect(screen.getByTestId("command-item-help")).toBeDefined();
    expect(screen.getByTestId("command-item-compact")).toBeDefined();
  });

  it("点击命令项触发 onExecuteCommand 并清空输入框", () => {
    const onExecuteCommand = vi.fn();
    renderWithTheme(<MessageComposer {...baseComposerProps} onExecuteCommand={onExecuteCommand} />);
    const input = screen.getByLabelText("消息输入") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/he" } });
    fireEvent.click(screen.getByTestId("command-item-help"));
    expect(onExecuteCommand).toHaveBeenCalledWith("help");
    expect(input.value).toBe("");
  });

  it("未传入 onExecuteCommand 时不渲染命令面板（即使输入 /）", () => {
    renderWithTheme(<MessageComposer {...baseComposerProps} />);
    fireEvent.change(screen.getByLabelText("消息输入"), { target: { value: "/" } });
    expect(screen.queryByTestId("command-panel")).toBeNull();
  });
});

describe("MessageComposer 用量圆环集成", () => {
  const context: ContextUsage = { tokens: 1000, contextWindow: 10000, percent: 30 };
  const totals: TokenUsage = { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180 };

  it("传入 usage props 时渲染圆环（data-testid 稳定）", () => {
    const html = renderToStaticMarkup(
      <MessageComposer
        {...baseComposerProps}
        contextUsage={context}
        usageTotals={totals}
        cacheHitRate={0.2}
      />,
    );
    expect(html).toContain('data-testid="context-usage-ring"');
    // 圆环出现在发送按钮之前
    expect(html.indexOf('data-testid="context-usage-ring"')).toBeLessThan(
      html.indexOf('aria-label="发送消息"'),
    );
  });

  it("未传入 usage props 时不渲染圆环", () => {
    const html = renderToStaticMarkup(<MessageComposer {...baseComposerProps} />);
    expect(html).not.toContain('data-testid="context-usage-ring"');
  });
});

describe("ContextUsageRing 颜色阈值（data-level 稳定）", () => {
  it("低于 60% 渲染 accent 级别", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing
        context={{ tokens: 1000, contextWindow: 10000, percent: 30 }}
        totals={zeroTotals}
        cacheHitRate={null}
      />,
    );
    expect(html).toContain("context-ring-accent");
    expect(html).toContain('data-testid="context-usage-ring"');
  });

  it("60–85% 渲染 warning 级别", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing
        context={{ tokens: 7000, contextWindow: 10000, percent: 70 }}
        totals={zeroTotals}
        cacheHitRate={null}
      />,
    );
    expect(html).toContain("context-ring-warning");
  });

  it("高于 85% 渲染 danger 级别", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing
        context={{ tokens: 9000, contextWindow: 10000, percent: 90 }}
        totals={zeroTotals}
        cacheHitRate={null}
      />,
    );
    expect(html).toContain("context-ring-danger");
  });

  it("context 为 null 渲染 empty 级别与暂无数据提示", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing context={null} totals={zeroTotals} cacheHitRate={null} />,
    );
    expect(html).toContain("context-ring-empty");
    expect(html).toContain("暂无数据");
  });

  it("percent 为 null 渲染 empty 级别", () => {
    const html = renderToStaticMarkup(
      <ContextUsageRing
        context={{ tokens: null, contextWindow: 32768, percent: null }}
        totals={zeroTotals}
        cacheHitRate={null}
      />,
    );
    expect(html).toContain("context-ring-empty");
  });
});
