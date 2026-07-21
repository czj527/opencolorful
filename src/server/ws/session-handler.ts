import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";

import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { SessionService } from "../../runtime/session-service.js";
import { isClientCommand } from "../../contracts/commands.js";
import { ClientRegistry } from "./client-registry.js";
import { serializeMessage } from "./protocol.js";

export class SessionHandler {
  private readonly clientId: string;

  constructor(
    private readonly ws: WSContext<WebSocket>,
    clientId: string,
    private readonly registry: ClientRegistry,
    private readonly promptService: PromptService,
    private readonly replayStore: EventReplayStore,
    private readonly sessionService?: SessionService,
  ) {
    this.clientId = clientId;
  }

  handleMessage(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.sendError("命令格式无效");
      return;
    }

    if (!isClientCommand(data)) {
      this.sendError("未知命令类型");
      return;
    }

    const command = data;

    if (command.type === "session.subscribe") {
      if (!this.sessionExists(command.sessionId)) {
        this.sendError("Session 不存在", command.requestId);
        return;
      }
      this.registry.subscribe(this.clientId, command.sessionId);
      this.ws.send(
        serializeMessage({
          type: "ack",
          requestId: command.requestId,
          status: "accepted",
        }),
      );
      return;
    }

    if (command.type === "session.unsubscribe") {
      this.registry.unsubscribe(this.clientId, command.sessionId);
      this.ws.send(
        serializeMessage({
          type: "ack",
          requestId: command.requestId,
          status: "accepted",
        }),
      );
      return;
    }

    if (command.type === "session.abort") {
      try {
        const result = this.promptService.abortBySession(command.sessionId);
        this.ws.send(
          serializeMessage({
            type: "ack",
            requestId: command.requestId,
            status: result.status,
          }),
        );
      } catch {
        this.sendError("Session 不存在", command.requestId);
      }
      return;
    }

    if (command.type === "session.compact") {
      try {
        this.promptService.compact(command.sessionId).then(
          () => {
            this.ws.send(serializeMessage({
              type: "ack", requestId: command.requestId, status: "accepted",
            }));
          },
          (err) => {
            this.sendError(`Compact 失败: ${err instanceof Error ? err.message : "未知错误"}`, command.requestId);
          },
        );
      } catch {
        this.sendError("Session 不存在", command.requestId);
      }
      return;
    }

    if (command.type === "stream.resume") {
      if (!this.registry.isSubscribed(this.clientId, command.sessionId)) {
        this.sendError("请先订阅 Session 再请求 stream resume", command.requestId);
        return;
      }
      const result = this.replayStore.getSince(
        command.streamId,
        command.lastSequence,
      );
      if (result.reset) {
        this.ws.send(
          serializeMessage({
            type: "error",
            requestId: command.requestId,
            code: "CACHE_TRUNCATED",
            message: "缓存已截断，请重新开始",
          }),
        );
        return;
      }
      for (const event of result.events) {
        if (event.sessionId === command.sessionId) {
          this.ws.send(serializeMessage({ type: "event", payload: event }));
        }
      }
      this.ws.send(
        serializeMessage({
          type: "ack",
          requestId: command.requestId,
          status: "accepted",
        }),
      );
      return;
    }

    // 默认：不支持的命令（TypeScript narrows command 到 never 因为所有分支已覆盖）
    const unknownCommand = command as { requestId?: string };
    this.sendError("不支持的命令", unknownCommand.requestId);
  }

  handleClose(): void {
    this.registry.remove(this.clientId);
  }

  private sessionExists(sessionId: string): boolean {
    if (this.sessionService === undefined) {
      return this.promptService.hasRuntime(sessionId);
    }
    try {
      this.sessionService.getView(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  private sendError(message: string, requestId?: string): void {
    this.ws.send(
      serializeMessage({
        type: "error",
        ...(requestId !== undefined ? { requestId } : {}),
        code: "INVALID_INPUT",
        message,
      }),
    );
  }
}
