import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { UiMessagePayload } from "../../contracts/ui-message.js";
import { TokuiPolicy, TOKUI_MAX_BUFFER, TOKUI_MAX_CHUNK_LENGTH } from "./policy.js";

/** 转义 DSL 中的特殊字符，防止动态值注入 TokUI 语法 */
function escapeDsValue(value: string): string {
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
        return `[card tt:"工具调用" id:"${escapeDsValue(payload.toolCallId ?? "tool")}"]` +
          `[desc]${escapeDsValue(payload.toolName ?? "未知工具")}[/desc]` +
          `[badge v:info]运行中...[/badge]`;
      }

      case "tool.delta": {
        const payload = event.payload as {
          delta?: string;
          toolCallId?: string;
        };
        const safeDelta = escapeDsValue((payload.delta ?? "").slice(0, 200));
        return `[upd id:"${payload.toolCallId ?? "tool"}"][p]${safeDelta}[/p][/upd]`;
      }

      case "tool.completed": {
        const p = event.payload as Record<string, unknown>;
        const toolCallId = p.toolCallId as string | undefined;
        const isError = p.isError as boolean | undefined;
        const variant = isError ? "v:danger" : "v:success";
        return `[upd id:"${toolCallId ?? "tool"}"][badge ${variant}]${isError ? "失败" : "完成"}[/badge][/upd]`;
      }

      case "turn.completed": {
        return `[desc]Turn 完成[/desc]`;
      }

      case "error": {
        const payload = event.payload as { message?: string };
        return `[card tt:"错误"]` +
          `[badge v:danger]错误[/badge]` +
          `[p]${escapeDsValue((payload.message ?? "未知错误").slice(0, 200))}[/p]` +
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
