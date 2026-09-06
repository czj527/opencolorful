import { afterEach, describe, expect, it, vi } from "vitest";

import { TuiApiClient } from "../../src/tui/api-client.js";
import { TuiEventClient, type TuiEvent } from "../../src/tui/event-client.js";

const encoder = new TextEncoder();

function responseFromChunks(chunks: string[], failAfterChunks = false): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk !== undefined) {
        index += 1;
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      if (failAfterChunks) {
        controller.error(new Error("connection lost"));
      } else {
        controller.close();
      }
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TuiEventClient", () => {
  it("parses an SSE frame split across network chunks", async () => {
    const fetchMock = vi.fn(async () => responseFromChunks([
      "id: stream-1:1\nevent: message.delta\n",
      'data: {"type":"message.delta","payload":{"role":"assistant","delta":"hello"}}\n',
      "\n",
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TuiEventClient(new TuiApiClient("http://127.0.0.1"));
    const events: TuiEvent[] = [];
    client.connect("session-1", (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.disconnect();

    expect(events).toContainEqual({
      type: "message.delta",
      payload: { role: "assistant", delta: "hello" },
    });
  });

  it("reconnects with the full Last-Event-ID cursor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFromChunks([
        'id: stream-7:9\nevent: session.status\ndata: {"type":"session.status","payload":{"status":"running"}}\n\n',
      ], true))
      .mockResolvedValue(responseFromChunks([]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TuiEventClient(new TuiApiClient("http://127.0.0.1"));
    client.connect("session-1", () => {});
    await new Promise((resolve) => setTimeout(resolve, 350));
    client.disconnect();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1/api/sessions/session-1/events");
    expect(new Headers(options.headers).get("Last-Event-ID")).toBe("stream-7:9");
  });
});
