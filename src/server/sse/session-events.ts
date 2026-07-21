import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { Context } from "hono";

import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { PlatformEventEnvelope } from "../../contracts/events.js";

function parseLastSequence(context: Context): number {
  const lastEventId = context.req.header("Last-Event-ID");
  if (lastEventId !== undefined && lastEventId.trim() !== "") {
    const seq = Number(lastEventId);
    if (Number.isInteger(seq) && seq >= 0) {
      return seq;
    }
  }

  const sinceSeq = context.req.query("sinceSeq");
  if (sinceSeq !== undefined) {
    const seq = Number(sinceSeq);
    if (Number.isInteger(seq) && seq >= 0) {
      return seq;
    }
  }

  return 0;
}

async function writeEvent(
  stream: SSEStreamingApi,
  event: PlatformEventEnvelope,
): Promise<void> {
  await stream.writeSSE({
    id: String(event.sequence),
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

  const sinceSeq = parseLastSequence(context);

  return streamSSE(context, async (stream) => {
    const abortSignal = context.req.raw.signal;
    let aborted = false;

    abortSignal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );

    // 先重放已有事件
    const sessionStreams = replayStore.listSessionStreams(sessionId);

    for (const streamId of sessionStreams) {
      if (aborted) break;
      const result = replayStore.getSince(streamId, sinceSeq);

      if (result.reset && sinceSeq > 0) {
        await stream.writeSSE({
          event: "reset",
          data: JSON.stringify({
            streamId,
            reason: "缓存已截断，请重新开始",
          }),
        });
      }

      for (const event of result.events) {
        if (aborted) break;
        if (event.sessionId === sessionId) {
          await writeEvent(stream, event);
        }
      }
    }

    if (aborted) return;

    // 建立订阅以获取实时事件
    const unsubscribe = replayStore.subscribe((event) => {
      if (event.sessionId === sessionId && !aborted) {
        void writeEvent(stream, event).catch(() => {
          // 写入失败（客户端已断开），静默忽略
        });
      }
    });

    // 等待客户端断开
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

    unsubscribe();
  });
}
