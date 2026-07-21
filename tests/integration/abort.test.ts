import { describe, expect, it } from "vitest";

import { ExecutionRegistry } from "../../src/runtime/execution-registry.js";

describe("execution registry", () => {
  it("allows one active stream per session and distinguishes abort races", async () => {
    const registry = new ExecutionRegistry();
    const controller = new AbortController();
    const first = registry.start("session-1", controller);
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted") throw new Error("expected accepted execution");

    expect(registry.start("session-1", new AbortController())).toEqual({
      status: "rejected",
      reason: "already-running",
    });
    expect(registry.abort("session-1", "wrong-stream")).toEqual({ status: "rejected" });
    expect(registry.abort("session-1", first.streamId)).toEqual({ status: "accepted" });
    expect(controller.signal.aborted).toBe(true);
    expect(registry.abort("session-1", first.streamId)).toEqual({ status: "already-stopped" });

    registry.finish("session-1", first.streamId);
    expect(registry.abort("session-1", first.streamId)).toEqual({ status: "already-stopped" });
    await first.completed;
  });
});
