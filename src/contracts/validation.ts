import { Value } from "typebox/value";

import { ClientCommandSchema, type ClientCommand } from "./commands.js";
import { EVENT_TYPES, PlatformEventEnvelopeSchema, type PlatformEventEnvelope } from "./events.js";

const eventTypeSet = new Set<string>(EVENT_TYPES);

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

function invalid(...issues: string[]): ValidationResult {
  return { ok: false, issues };
}

export function validatePlatformEvent(value: unknown): ValidationResult {
  if (!Value.Check(PlatformEventEnvelopeSchema, value)) {
    return invalid("事件 Envelope 结构无效");
  }

  const event = value as PlatformEventEnvelope;
  if (!eventTypeSet.has(event.type)) {
    return invalid(`未知事件类型: ${event.type}`);
  }
  if (Number.isNaN(Date.parse(event.timestamp))) {
    return invalid("事件 timestamp 无效");
  }
  if (event.type !== "health.changed" && (event.sessionId === null || event.streamId === null)) {
    return invalid("Session 事件必须包含 sessionId 和 streamId");
  }
  if (event.type === "message.delta") {
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.role !== "string" || typeof payload.delta !== "string") {
      return invalid("message.delta payload 无效");
    }
  }
  return { ok: true, issues: [] };
}

export function validateClientCommand(value: unknown): ValidationResult {
  return Value.Check(ClientCommandSchema, value) ? { ok: true, issues: [] } : invalid("命令结构无效");
}

export class EventSequenceGuard {
  private readonly lastSequence = new Map<string, number>();

  accept(event: PlatformEventEnvelope): boolean {
    if (!validatePlatformEvent(event).ok || event.streamId === null) {
      return false;
    }

    const previous = this.lastSequence.get(event.streamId);
    if (previous !== undefined && event.sequence !== previous + 1) {
      return false;
    }
    if (previous === undefined && event.sequence !== 1) {
      return false;
    }

    this.lastSequence.set(event.streamId, event.sequence);
    return true;
  }

  reset(streamId: string): void {
    this.lastSequence.delete(streamId);
  }
}

export function isClientCommand(value: unknown): value is ClientCommand {
  return validateClientCommand(value).ok;
}
