import { describe, expect, it } from "vitest";

import { CarrierRegistry } from "../../src/runtime/plugins/runtimes/carrier-registry.js";
import type { PluginIpcCarrier } from "../../src/contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// T4 一次性 IPC token（plans/phase-12.md §9.2 / §17.4）
// - 绑定 pluginId + runtimeInstanceId + operationId，单次消费；
// - 重复、跨实例、跨操作、过期、伪造 carrier 一律拒绝。
// ═══════════════════════════════════════════════════════════════

function makeRegistry(overrides: { ttlMs?: number; now?: () => Date } = {}): CarrierRegistry {
  return new CarrierRegistry({
    ...(overrides.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    tokenFactory: () => "token-".padEnd(40, "a"),
  });
}

describe("CarrierRegistry 一次性 IPC token", () => {
  it("签发合法 carrier：绑定三要素 + 默认 TTL 30s", () => {
    const registry = makeRegistry();
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
    });
    expect(carrier.pluginId).toBe("example.plugin");
    expect(carrier.token.length).toBeGreaterThanOrEqual(16);
    const issued = new Date(carrier.issuedAt).getTime();
    const expires = new Date(carrier.expiresAt).getTime();
    expect(expires - issued).toBe(30_000);
    expect(registry.size()).toBe(1);
  });

  it("单次消费成功，重复消费被拒", () => {
    const registry = makeRegistry();
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
    });
    const first = registry.consume(carrier);
    expect(first).toEqual({ ok: true });
    const second = registry.consume(carrier);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("already-consumed");
    }
  });

  it("跨实例复用 token 被拒", () => {
    const registry = makeRegistry();
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
    });
    const forged: PluginIpcCarrier = {
      ...carrier,
      runtimeInstanceId: "runtime-example.plugin-OTHER",
    };
    const result = registry.consume(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("mismatch");
    }
    // 原 token 未被消费，仍可正常消费
    expect(registry.consume(carrier)).toEqual({ ok: true });
  });

  it("跨插件 / 跨操作复用 token 被拒", () => {
    const registry = makeRegistry();
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
    });
    const crossPlugin: PluginIpcCarrier = { ...carrier, pluginId: "other.plugin" };
    expect(registry.consume(crossPlugin).ok).toBe(false);
    const crossOp: PluginIpcCarrier = { ...carrier, operationId: "exec-op-2" };
    expect(registry.consume(crossOp).ok).toBe(false);
  });

  it("过期 token 被拒，且不占用单次消费", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const registry = makeRegistry({ now: () => now });
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
    });
    now = new Date("2026-01-01T00:00:31Z"); // TTL 30s 已过
    const result = registry.consume(carrier);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("expired");
    }
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.size()).toBe(0);
  });

  it("未签发/伪造 token 被拒", () => {
    const registry = makeRegistry();
    const fake: PluginIpcCarrier = {
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
      token: "forged-token-xxxxxxxxxxxxxxxx",
      traceId: "t",
      spanId: "s",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const result = registry.consume(fake);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown-token");
    }
  });

  it("不符合协议 schema 的 carrier 被拒（invalid-schema）", () => {
    const registry = makeRegistry();
    expect(registry.consume(null).ok).toBe(false);
    expect(registry.consume({ token: "short" }).ok).toBe(false);
    expect(registry.consume("not-an-object").ok).toBe(false);
  });

  it("validate 为非消费性校验：validate 不改变单次消费语义", () => {
    const registry = makeRegistry();
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
    });
    expect(registry.validate(carrier)).toEqual({ ok: true });
    expect(registry.consume(carrier)).toEqual({ ok: true });
    expect(registry.validate(carrier).ok).toBe(false);
    expect(registry.consume(carrier).ok).toBe(false);
  });

  it("revokeOperation 幂等回收，后续消费被拒", () => {
    const registry = makeRegistry();
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
    });
    registry.revokeOperation("example.plugin", "runtime-example.plugin-1", "exec-op-1");
    expect(registry.size()).toBe(0);
    expect(registry.consume(carrier).ok).toBe(false);
    // 幂等：重复回收不抛错
    registry.revokeOperation("example.plugin", "runtime-example.plugin-1", "exec-op-1");
  });

  it("可签发自定义 TTL 与 traceId/spanId", () => {
    const registry = makeRegistry();
    const carrier = registry.issue({
      pluginId: "example.plugin",
      runtimeInstanceId: "runtime-example.plugin-1",
      operationId: "exec-op-1",
      ttlMs: 5_000,
      traceId: "trace-abc",
      spanId: "span-def",
    });
    expect(carrier.traceId).toBe("trace-abc");
    expect(carrier.spanId).toBe("span-def");
    const issued = new Date(carrier.issuedAt).getTime();
    const expires = new Date(carrier.expiresAt).getTime();
    expect(expires - issued).toBe(5_000);
  });
});
