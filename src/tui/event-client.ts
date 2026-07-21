import type { TuiApiClient } from "./api-client.js";

export interface TuiEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export type EventCallback = (event: TuiEvent) => void;

export class TuiEventClient {
  private abortController: AbortController | undefined;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  constructor(private readonly api: TuiApiClient) {}

  connect(
    sessionId: string,
    onEvent: EventCallback,
    sinceSeq?: number,
  ): void {
    this.abortController = new AbortController();
    this.reconnectAttempts = 0;
    this.doConnect(sessionId, onEvent, sinceSeq);
  }

  disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  private doConnect(
    sessionId: string,
    onEvent: EventCallback,
    sinceSeq?: number,
  ): void {
    const url = this.api.getEventsUrl(sessionId, sinceSeq);

    fetch(url, {
      headers: { "accept": "text/event-stream" },
      ...(this.abortController !== undefined
        ? { signal: this.abortController.signal }
        : {}),
    })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          onEvent({
            type: "error",
            payload: { message: `SSE 连接失败: HTTP ${response.status}` },
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastEventId: string | undefined;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            let currentEvent = "";
            let currentData = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                currentData = line.slice(6);
              } else if (line.startsWith("id: ")) {
                lastEventId = line.slice(4).trim();
              } else if (line === "") {
                // 空行 = 事件结束
                if (currentData !== "") {
                  try {
                    const parsed = JSON.parse(currentData);
                    // SSE data 中包含的是完整的 PlatformEventEnvelope
                    // 提取 type 和内部 payload 给渲染器
                    const envType = typeof parsed.type === "string" ? parsed.type : "unknown";
                    const envPayload = typeof parsed.payload === "object" && parsed.payload !== null
                      ? parsed.payload
                      : {};
                    onEvent({
                      type: envType,
                      payload: envPayload,
                    });
                  } catch {
                    // 非 JSON 数据，跳过
                  }
                }
                currentEvent = "";
                currentData = "";
              }
            }
          }
        } catch (error) {
          const isAbort =
            error instanceof DOMException && error.name === "AbortError";
          if (!isAbort && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts += 1;
            const delay = Math.min(100 * 2 ** this.reconnectAttempts, 2_000);
            onEvent({
              type: "connection.retry",
              payload: {
                attempt: this.reconnectAttempts,
                delay,
              },
            });
            setTimeout(() => {
              this.doConnect(sessionId, onEvent, sinceSeq);
            }, delay);
          }
        } finally {
          reader.releaseLock();
        }
      })
      .catch((error) => {
        const isAbort =
          error instanceof DOMException && error.name === "AbortError";
        if (!isAbort) {
          onEvent({
            type: "error",
            payload: { message: `连接失败: ${String(error)}` },
          });
        }
      });
  }
}
