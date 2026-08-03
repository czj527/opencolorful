import { describe, expect, it } from "vitest";

import Value from "typebox/value";
import {
  ActivityEnvelopeSchema,
  AuditEnvelopeSchema,
  DiagnosticEnvelopeSchema,
  ObservabilityEventEnvelopeSchema,
  ObservabilityEventEnvelope,
} from "../../src/contracts/observability.js";
import { ObservabilityEventCatalog, getCatalogEntry } from "../../src/observability/event-catalog.js";

// Phase 11 T1：契约判别联合正反例 + 事件目录完整性（plans/phase-11.md §3/§6）

const base = {
  schemaVersion: 1,
  eventVersion: 1,
  eventId: "evt-0001",
  eventName: "turn.started",
  occurredAt: "2026-08-01T12:00:00.000Z",
  recordedAt: "2026-08-01T12:00:00.001Z",
  level: "info",
  actor: { kind: "user", id: "u1" },
  executor: { kind: "service", id: "server" },
  target: { kind: "session", id: "s1" },
  scope: { ownerAgentId: "a1", sessionId: "s1" },
  trace: { traceId: "t1", spanId: "s1" },
  producer: { component: "test", processType: "server", processId: "1", bootId: "b1", appVersion: "0.1.0", hostPlatform: "win32" },
};

function activityEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...base,
    channel: "activity",
    payload: { summaryCode: "turn_started" },
    ...overrides,
  };
}

describe("Observability Envelope 契约", () => {
  it("合法 activity / audit / diagnostic Envelope 通过判别校验", () => {
    expect(Value.Check(ObservabilityEventEnvelopeSchema, activityEnvelope())).toBe(true);
    expect(Value.Check(ObservabilityEventEnvelopeSchema, {
      ...base, channel: "audit", eventName: "audit.memory.strength_changed",
      payload: { action: "memory.strength_change", decision: "allowed" },
    })).toBe(true);
    expect(Value.Check(ObservabilityEventEnvelopeSchema, {
      ...base, channel: "diagnostic", eventName: "test.event",
      payload: { message: "调试信息" },
    })).toBe(true);
  });

  it("channel 与 payload 不可错配（activity 不能带 audit payload，反之亦然）", () => {
    const auditPayloadOnActivity = activityEnvelope({
      payload: { action: "x", decision: "allowed" },
    });
    expect(Value.Check(ActivityEnvelopeSchema, auditPayloadOnActivity)).toBe(false);
    expect(Value.Check(ObservabilityEventEnvelopeSchema, auditPayloadOnActivity)).toBe(false);

    const activityPayloadOnAudit = {
      ...base, channel: "audit", payload: { summaryCode: "x" },
    };
    expect(Value.Check(AuditEnvelopeSchema, activityPayloadOnAudit)).toBe(false);
    expect(Value.Check(ObservabilityEventEnvelopeSchema, activityPayloadOnAudit)).toBe(false);
  });

  it("平台权威字段不可缺省或伪造：trace/producer/actor 缺一即拒绝", () => {
    const withoutTrace = activityEnvelope();
    delete (withoutTrace as Record<string, unknown>)["trace"];
    expect(Value.Check(ObservabilityEventEnvelopeSchema, withoutTrace)).toBe(false);

    const withoutProducer = activityEnvelope();
    delete (withoutProducer as Record<string, unknown>)["producer"];
    expect(Value.Check(ObservabilityEventEnvelopeSchema, withoutProducer)).toBe(false);

    // 未知 actor kind / 非法 status / 非法 significance 拒绝
    expect(Value.Check(ObservabilityEventEnvelopeSchema, activityEnvelope({
      actor: { kind: "hacker", id: "x" },
    }))).toBe(false);
    expect(Value.Check(ObservabilityEventEnvelopeSchema, activityEnvelope({
      status: "exploded",
    }))).toBe(false);
    expect(Value.Check(ObservabilityEventEnvelopeSchema, activityEnvelope({
      significance: "epic",
    }))).toBe(false);
  });

  it("payload 限额：超长 summaryCode / 额外字段拒绝", () => {
    expect(Value.Check(ObservabilityEventEnvelopeSchema, activityEnvelope({
      payload: { summaryCode: "x".repeat(200) },
    }))).toBe(false);
    expect(Value.Check(ObservabilityEventEnvelopeSchema, activityEnvelope({
      payload: { summaryCode: "ok", smuggled: "must not pass" },
    }))).toBe(false);
  });
});

describe("ObservabilityEventCatalog 完整性", () => {
  it("目录条目无重复 eventName；auditMirror 与 audit-only 事件一一对应", () => {
    const names = new Set<string>();
    for (const [name] of ObservabilityEventCatalog) {
      expect(names.has(name), `重复事件 ${name}`).toBe(false);
      names.add(name);
    }

    // 每个 activity 条目的 auditMirror 必须指向目录中存在的 audit 事件
    for (const item of ObservabilityEventCatalog.values()) {
      if (item.auditMirror !== undefined) {
        const mirror = getCatalogEntry(item.auditMirror);
        expect(mirror, `${item.eventName} 的 auditMirror ${item.auditMirror} 不存在`).toBeDefined();
        expect(mirror?.channel).toBe("audit");
      }
    }
  });

  it("milestone 仅允许平台内置事件（agent.created/deleted、audit ledger reset）", () => {
    for (const item of ObservabilityEventCatalog.values()) {
      if (item.significance === "milestone") {
        expect(
          ["agent.created", "agent.deleted", "observability.audit.ledger_reset",
           "audit.agent.deleted", "audit.observability.ledger_reset"].includes(item.eventName),
          `${item.eventName} 不应为 milestone`,
        ).toBe(true);
      }
    }
  });

  it("扩展允许事件默认 routine 且不带 auditMirror（§6.5）", () => {
    for (const item of ObservabilityEventCatalog.values()) {
      if (item.producerPolicy === "extension-allowed") {
        expect(item.significance).toBe("routine");
        expect(item.auditMirror).toBeUndefined();
      }
    }
  });

  it("目录覆盖计划 §6.2 关键事件清单", () => {
    const required = [
      "turn.started", "turn.completed", "turn.failed",
      "model.call.started", "model.call.completed", "model.call.failed",
      "tool.call.started", "tool.call.completed", "tool.call.denied",
      "memory.recall.started", "memory.recall.completed", "memory.recall.empty",
      "memory.proposal.approved", "memory.proposal.rejected",
      "memory.strength.changed", "memory.fact.forgotten",
      "sandbox.path.denied", "sandbox.command.denied",
      "system.crashed", "storage.migration.failed",
      "audit.memory.strength_changed", "audit.observability.ledger_reset",
    ];
    for (const name of required) {
      expect(getCatalogEntry(name), `目录缺少 ${name}`).toBeDefined();
    }
  });

  it("未注册事件与错误版本拒绝", () => {
    expect(getCatalogEntry("totally.unknown.event")).toBeUndefined();
    expect(getCatalogEntry("turn.started", 99)).toBeUndefined();
  });
});
