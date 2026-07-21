import { describe, expect, it } from "vitest";

import { renderEvent } from "../../src/tui/render-event.js";
import type { TuiEvent } from "../../src/tui/event-client.js";

function makeEvent(type: string, payload: Record<string, unknown> = {}): TuiEvent {
  return { type, payload };
}

describe("TUI event rendering", () => {
  it("renders session status events", () => {
    expect(renderEvent(makeEvent("session.status", { status: "running" }))).toContain("运行中");
    expect(renderEvent(makeEvent("session.status", { status: "idle" }))).toContain("就绪");
    expect(renderEvent(makeEvent("session.status", { status: "error" }))).toContain("错误");
  });

  it("renders message delta as plain text", () => {
    const result = renderEvent(makeEvent("message.delta", { delta: "你好" }));
    expect(result).toContain("你好");
  });

  it("renders tool started with tool name", () => {
    const result = renderEvent(makeEvent("tool.started", { toolName: "read" }));
    expect(result).toContain("read");
    expect(result).toContain("工具");
  });

  it("renders tool completed success and error", () => {
    const success = renderEvent(makeEvent("tool.completed", { toolCallId: "t1", isError: false }));
    expect(success).toContain("✓");

    const error = renderEvent(makeEvent("tool.completed", { toolCallId: "t2", isError: true }));
    expect(error).toContain("✗");
  });

  it("renders error events in red", () => {
    const result = renderEvent(makeEvent("error", { message: "测试错误" }));
    expect(result).toContain("测试错误");
    expect(result).toContain("错误");
  });

  it("shows A2UI summary without full rendering", () => {
    const result = renderEvent(makeEvent("ui.message", { format: "a2ui", message: { components: [] } }));
    expect(result).toContain("a2ui");
  });

  it("shows TokUI summary without full rendering", () => {
    const result = renderEvent(makeEvent("ui.message", { format: "tokui", chunk: "[card][/card]" }));
    expect(result).toContain("tokui");
  });

  it("ignores unknown event types without throwing", () => {
    const result = renderEvent(makeEvent("custom.unknown"));
    expect(result).toBeUndefined();
  });

  it("truncates long thinking deltas", () => {
    const longText = "x".repeat(200);
    const result = renderEvent(makeEvent("thinking.delta", { delta: longText }));
    expect(result).toContain("...");
    // Should truncate at approximately 120 chars
    expect(result!.length).toBeLessThan(longText.length + 50);
  });
});
