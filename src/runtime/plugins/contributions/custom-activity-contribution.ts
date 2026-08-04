import Value from "typebox/value";

import type { ExtensionActivityInput, ExtensionObservabilityPort } from "../../../observability/extension-port.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Custom Activity Contribution（plans/phase-12.md §8.9 / §17.2）
//
// - 插件自定义事件只能使用注册 namespace：plugin.<pluginId>.<domain>.<action>；
// - Manifest 声明事件 namespace 与 payload Schema；自定义事件默认只能是
//   routine Activity，不能生成 Audit、notable 或 milestone——本服务 API
//   不暴露 significance/audit 参数，且 payload 中携带平台权威字段
//   （actor/executor/scope/trace/producer/eventId/recordedAt/significance/
//   audit 等）一律拒绝；
// - 经 ExtensionObservabilityPort（Phase 11 T8 冻结端口）发出：平台重新
//   盖章 actor/executor/scope/trace/eventId，扩展不能自报。
// ═══════════════════════════════════════════════════════════════

export const CUSTOM_EVENT_MAX_PAYLOAD_BYTES = 8 * 1024;

const ACTION_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;

/** 平台权威字段：插件 payload 中出现即拒绝（不能自报/升级）。 */
const FORBIDDEN_AUTHORITY_KEYS: readonly string[] = [
  "eventId",
  "eventName",
  "recordedAt",
  "occurredAt",
  "actor",
  "executor",
  "scope",
  "trace",
  "traceId",
  "spanId",
  "producer",
  "significance",
  "audit",
  "channel",
  "level",
  "operationId",
];

export interface CustomActivityDescriptor {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly eventNamespace: string;
  readonly payloadSchema?: unknown;
}

export type CustomActivityResult =
  | { readonly ok: true; readonly eventId?: string }
  | { readonly ok: false; readonly code: "unknown-event" | "invalid-namespace" | "invalid-action" | "invalid-payload" | "too-large" | "forged-fields" | "rejected"; readonly reason: string };

export interface CustomActivityServiceDeps {
  readonly registry: ContributionRegistry;
  /** 按插件创建受限可观测性端口（平台盖章 + 速率限制 + 拒绝 Audit）。 */
  readonly portFactory: (pluginId: string) => ExtensionObservabilityPort;
}

export class CustomActivityService {
  constructor(private readonly deps: CustomActivityServiceDeps) {}

  listEvents(pluginId: string): CustomActivityDescriptor[] {
    return this.deps.registry
      .listByKind(pluginId, "custom-activity")
      .map((contribution) => this.toDescriptor(contribution))
      .filter((descriptor): descriptor is CustomActivityDescriptor => descriptor !== undefined);
  }

  /** 发出自定义 Activity：namespace 校验 → payload 校验 → 受限端口。 */
  emit(input: {
    readonly pluginId: string;
    readonly eventNamespace: string;
    readonly action: string;
    readonly payload?: Record<string, unknown>;
    readonly carrier?: ExtensionActivityInput["carrier"];
  }): CustomActivityResult {
    const contribution = this.findContribution(input.pluginId, input.eventNamespace);
    if (contribution === undefined) {
      return { ok: false, code: "unknown-event", reason: "事件 namespace 未登记" };
    }
    if (typeof input.action !== "string" || !ACTION_PATTERN.test(input.action)) {
      return { ok: false, code: "invalid-action", reason: "action 必须匹配 plugin.<pluginId>.<domain>.<action> 结尾段" };
    }
    const payload = input.payload ?? {};
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { ok: false, code: "invalid-payload", reason: "payload 必须是 JSON 对象" };
    }
    if (this.containsForbiddenKeys(payload)) {
      return { ok: false, code: "forged-fields", reason: "payload 包含平台权威字段，拒绝" };
    }
    if (payloadBytes(payload) > CUSTOM_EVENT_MAX_PAYLOAD_BYTES) {
      return { ok: false, code: "too-large", reason: `payload 超过大小限制（${CUSTOM_EVENT_MAX_PAYLOAD_BYTES} 字节）` };
    }
    const payloadSchema = contribution.spec["payloadSchema"];
    if (isSchemaObject(payloadSchema)) {
      if (!Value.Check(payloadSchema, payload)) {
        return { ok: false, code: "invalid-payload", reason: "payload 不符合声明 Schema" };
      }
    }

    const eventName = `${input.eventNamespace}.${input.action}`;
    const port = this.deps.portFactory(input.pluginId);
    const result = port.activity({
      eventName,
      summaryCode: eventName,
      attributes: payload,
      ...(input.carrier !== undefined ? { carrier: input.carrier } : {}),
    });
    if (result.kind === "accepted") {
      return { ok: true, ...(result.eventId.length > 0 ? { eventId: result.eventId } : {}) };
    }
    return { ok: false, code: "rejected", reason: result.reason };
  }

  // ── private helpers ───────────────────────────────────────────

  private findContribution(pluginId: string, eventNamespace: string): RegisteredContribution | undefined {
    return this.deps.registry
      .listByKind(pluginId, "custom-activity")
      .find((contribution) => contribution.spec["eventNamespace"] === eventNamespace);
  }

  private containsForbiddenKeys(payload: Record<string, unknown>): boolean {
    return Object.keys(payload).some((key) => (FORBIDDEN_AUTHORITY_KEYS as readonly string[]).includes(key));
  }

  private toDescriptor(contribution: RegisteredContribution): CustomActivityDescriptor | undefined {
    if (contribution.kind !== "custom-activity") {
      return undefined;
    }
    const eventNamespace = contribution.spec["eventNamespace"];
    if (typeof eventNamespace !== "string" || eventNamespace.length === 0) {
      return undefined;
    }
    const descriptor: CustomActivityDescriptor = {
      pluginId: contribution.pluginId,
      contributionId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
      eventNamespace,
    };
    const payloadSchema = contribution.spec["payloadSchema"];
    return isSchemaObject(payloadSchema) ? { ...descriptor, payloadSchema } : descriptor;
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadBytes(payload: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
