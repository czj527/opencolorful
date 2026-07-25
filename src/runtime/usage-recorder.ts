import type { PlatformEventEnvelope } from "../contracts/events.js";
import type { EventReplayStore, EventSubscriber } from "./event-replay-store.js";
import type { UsageStore } from "../storage/usage-store.js";

export interface ModelResolver {
  (sessionId: string): { providerId: string; modelId: string } | null;
}

export class UsageRecorder {
  private readonly unsubscribe: () => void;

  constructor(
    replayStore: EventReplayStore,
    private readonly usageStore: UsageStore,
    private readonly resolveModel: ModelResolver,
  ) {
    const subscriber: EventSubscriber = (event) => {
      this.handleEvent(event);
    };
    this.unsubscribe = replayStore.subscribe(subscriber);
  }

  private handleEvent(event: PlatformEventEnvelope): void {
    if (event.type !== "turn.completed") {
      return;
    }
    if (event.sessionId === null) {
      return;
    }

    const payload = event.payload as {
      turnId?: string;
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        totalTokens: number;
      };
      context?: {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      };
    };

    if (payload.turnId === undefined || payload.usage === undefined) {
      return;
    }

    const model = this.resolveModel(event.sessionId);
    const provider = model?.providerId ?? "unknown";
    const modelId = model?.modelId ?? "unknown";

    this.usageStore.record({
      sessionId: event.sessionId,
      turnId: payload.turnId,
      provider,
      model: modelId,
      input: payload.usage.input,
      output: payload.usage.output,
      cacheRead: payload.usage.cacheRead,
      cacheWrite: payload.usage.cacheWrite,
      totalTokens: payload.usage.totalTokens,
      contextTokens: payload.context?.tokens ?? null,
      contextWindow: payload.context?.contextWindow ?? null,
      createdAt: event.timestamp,
    });
  }

  dispose(): void {
    this.unsubscribe();
  }
}
