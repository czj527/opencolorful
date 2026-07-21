import { describe, expect, it } from "vitest";

import { A2uiProjector } from "../../src/ui-projection/a2ui/project.js";
import { A2uiCatalog } from "../../src/ui-projection/a2ui/catalog.js";
import { A2uiActionValidator } from "../../src/ui-projection/a2ui/action.js";

function toolStarted(): Record<string, unknown> {
  return {
    protocolVersion: 1, eventId: "evt-1", sessionId: "session-a2ui",
    streamId: "stream-1", sequence: 1, timestamp: "2026-07-21T12:00:00.000Z",
    type: "tool.started",
    payload: { toolCallId: "t1", toolName: "search" },
  };
}

describe("A2UI projection", () => {
  it("projects tool.started into A2UI ToolCall component", () => {
    const projector = new A2uiProjector();
    const result = projector.project(toolStarted() as never);

    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.format).toBe("a2ui");
    const msg = (result as { message: Record<string, unknown> }).message;
    const uc = msg.updateComponents as { type: string }[] | undefined;
    expect(uc?.[0]?.type).toBe("ToolCall");
  });

  it("projects tool.completed with error status", () => {
    const projector = new A2uiProjector();
    const result = projector.project({
      protocolVersion: 1, eventId: "evt-2", sessionId: "session-a2ui",
      streamId: "stream-1", sequence: 2, timestamp: "2026-07-21T12:00:01.000Z",
      type: "tool.completed",
      payload: { toolCallId: "t1", isError: true },
    } as never);

    expect(result).not.toBeNull();
    if (result === null) return;
    const msg = (result as { message: Record<string, unknown> }).message;
    const uc = msg.updateComponents as { properties?: Record<string, unknown> }[];
    expect(uc?.[0]?.properties).toMatchObject({ status: "error" });
  });

  it("rejects unknown component types via catalog", () => {
    const catalog = new A2uiCatalog();
    expect(catalog.isAllowed("ToolCall")).toBe(true);
    expect(catalog.isAllowed("UnknownWidget")).toBe(false);
    expect(catalog.getCatalogId()).toBe("person-agent/v1");
  });

  it("projects message.delta into A2UI Text component", () => {
    const projector = new A2uiProjector();
    const result = projector.project({
      protocolVersion: 1, eventId: "evt-3", sessionId: "session-a2ui",
      streamId: "stream-1", sequence: 3, timestamp: "2026-07-21T12:00:02.000Z",
      type: "message.delta",
      payload: { role: "assistant", delta: "hello" },
    } as never);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.format).toBe("a2ui");
  });
});

describe("A2UI action validation", () => {
  it("accepts valid submit action", () => {
    const validator = new A2uiActionValidator();
    const result = validator.validate({
      actionName: "submit", surfaceId: "session-a2ui",
      sourceComponentId: "btn-1", timestamp: "2026-07-21T12:00:00.000Z",
    }, "session-a2ui");
    expect(result.ok).toBe(true);
  });

  it("rejects action with mismatched surface ID", () => {
    const validator = new A2uiActionValidator();
    const result = validator.validate({
      actionName: "submit", surfaceId: "other-session",
      sourceComponentId: "btn-1", timestamp: "2026-07-21T12:00:00.000Z",
    }, "session-a2ui");
    expect(result.ok).toBe(false);
  });

  it("rejects unknown action names", () => {
    const validator = new A2uiActionValidator();
    const result = validator.validate({
      actionName: "execute_code", surfaceId: "session-a2ui",
      sourceComponentId: "btn-1", timestamp: "2026-07-21T12:00:00.000Z",
    }, "session-a2ui");
    expect(result.ok).toBe(false);
  });
});
