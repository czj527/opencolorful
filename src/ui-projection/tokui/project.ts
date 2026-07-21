import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { UiMessagePayload } from "../../contracts/ui-message.js";
import { TokuiPolicy, TOKUI_MAX_BUFFER, TOKUI_MAX_CHUNK_LENGTH } from "./policy.js";

/** 转义 DSL 中的特殊字符，防止动态值注入 TokUI 语法 */
function escapeDslValue(value: string): string {
  return value
    .replace(/"/g, "&quot;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\n/g, " ")
    .replace(/\r/g, "");
}

export class TokuiProjector {
  private readonly policy: TokuiPolicy;

  constructor(policy?: TokuiPolicy) {
    this.policy = policy ?? new TokuiPolicy();
  }

  project(event: PlatformEventEnvelope): UiMessagePayload | null {
    const chunk = this.buildChunk(event);
    if (chunk === null) return null;

    // 安全校验
    const validation = this.policy.validateChunk(chunk);
    if (!validation.ok) return null;

    return { format: "tokui", chunk };
  }

  private buildChunk(event: PlatformEventEnvelope): string | null {
    switch (event.type) {
      case "tool.started": {
        const payload = event.payload as {
          toolName?: string;
          toolCallId?: string;
        };
        return `[tool-call id:"${escapeDslValue(payload.toolCallId ?? "tool")}" ` +
          `name:"${escapeDslValue(payload.toolName ?? "未知工具")}" status:running]` +
          `[p "工具调用进行中"][/tool-call]`;
      }

      case "tool.delta": {
        const payload = event.payload as {
          delta?: string;
          toolCallId?: string;
        };
        const safeDelta = escapeDslValue((payload.delta ?? "").slice(0, 200));
        return `[p v:muted "${safeDelta}"]`;
      }

      case "tool.completed": {
        const p = event.payload as Record<string, unknown>;
        const toolCallId = p.toolCallId as string | undefined;
        const isError = p.isError as boolean | undefined;
        return `[upd id:"${escapeDslValue(toolCallId ?? "tool")}" ` +
          `status:${isError ? "error" : "done"}]`;
      }

      case "turn.completed": {
        return `[callout t:success tx:"Turn 完成"]`;
      }

      case "plan.updated": {
        const payload = event.payload as { items?: unknown };
        const items = Array.isArray(payload.items)
          ? payload.items.filter((item): item is string => typeof item === "string").slice(0, 20)
          : [];
        return `[plan tt:"执行计划"]${items.map((item) =>
          `[plan-step status:pending tt:"${escapeDslValue(item.slice(0, 200))}"]`
        ).join("")}[/plan]`;
      }

      case "error": {
        const payload = event.payload as { message?: string };
        return `[card tt:"错误"]` +
          `[callout t:danger tx:"${escapeDslValue((payload.message ?? "未知错误").slice(0, 200))}"]` +
          `[/card]`;
      }

      default:
        return null;
    }
  }
}

export class TokuiStreamBuilder {
  private chunks: string[] = [];
  private bufferSize = 0;
  private readonly projector: TokuiProjector;

  constructor(policy?: TokuiPolicy) {
    this.projector = new TokuiProjector(policy);
  }

  feed(event: PlatformEventEnvelope): void {
    const payload = this.projector.project(event);
    if (payload !== null && payload.format === "tokui") {
      // MAX_BUFFER 限制
      if (this.bufferSize + payload.chunk.length > TOKUI_MAX_BUFFER) {
        return;
      }
      this.chunks.push(payload.chunk);
      this.bufferSize += payload.chunk.length;
    }
  }

  flush(maxSize = TOKUI_MAX_CHUNK_LENGTH): string[] {
    const result: string[] = [];
    let current = "";

    for (const chunk of this.chunks) {
      if (current.length + chunk.length > maxSize && current !== "") {
        result.push(current);
        current = chunk;
      } else {
        current += chunk;
      }
    }
    if (current !== "") result.push(current);

    this.chunks = [];
    this.bufferSize = 0;
    return result;
  }

  get size(): number {
    return this.bufferSize;
  }
}
