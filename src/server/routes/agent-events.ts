import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { Context, Hono } from "hono";
import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { AgentStore } from "../../config/agent-store.js";
import type { SessionService } from "../../runtime/session-service.js";

function cursor(context: Context): number {
  const raw = context.req.header("Last-Event-ID") ?? context.req.query("sinceSeq") ?? "0";
  const value = Number(raw.slice(raw.lastIndexOf(":") + 1));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function belongs(event: PlatformEventEnvelope, agentId: string, sessionService?: SessionService): boolean {
  const payload = event.payload as { agentId?: unknown; sessionId?: unknown };
  if (payload.agentId === agentId) return true;
  if (payload.agentId !== undefined && payload.agentId !== null) return false;
  if (payload.sessionId === undefined || payload.sessionId === null) return true;
  if (sessionService === undefined) return false;
  try { return sessionService.getView(String(payload.sessionId)).agentId === agentId; } catch { return false; }
}

async function writeEvent(stream: SSEStreamingApi, event: PlatformEventEnvelope): Promise<void> {
  await stream.writeSSE({ id: `${event.streamId ?? "?"}:${event.sequence}`, event: event.type, data: JSON.stringify(event) });
}

export function registerAgentEventRoutes(app: Hono, replayStore: EventReplayStore, agentStore?: AgentStore, sessionService?: SessionService): void {
  app.get("/api/agents/:id/events", (context) => {
    const agentId = context.req.param("id");
    if (agentStore) { try { agentStore.load(agentId); } catch { return context.json({ code: "NOT_FOUND", message: "Agent 不存在", retryable: false }, 404); } }
    const streamId = `agent:${agentId}`;
    const since = cursor(context);
    return streamSSE(context, async (stream) => {
      const signal = context.req.raw.signal;
      let aborted = false;
      let replaying = true;
      const pending: PlatformEventEnvelope[] = [];
      const delivered = new Set<string>();
      let queue = Promise.resolve();
      const enqueue = (event: PlatformEventEnvelope): void => {
        if (aborted || event.streamId !== streamId || !belongs(event, agentId, sessionService) || delivered.has(event.eventId)) return;
        delivered.add(event.eventId);
        queue = queue.then(() => writeEvent(stream, event)).catch(() => { aborted = true; });
      };
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      const unsubscribe = replayStore.subscribe((event) => {
        if (event.streamId !== streamId || !belongs(event, agentId, sessionService)) return;
        if (replaying) pending.push(event); else enqueue(event);
      });
      try {
        const result = replayStore.getSince(streamId, since);
        if (result.reset && since > 0) await stream.writeSSE({ event: "reset", data: JSON.stringify({ streamId, reason: "缓存已截断，请重新开始" }) });
        for (const event of result.events) enqueue(event);
        await queue;
        replaying = false;
        for (const event of pending) enqueue(event);
        await queue;
        if (!aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally { replaying = false; unsubscribe(); }
    });
  });
}
