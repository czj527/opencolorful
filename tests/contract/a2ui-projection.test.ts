import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  UiMessagePayloadSchema,
  type A2uiComponent,
  type A2uiServerMessage,
  type UiMessagePayload,
} from "../../src/contracts/ui-message.js";
import { A2uiProjector } from "../../src/ui-projection/a2ui/project.js";
import { A2uiCatalog } from "../../src/ui-projection/a2ui/catalog.js";
import { A2uiActionValidator } from "../../src/ui-projection/a2ui/action.js";

function event(type: string, payload: Record<string, unknown>, sequence = 1) {
  return {
    protocolVersion: 1,
    eventId: `evt-${sequence}`,
    sessionId: "session-a2ui",
    streamId: "stream-1",
    sequence,
    timestamp: "2026-07-21T12:00:00.000Z",
    type,
    payload,
  } as never;
}

function messages(payload: UiMessagePayload | null): readonly A2uiServerMessage[] {
  expect(payload?.format).toBe("a2ui");
  if (payload?.format !== "a2ui") return [];
  expect(Value.Check(UiMessagePayloadSchema, payload)).toBe(true);
  return payload.messages;
}

function components(message: A2uiServerMessage): readonly A2uiComponent[] {
  if (!("updateComponents" in message)) return [];
  return message.updateComponents.components;
}

describe("A2UI v0.9.1 projection", () => {
  it("emits createSurface before a standard updateComponents envelope", () => {
    const result = messages(new A2uiProjector().project(event("tool.started", {
      toolCallId: "t1",
      toolName: "search",
    })));

    expect(result[0]).toEqual({
      version: "v0.9.1",
      createSurface: {
        surfaceId: "session-a2ui",
        catalogId: "opencolorful/v1",
      },
    });
    expect(result[1]).toMatchObject({
      version: "v0.9.1",
      updateComponents: { surfaceId: "session-a2ui" },
    });
    expect(components(result[1]!)).toEqual(expect.arrayContaining([
      { id: "root", component: "Column", children: ["t1"] },
      { id: "t1", component: "ToolCall", name: "search", status: "running" },
    ]));
  });

  it("creates a surface once and updates existing components", () => {
    const projector = new A2uiProjector();
    messages(projector.project(event("tool.started", { toolCallId: "t1", toolName: "search" })));
    const completed = messages(projector.project(event("tool.completed", {
      toolCallId: "t1",
      isError: true,
    }, 2)));

    expect(completed).toHaveLength(1);
    expect(completed[0]).not.toHaveProperty("createSurface");
    expect(components(completed[0]!)).toContainEqual({
      id: "t1",
      component: "ToolCall",
      status: "error",
    });
  });

  it("projects Text, Card, Plan, Attachment, and Status components", () => {
    const projector = new A2uiProjector();
    const delta = messages(projector.project(event("message.delta", {
      role: "assistant",
      delta: "hello",
    })));
    const completed = messages(projector.project(event("message.completed", {
      role: "assistant",
      content: "hello",
    }, 2)));
    const plan = messages(projector.project(event("plan.updated", {
      items: ["分析", "实现"],
    }, 3)));
    const attachment = messages(projector.project(event("attachment.available", {
      attachmentId: "a1",
      name: "report.txt",
      mimeType: "text/plain",
    }, 4)));
    const status = messages(projector.project(event("turn.completed", { turnId: "turn-1" }, 5)));

    expect(components(delta.at(-1)!).some((item) => item.component === "Text")).toBe(true);
    expect(components(completed[0]!).some((item) => item.component === "Card")).toBe(true);
    expect(components(plan[0]!).some((item) => item.component === "Plan")).toBe(true);
    expect(components(attachment[0]!).some((item) => item.component === "Attachment")).toBe(true);
    expect(components(status[0]!).some((item) => item.component === "Status")).toBe(true);
  });

  it("uses only components from the fixed local catalog", () => {
    const catalog = new A2uiCatalog();
    expect(catalog.getCatalogId()).toBe("opencolorful/v1");
    expect(catalog.isAllowed("Column")).toBe(true);
    expect(catalog.isAllowed("UnknownWidget")).toBe(false);
  });
});

describe("A2UI v0.9.1 action validation", () => {
  const validationContext = {
    sessionId: "session-a2ui",
    surfaceId: "surface-a2ui",
    components: { "btn-1": "Button", "select-1": "Input" },
  } as const;

  function action(
    name: string,
    sourceComponentId = "btn-1",
    context: Record<string, unknown> = {},
  ) {
    return {
      version: "v0.9.1",
      action: {
        name,
        surfaceId: "surface-a2ui",
        sourceComponentId,
        timestamp: "2026-07-21T12:00:00.000Z",
        context,
      },
    };
  }

  it("accepts a valid official action envelope", () => {
    expect(new A2uiActionValidator().validate(
      action("submit"),
      validationContext,
    ).ok).toBe(true);
  });

  it("rejects malformed envelopes, unknown components, and invalid parameters", () => {
    const validator = new A2uiActionValidator();
    expect(validator.validate({ action: action("submit").action }, validationContext).ok).toBe(false);
    expect(validator.validate(action("submit", "missing"), validationContext).ok).toBe(false);
    expect(validator.validate(action("select", "select-1", { value: false }), validationContext).ok)
      .toBe(false);
  });

  it("rejects actions from another surface or with an unknown name", () => {
    const validator = new A2uiActionValidator();
    const wrongSurface = action("submit");
    wrongSurface.action.surfaceId = "other-surface";
    expect(validator.validate(wrongSurface, validationContext).ok).toBe(false);
    expect(validator.validate(action("execute_code"), validationContext).ok).toBe(false);
  });
});
