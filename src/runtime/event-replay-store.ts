import type { PlatformEventEnvelope } from "../contracts/events.js";

const MAX_EVENTS_PER_STREAM = 1_000;

export interface ReplayResult {
  readonly events: readonly PlatformEventEnvelope[];
  readonly reset: boolean;
}

export type EventSubscriber = (event: PlatformEventEnvelope) => void;

interface StreamBuffer {
  events: PlatformEventEnvelope[];
  truncated: boolean;
}

export class EventReplayStore {
  private readonly streams = new Map<string, StreamBuffer>();
  private readonly subscribers = new Set<EventSubscriber>();

  publish(event: PlatformEventEnvelope): void {
    if (event.streamId === null) {
      return;
    }

    let buffer = this.streams.get(event.streamId);
    if (!buffer) {
      buffer = { events: [], truncated: false };
      this.streams.set(event.streamId, buffer);
    }

    buffer.events.push(event);
    if (buffer.events.length > MAX_EVENTS_PER_STREAM) {
      buffer.events = buffer.events.slice(-MAX_EVENTS_PER_STREAM);
      buffer.truncated = true;
    }

    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  getSince(streamId: string, sinceSeq: number): ReplayResult {
    const buffer = this.streams.get(streamId);
    if (!buffer || buffer.events.length === 0) {
      return { events: [], reset: true };
    }

    const oldest = buffer.events[0]!;

    // 如果 sinceSeq 比缓存中最老的事件还早，且缓存已被截断 → reset
    if (sinceSeq === 0) {
      if (buffer.truncated) {
        return { events: [...buffer.events], reset: true };
      }
      return { events: [...buffer.events], reset: false };
    }

    if (buffer.truncated && oldest.sequence > sinceSeq + 1) {
      return { events: [], reset: true };
    }

    if (sinceSeq > 0 && oldest.sequence > sinceSeq + 1) {
      return { events: [], reset: true };
    }

    const startIndex = buffer.events.findIndex((e) => e.sequence > sinceSeq);
    if (startIndex === -1) {
      return { events: [], reset: false };
    }

    return {
      events: buffer.events.slice(startIndex),
      reset: false,
    };
  }

  listSessionStreams(sessionId: string): string[] {
    const result: string[] = [];
    for (const [streamId, buffer] of this.streams) {
      if (buffer.events.some((e) => e.sessionId === sessionId)) {
        result.push(streamId);
      }
    }
    return result;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  reset(streamId: string): void {
    this.streams.delete(streamId);
  }

  get size(): number {
    return this.streams.size;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
