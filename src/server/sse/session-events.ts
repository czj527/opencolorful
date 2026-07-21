import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { Context } from "hono";

import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { PlatformEventEnvelope } from "../../contracts/events.js";

interface ReplayCursor {
  readonly streamId?: string;
  readonly sequence: number;
}

function parseReplayCursor(context: Context): ReplayCursor {
  const lastEventId = context.req.header("Last-Event-ID");
  if (lastEventId !== undefined && lastEventId.trim() !== "") {
    const separator = lastEventId.lastIndexOf(":");
    const sequence = Number(separator === -1 ? lastEventId : lastEventId.slice(separator + 1));
    if (Number.isInteger(sequence) && sequence >= 0) {
      const streamId = separator > 0 ? lastEventId.slice(0, separator) : undefined;
      return streamId === undefined ? { sequence } : { streamId, sequence };
    }
  }

  const sinceSeq = context.req.query("sinceSeq");
  if (sinceSeq !== undefined) {
    const seq = Number(sinceSeq);
    if (Number.isInteger(seq) && seq >= 0) {
      return { sequence: seq };
    }
  }

  return { sequence: 0 };
}

async function writeEvent(
  stream: SSEStreamingApi,
  event: PlatformEventEnvelope,
): Promise<void> {
  await stream.writeSSE({
    id: `${event.streamId ?? "?"}:${event.sequence}`,
    event: event.type,
    data: JSON.stringify(event),
  });
}

export async function createSessionEventStream(
  context: Context,
  sessionId: string,
  replayStore: EventReplayStore,
  promptService: PromptService,
): Promise<Response> {
  // Runtime 可能尚未创建（将在首次 Prompt 时自动创建），不 404
  // SSE 连接保持打开，等待后续实时事件

  const cursor = parseReplayCursor(context);

  return streamSSE(context, async (stream) => {
    const abortSignal = context.req.raw.signal;
    let aborted = false;
    let replaying = true;
    const pendingLive: PlatformEventEnvelope[] = [];
    const deliveredEventIds = new Set<string>();
    let writeQueue = Promise.resolve();

    const enqueue = (event: PlatformEventEnvelope): void => {
      if (
        aborted ||
        event.sessionId !== sessionId ||
        deliveredEventIds.has(event.eventId)
      ) {
        return;
      }
      deliveredEventIds.add(event.eventId);
      writeQueue = writeQueue
        .then(() => writeEvent(stream, event))
        .catch(() => {
          aborted = true;
        });
    };

    abortSignal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );

    // 先订阅再读取快照，避免 replay 与实时广播之间出现丢事件窗口。
    const unsubscribe = replayStore.subscribe((event) => {
      if (event.sessionId !== sessionId || aborted) return;
      if (replaying) {
        pendingLive.push(event);
      } else {
        enqueue(event);
      }
    });

    const sessionStreams = cursor.streamId === undefined
      ? replayStore.listSessionStreams(sessionId)
      : [cursor.streamId];
    try {
      for (const streamId of sessionStreams) {
        if (aborted) break;
        const result = replayStore.getSince(streamId, cursor.sequence);

        if (result.reset && cursor.sequence > 0) {
          await stream.writeSSE({
            event: "reset",
            data: JSON.stringify({
              streamId,
              reason: "缓存已截断，请重新开始",
            }),
          });
        }

        for (const event of result.events) enqueue(event);
      }

      await writeQueue;
      replaying = false;
      for (const event of pendingLive) enqueue(event);
      pendingLive.length = 0;
      await writeQueue;
      if (aborted) return;

      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          abortSignal.removeEventListener("abort", onAbort);
          resolve();
        };
        if (aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      });
      await writeQueue;
    } finally {
      replaying = false;
      unsubscribe();
    }
  });
}
