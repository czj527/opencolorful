import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type {
  A2uiComponent,
  A2uiServerMessage,
  UiMessagePayload,
} from "../../contracts/ui-message.js";
import { A2uiCatalog } from "./catalog.js";

interface ComponentProjection {
  readonly components: A2uiComponent[];
  readonly rootChildId: string;
  readonly replacedRootChildId?: string;
}

export class A2uiProjector {
  private readonly catalog: A2uiCatalog;
  private readonly createdSurfaces = new Set<string>();
  private readonly surfaceChildren = new Map<string, Set<string>>();
  private readonly streamText = new Map<string, string>();

  constructor(catalog?: A2uiCatalog) {
    this.catalog = catalog ?? new A2uiCatalog();
  }

  project(event: PlatformEventEnvelope): UiMessagePayload | null {
    const surfaceId = event.sessionId ?? "default";
    const projection = this.buildComponents(event);
    if (projection === null) return null;
    if (projection.components.some((component) => !this.catalog.isAllowed(component.component))) {
      return null;
    }

    let children = this.surfaceChildren.get(surfaceId);
    if (children === undefined) {
      children = new Set<string>();
      this.surfaceChildren.set(surfaceId, children);
    }
    if (projection.replacedRootChildId !== undefined) {
      children.delete(projection.replacedRootChildId);
    }
    children.add(projection.rootChildId);

    const messages: A2uiServerMessage[] = [];
    if (!this.createdSurfaces.has(surfaceId)) {
      this.createdSurfaces.add(surfaceId);
      messages.push({
        version: "v0.9.1",
        createSurface: {
          surfaceId,
          catalogId: this.catalog.getCatalogId(),
        },
      });
    }
    messages.push({
      version: "v0.9.1",
      updateComponents: {
        surfaceId,
        components: [
          { id: "root", component: "Column", children: [...children] },
          ...projection.components,
        ],
      },
    });
    return { format: "a2ui", messages };
  }

  private buildComponents(event: PlatformEventEnvelope): ComponentProjection | null {
    const streamKey = event.streamId ?? event.eventId;
    switch (event.type) {
      case "message.delta": {
        const payload = event.payload as { delta?: string };
        const id = `message-${streamKey}`;
        const text = `${this.streamText.get(streamKey) ?? ""}${payload.delta ?? ""}`.slice(0, 8_000);
        this.streamText.set(streamKey, text);
        return {
          rootChildId: id,
          components: [{ id, component: "Text", text, variant: "body" }],
        };
      }

      case "message.completed": {
        const payload = event.payload as { content?: string };
        const textId = `message-${streamKey}`;
        const cardId = `card-${streamKey}`;
        const text = (payload.content ?? this.streamText.get(streamKey) ?? "").slice(0, 8_000);
        this.streamText.set(streamKey, text);
        return {
          rootChildId: cardId,
          replacedRootChildId: textId,
          components: [
            { id: textId, component: "Text", text, variant: "body" },
            { id: cardId, component: "Card", child: textId },
          ],
        };
      }

      case "tool.started": {
        const payload = event.payload as { toolCallId?: string; toolName?: string };
        const id = payload.toolCallId ?? `tool-${event.sequence}`;
        return {
          rootChildId: id,
          components: [{
            id,
            component: "ToolCall",
            name: payload.toolName ?? "unknown",
            status: "running",
          }],
        };
      }

      case "tool.completed": {
        const payload = event.payload as { toolCallId?: string; isError?: boolean };
        const id = payload.toolCallId ?? `tool-${event.sequence}`;
        return {
          rootChildId: id,
          components: [{
            id,
            component: "ToolCall",
            status: payload.isError ? "error" : "completed",
          }],
        };
      }

      case "plan.updated": {
        const payload = event.payload as { items?: unknown };
        const id = `plan-${streamKey}`;
        const items = Array.isArray(payload.items)
          ? payload.items.filter((item): item is string => typeof item === "string").slice(0, 50)
          : [];
        return {
          rootChildId: id,
          components: [{ id, component: "Plan", items }],
        };
      }

      case "attachment.available": {
        const payload = event.payload as {
          attachmentId?: string;
          name?: string;
          mimeType?: string;
        };
        const id = payload.attachmentId ?? `attachment-${event.sequence}`;
        return {
          rootChildId: id,
          components: [{
            id,
            component: "Attachment",
            name: payload.name ?? "attachment",
            ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
          }],
        };
      }

      case "turn.completed": {
        const payload = event.payload as { turnId?: string };
        const id = `turn-${payload.turnId ?? event.sequence}`;
        return {
          rootChildId: id,
          components: [{ id, component: "Status", status: "completed" }],
        };
      }

      case "error": {
        const payload = event.payload as { message?: string };
        const id = `error-${event.sequence}`;
        return {
          rootChildId: id,
          components: [{
            id,
            component: "Status",
            status: "error",
            message: payload.message ?? "未知错误",
          }],
        };
      }

      default:
        return null;
    }
  }
}
