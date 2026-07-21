import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { UiMessagePayload } from "../../contracts/ui-message.js";
import { A2uiCatalog } from "./catalog.js";

export interface A2uiMessage {
  readonly version: string;
  readonly surfaceId: string;
  readonly updateComponents?: Record<string, unknown>[];
}

export class A2uiProjector {
  private readonly catalog: A2uiCatalog;

  constructor(catalog?: A2uiCatalog) {
    this.catalog = catalog ?? new A2uiCatalog();
  }

  project(event: PlatformEventEnvelope): UiMessagePayload | null {
    const a2uiMessage = this.buildMessage(event);
    if (a2uiMessage === null) return null;

    // 校验所有组件都在 Catalog 白名单内
    const components = a2uiMessage.updateComponents ?? [];
    for (const comp of components) {
      const compType = (comp as Record<string, unknown>).type as string | undefined;
      if (compType !== undefined && !this.catalog.isAllowed(compType)) {
        return null; // 禁止生成未知组件
      }
    }

    return {
      format: "a2ui",
      message: a2uiMessage as unknown as Record<string, unknown>,
    };
  }

  private buildMessage(event: PlatformEventEnvelope): A2uiMessage | null {
    const surfaceId = event.sessionId ?? "default";

    switch (event.type) {
      case "tool.started": {
        const payload = event.payload as {
          toolCallId?: string;
          toolName?: string;
        };
        return {
          version: "v0.9.1",
          surfaceId,
          updateComponents: [
            {
              id: payload.toolCallId ?? `tool-${event.sequence}`,
              type: "ToolCall",
              properties: {
                name: payload.toolName ?? "unknown",
                status: "running",
              },
            },
          ],
        };
      }

      case "tool.completed": {
        const payload = event.payload as {
          toolCallId?: string;
          isError?: boolean;
        };
        return {
          version: "v0.9.1",
          surfaceId,
          updateComponents: [
            {
              id: payload.toolCallId ?? `tool-${event.sequence}`,
              type: "ToolCall",
              properties: {
                status: payload.isError ? "error" : "completed",
              },
            },
          ],
        };
      }

      case "turn.completed": {
        const payload = event.payload as { turnId?: string };
        return {
          version: "v0.9.1",
          surfaceId,
          updateComponents: [
            {
              id: `turn-${payload.turnId ?? event.sequence}`,
              type: "Status",
              properties: {
                status: "completed",
              },
            },
          ],
        };
      }

      case "error": {
        const payload = event.payload as { message?: string };
        return {
          version: "v0.9.1",
          surfaceId,
          updateComponents: [
            {
              id: `error-${event.sequence}`,
              type: "Status",
              properties: {
                status: "error",
                message: payload.message ?? "未知错误",
              },
            },
          ],
        };
      }

      default:
        return null;
    }
  }
}
