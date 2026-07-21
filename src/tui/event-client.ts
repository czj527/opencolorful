import type { TuiApiClient } from "./api-client.js";

export interface TuiEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export type EventCallback = (event: TuiEvent) => void;

export class TuiEventClient {
  private abortController: AbortController | undefined;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;

  constructor(private readonly api: TuiApiClient) {}

  connect(
    sessionId: string,
    onEvent: EventCallback,
    sinceSeq?: number,
  ): void {
    this.disconnect();
    const controller = new AbortController();
    this.abortController = controller;
    this.reconnectAttempts = 0;
    void this.doConnect(sessionId, onEvent, controller, sinceSeq);
  }

  disconnect(): void {
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private async doConnect(
    sessionId: string,
    onEvent: EventCallback,
    controller: AbortController,
    sinceSeq?: number,
    resumeEventId?: string,
  ): Promise<void> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (resumeEventId !== undefined) headers["Last-Event-ID"] = resumeEventId;

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let lastEventId = resumeEventId;
    try {
      const response = await fetch(this.api.getEventsUrl(sessionId, sinceSeq), {
        headers,
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`SSE 连接失败: HTTP ${response.status}`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData: string[] = [];

      while (this.abortController === controller && !controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData.push(line.slice(5).trimStart());
          } else if (line.startsWith("id:")) {
            lastEventId = line.slice(3).trim();
          } else if (line === "") {
            if (currentData.length > 0) {
              this.dispatchEvent(currentEvent, currentData.join("\n"), onEvent);
              this.reconnectAttempts = 0;
            }
            currentEvent = "";
            currentData = [];
          }
        }
      }

      if (!controller.signal.aborted) {
        this.scheduleReconnect(sessionId, onEvent, controller, lastEventId, sinceSeq);
      }
    } catch (error) {
      if (controller.signal.aborted || this.abortController !== controller) return;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        onEvent({
          type: "error",
          payload: { message: `连接失败: ${String(error)}` },
        });
        return;
      }
      this.scheduleReconnect(sessionId, onEvent, controller, lastEventId, sinceSeq);
    } finally {
      reader?.releaseLock();
    }
  }

  private dispatchEvent(
    eventName: string,
    data: string,
    onEvent: EventCallback,
  ): void {
    try {
      const parsed = JSON.parse(data) as { type?: unknown; payload?: unknown };
      const type = typeof parsed.type === "string"
        ? parsed.type
        : eventName || "unknown";
      const payload = typeof parsed.payload === "object" && parsed.payload !== null
        ? parsed.payload as Record<string, unknown>
        : {};
      onEvent({ type, payload });
    } catch {
      // 非 JSON 数据不是平台事件，忽略。
    }
  }

  private scheduleReconnect(
    sessionId: string,
    onEvent: EventCallback,
    controller: AbortController,
    lastEventId?: string,
    sinceSeq?: number,
  ): void {
    if (
      this.abortController !== controller ||
      controller.signal.aborted ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      return;
    }

    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = Math.min(100 * 2 ** attempt, 2_000);
    onEvent({ type: "connection.retry", payload: { attempt, delay } });
    setTimeout(() => {
      if (this.abortController !== controller || controller.signal.aborted) return;
      void this.doConnect(
        sessionId,
        onEvent,
        controller,
        lastEventId === undefined ? sinceSeq : undefined,
        lastEventId,
      );
    }, delay);
  }
}
