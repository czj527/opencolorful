import type { TuiEvent } from "./event-client.js";

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";

export function renderEvent(event: TuiEvent): string | undefined {
  switch (event.type) {
    case "session.status": {
      const status = String(event.payload.status ?? "");
      if (status === "running") return `${GREEN}▸ 运行中...${RESET}`;
      if (status === "idle") return `${DIM}◼ 就绪${RESET}`;
      if (status === "error") return `${RED}✗ 错误${RESET}`;
      return `${DIM}[Session: ${status}]${RESET}`;
    }

    case "message.started":
      return `${CYAN}--- 助手回复 ---${RESET}`;

    case "message.delta": {
      const delta = String(event.payload.delta ?? "");
      return delta;
    }

    case "message.completed":
      return "";

    case "thinking.delta": {
      const delta = String(event.payload.delta ?? "");
      return `${DIM}[思考] ${delta.slice(0, 120)}${delta.length > 120 ? "..." : ""}${RESET}`;
    }

    case "tool.started": {
      const name = String(event.payload.toolName ?? "?");
      return `${YELLOW}[工具] ${name} …${RESET}`;
    }

    case "tool.completed": {
      const name = String(event.payload.toolCallId ?? "?");
      const isError = Boolean(event.payload.isError);
      return isError
        ? `${RED}[工具] ${name} ✗${RESET}`
        : `${GREEN}[工具] ${name} ✓${RESET}`;
    }

    case "turn.started":
      return `${DIM}--- Turn ---${RESET}`;

    case "turn.completed":
      return "";

    case "error": {
      const message = String(event.payload.message ?? "未知错误");
      return `${RED}[错误] ${message}${RESET}`;
    }

    case "connection.retry": {
      const attempt = Number(event.payload.attempt ?? 0);
      return `${YELLOW}[重连] 第 ${attempt} 次尝试...${RESET}`;
    }

    default: {
      // 检查是否是 UI 消息
      const format = event.payload?.format as string | undefined;
      if (format === "a2ui" || format === "tokui") {
        return `${DIM}[UI: ${format}]${RESET}`;
      }
      // 未知事件类型 - 静默忽略
      return undefined;
    }
  }
}
