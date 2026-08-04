import type { EventCatalogEntry } from "../../contracts/observability.js";
import { ActivityPayloadSchema, AuditPayloadSchema } from "../../contracts/observability.js";

// ═══════════════════════════════════════════════════════════════
// 事件目录共享辅助（event-catalog.ts 与 catalog/*-events.ts 共用）
// ═══════════════════════════════════════════════════════════════

export const routine = { significance: "routine", producerPolicy: "platform-only" } as const;
export const notable = { significance: "notable", producerPolicy: "platform-only" } as const;

export function entry(
  input: Omit<EventCatalogEntry, "producerPolicy" | "securitySummary" | "payloadSchema"> & {
    producerPolicy?: EventCatalogEntry["producerPolicy"];
    securitySummary?: EventCatalogEntry["securitySummary"];
    payloadSchema?: EventCatalogEntry["payloadSchema"];
  },
): EventCatalogEntry {
  return {
    producerPolicy: "platform-only",
    securitySummary: "exclude",
    payloadSchema: input.channel === "audit" ? AuditPayloadSchema : ActivityPayloadSchema,
    ...input,
  };
}
