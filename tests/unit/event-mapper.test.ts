import { describe, expect, it } from "vitest";

import { PlatformEventMapper } from "../../src/runtime/event-mapper.js";

describe("PlatformEventMapper tool result safety", () => {
  it("redacts and bounds tool result payloads", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [event] = mapper.map({
      type: "tool_end",
      toolCallId: "tool-1",
      result: `Authorization: Bearer plain-secret-token ${"x".repeat(5000)}`,
      isError: false,
    });

    expect(event).toBeDefined();
    const result = (event?.payload as { result?: unknown }).result;
    expect(typeof result).toBe("string");
    expect(result).not.toContain("plain-secret-token");
    expect((result as string).length).toBeLessThanOrEqual(2000);
  });

  it("redacts credentials inside structured tool results", () => {
    const mapper = new PlatformEventMapper("session-1", "stream-1");
    const [event] = mapper.map({
      type: "tool_end",
      toolCallId: "tool-2",
      result: { headers: { Authorization: "Bearer json-secret-token" } },
      isError: false,
    });

    const result = (event?.payload as { result?: unknown }).result;
    expect(result).not.toContain("json-secret-token");
  });
});
