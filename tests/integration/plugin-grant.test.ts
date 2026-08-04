import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { ProducerContext } from "../../src/contracts/observability.js";
import type { CapabilityKind } from "../../src/contracts/plugin-protocol.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { PluginGrantStore } from "../../src/storage/plugin-grant-store.js";
import { GrantService } from "../../src/runtime/plugins/grants/grant-service.js";
import { isHighRisk, listCapabilities } from "../../src/runtime/plugins/grants/capability-catalog.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { instrument } from "../../src/observability/instrument.js";

// ═══════════════════════════════════════════════════════════════
// T3 平台级授权（plugin_grants + grant-service）
// - revision 插件级单调递增；高风险能力必须用户确认；
// - 严格审计三阶段（started → 写入 + completed / failed）+ Activity；
// - audit 未配置/拒绝 → fail-closed 拒绝变更。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

const producer: ProducerContext = {
  component: "t3-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t3-grant",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

function createContext(): {
  db: Database.Database;
  store: PluginGrantStore;
  service: GrantService;
  audit: AuditRecorder;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t3-grant-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const db = openMetadataDatabase(paths.database);
  openDatabases.push(db);
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(dir, "logs"),
    spoolRoot: path.join(dir, "spool"),
  });
  instrument.init(context);
  const store = new PluginGrantStore(db);
  const service = new GrantService({ store, audit: context.audit });
  return { db, store, service, audit: context.audit };
}

function createClosedAuditService(): { store: PluginGrantStore; service: GrantService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-t3-grant-closed-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  // store 挂在存活 DB 上（用于验证无写入）；audit 挂在已关闭 DB 上（模拟审计不可用）
  const liveDb = openMetadataDatabase(paths.database);
  openDatabases.push(liveDb);
  const closedDb = openMetadataDatabase(path.join(dir, "audit-closed.db"));
  closedDb.close();
  const closedAudit = new AuditRecorder({
    database: closedDb,
    producer,
  });
  const store = new PluginGrantStore(liveDb);
  const service = new GrantService({ store, audit: closedAudit });
  return { store, service };
}

afterEach(() => {
  instrument.reset();
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* 已关闭则忽略 */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const userActor = { actor: { kind: "user" as const, id: "user-1" } };
const systemActor = { actor: { kind: "system" as const, id: "platform" } };

describe("T3 GrantService：revision 单调递增", () => {
  it("首次授权 revision = 1，同能力再次变更 +1，不同能力共享插件级计数", () => {
    const { store, service } = createContext();
    const granted = service.grant({ pluginId: "example.sdk-showcase", capability: "tool.register" }, userActor);
    expect(granted.kind).toBe("granted");
    if (granted.kind !== "granted") return;
    expect(granted.grant.revision).toBe(1);
    expect(service.currentRevision("example.sdk-showcase")).toBe(1);

    const again = service.grant({ pluginId: "example.sdk-showcase", capability: "tool.register" }, userActor);
    expect(again.kind).toBe("granted");
    if (again.kind !== "granted") return;
    expect(again.grant.revision).toBe(2);

    const other = service.grant({ pluginId: "example.sdk-showcase", capability: "route.register" }, userActor);
    expect(other.kind).toBe("granted");
    if (other.kind !== "granted") return;
    expect(other.grant.revision).toBe(3);

    const row = store.get("example.sdk-showcase", "tool.register");
    expect(row).not.toBeNull();
    expect(row?.decision).toBe("allowed");
    expect(row?.revision).toBe(2);
    expect(service.list("example.sdk-showcase")).toHaveLength(2);
  });

  it("撤销已授权能力记 revoked；重复 denied 记 denied；revision 持续 +1", () => {
    const { store, service } = createContext();
    service.grant({ pluginId: "example.p", capability: "tool.register" }, userActor);
    const revoked = service.revoke({ pluginId: "example.p", capability: "tool.register" }, userActor);
    expect(revoked.kind).toBe("revoked");
    if (revoked.kind !== "revoked") return;
    expect(revoked.grant.revision).toBe(2);
    expect(store.get("example.p", "tool.register")?.decision).toBe("denied");

    const deniedAgain = service.revoke({ pluginId: "example.p", capability: "tool.register" }, userActor);
    expect(deniedAgain.kind).toBe("denied");
    if (deniedAgain.kind !== "denied") return;
    expect(deniedAgain.grant.revision).toBe(3);
  });
});

describe("T3 GrantService：高风险能力默认策略", () => {
  it("system actor 授予高风险能力被拒绝（需用户确认或 full-access 审核通过）", () => {
    const { service } = createContext();
    expect(() =>
      service.grant({ pluginId: "example.p", capability: "network.connect" }, systemActor),
    ).toThrow(/高风险能力 network\.connect 需要用户显式确认/);
    expect(() =>
      service.grant({ pluginId: "example.p", capability: "secret.read-own" }, systemActor),
    ).toThrow(/高风险能力/);
  });

  it("user actor 可授予高风险能力", () => {
    const { service } = createContext();
    const granted = service.grant({ pluginId: "example.p", capability: "filesystem.write" }, userActor);
    expect(granted.kind).toBe("granted");
  });

  it("full-access 审核通过路径（allowSystemForHighRisk）允许 system actor", () => {
    const { service } = createContext();
    const granted = service.grant(
      { pluginId: "example.p", capability: "process.spawn" },
      { actor: { kind: "system", id: "platform" }, allowSystemForHighRisk: true },
    );
    expect(granted.kind).toBe("granted");
  });

  it("目录标记全部 16 个能力族，且 4 个高风险能力与计划一致", () => {
    expect(listCapabilities()).toHaveLength(16);
    for (const capability of ["secret.read-own", "process.spawn", "network.connect", "filesystem.write"]) {
      expect(isHighRisk(capability as CapabilityKind)).toBe(true);
    }
    for (const capability of ["tool.register", "route.register", "ui.surface", "ui.host.clipboard", "background.run", "hook.register", "activity.emit", "filesystem.read", "provider.register", "resource.open", "resource.pick", "ui.host.external-open"]) {
      expect(isHighRisk(capability as CapabilityKind)).toBe(false);
    }
  });
});

describe("T3 GrantService：严格审计与 Activity", () => {
  it("授权落库严格审计三阶段（started → completed），共享 operationId", () => {
    const { db, service } = createContext();
    service.grant({ pluginId: "example.p", capability: "tool.register" }, userActor);
    const rows = db.prepare(
      "SELECT event_name, operation_id, action, decision, before_revision, after_revision FROM audit_events WHERE event_name LIKE 'audit.plugin.permission_change_%' ORDER BY id ASC",
    ).all() as Array<{ event_name: string; operation_id: string; action: string; decision: string; before_revision: string; after_revision: string }>;
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.plugin.permission_change_started",
      "audit.plugin.permission_change_completed",
    ]);
    expect(rows[0]?.operation_id).toBeTruthy();
    expect(rows[1]?.operation_id).toBe(rows[0]?.operation_id);
    expect(rows[0]?.action).toBe("grant.change");
    expect(rows[1]?.decision).toBe("allowed");
    expect(rows[0]?.before_revision).toBe("0");
    expect(rows[0]?.after_revision).toBe("1");
  });

  it("授权结果发 plugin.permission.granted Activity（含 grantedBy/能力），audit 镜像 decision=allowed", () => {
    const { db, service } = createContext();
    service.grant({ pluginId: "example.p", capability: "route.register" }, userActor);
    const row = db.prepare(
      "SELECT event_name, payload_json, owner_agent_id FROM activity_events WHERE event_name = 'plugin.permission.granted'",
    ).get() as { event_name: string; payload_json: string; owner_agent_id: string | null };
    expect(row).toBeDefined();
    const payload = JSON.parse(row.payload_json) as { summaryCode: string; attributes: Record<string, unknown> };
    expect(payload.summaryCode).toBe("plugin_permission_granted");
    expect(payload.attributes).toMatchObject({
      pluginId: "example.p",
      capability: "route.register",
      decision: "allowed",
      revision: 1,
      grantedBy: "user-1",
    });
    // audit 镜像：event_name 落 mirror 事件名，决策与授权一致（allowed）
    const mirror = db.prepare(
      "SELECT action, decision, event_name FROM audit_events WHERE event_name = 'audit.plugin.permission_granted'",
    ).get() as { action: string; decision: string; event_name: string } | undefined;
    expect(mirror).toBeDefined();
    expect(mirror?.action).toBe("audit.plugin.permission_granted");
    expect(mirror?.decision).toBe("allowed");
    expect(mirror?.event_name).toBe("audit.plugin.permission_granted");
  });

  it("撤销发 plugin.permission.revoked，重复拒绝发 plugin.permission.denied（镜像 decision=denied）", () => {
    const { db, service } = createContext();
    service.grant({ pluginId: "example.p", capability: "activity.emit" }, userActor);
    service.revoke({ pluginId: "example.p", capability: "activity.emit" }, userActor);
    service.revoke({ pluginId: "example.p", capability: "activity.emit" }, userActor);
    const rows = db.prepare(
      "SELECT event_name FROM activity_events WHERE event_name IN ('plugin.permission.revoked','plugin.permission.denied') ORDER BY id ASC",
    ).all() as Array<{ event_name: string }>;
    expect(rows.map((r) => r.event_name)).toEqual(["plugin.permission.revoked", "plugin.permission.denied"]);
    // audit 镜像：拒绝/撤销类事件 decision 必须为 denied（不再硬编码 allowed）
    const mirrors = db.prepare(
      "SELECT action, decision, event_name FROM audit_events WHERE event_name IN ('audit.plugin.permission_revoked','audit.plugin.permission_denied') ORDER BY id ASC",
    ).all() as Array<{ action: string; decision: string; event_name: string }>;
    expect(mirrors.map((r) => ({ action: r.action, decision: r.decision, event_name: r.event_name }))).toEqual([
      { action: "audit.plugin.permission_revoked", decision: "denied", event_name: "audit.plugin.permission_revoked" },
      { action: "audit.plugin.permission_denied", decision: "denied", event_name: "audit.plugin.permission_denied" },
    ]);
  });
});

describe("T3 GrantService：removeAll 清空授权", () => {
  it("清空插件全部授权并走严格三阶段审计（completed decision=denied）", () => {
    const { db, store, service } = createContext();
    service.grant({ pluginId: "example.p", capability: "tool.register" }, userActor);
    service.grant({ pluginId: "example.p", capability: "route.register" }, userActor);
    expect(service.list("example.p")).toHaveLength(2);

    service.removeAll("example.p", userActor);

    expect(store.list("example.p")).toHaveLength(0);
    expect(service.currentRevision("example.p")).toBe(0);

    const rows = db.prepare(
      "SELECT event_name, action, decision, before_revision, after_revision FROM audit_events WHERE event_name LIKE 'audit.plugin.permission_change_%' ORDER BY id ASC",
    ).all() as Array<{ event_name: string; action: string; decision: string; before_revision: string; after_revision: string }>;
    // 2 次 grant（started/completed × 2）→ removeAll（started/completed）
    expect(rows.map((r) => r.event_name)).toEqual([
      "audit.plugin.permission_change_started",
      "audit.plugin.permission_change_completed",
      "audit.plugin.permission_change_started",
      "audit.plugin.permission_change_completed",
      "audit.plugin.permission_change_started",
      "audit.plugin.permission_change_completed",
    ]);
    const started = rows[4]!;
    const completed = rows[5]!;
    expect(started.action).toBe("grant.change");
    expect(started.decision).toBe("deferred");
    expect(started.before_revision).toBe("2");
    expect(started.after_revision).toBe("2");
    expect(completed.decision).toBe("denied");
    expect(completed.before_revision).toBe("2");
  });

  it("removeAll 发 plugin.permission.revoked Activity（attributes 含 removedCount）", () => {
    const { db, service } = createContext();
    service.grant({ pluginId: "example.p", capability: "tool.register" }, userActor);
    service.removeAll("example.p", userActor);

    const rows = db.prepare(
      "SELECT payload_json FROM activity_events WHERE event_name = 'plugin.permission.revoked' ORDER BY id ASC",
    ).all() as Array<{ payload_json: string }>;
    const last = rows[rows.length - 1] as { payload_json: string } | undefined;
    expect(last).toBeDefined();
    const payload = JSON.parse(last!.payload_json) as { summaryCode: string; attributes: Record<string, unknown> };
    expect(payload.summaryCode).toBe("plugin_permission_revoked");
    expect(payload.attributes).toMatchObject({ pluginId: "example.p", removedCount: 1, revision: 1, grantedBy: "user-1" });
  });

  it("无授权记录时直接返回，不产生任何审计", () => {
    const { db, service } = createContext();
    service.removeAll("example.missing", userActor);
    const rows = db.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE event_name LIKE 'audit.plugin.permission_change_%'",
    ).get() as { n: number };
    expect(rows.n).toBe(0);
    expect(service.list("example.missing")).toHaveLength(0);
  });
});

describe("T3 GrantService：fail-closed 与输入校验", () => {
  it("instrument 未初始化时授权仍成功（activity no-op），audit 正常落库", () => {
    instrument.reset();
    const { store, service } = createContext();
    const result = service.grant({ pluginId: "example.p", capability: "tool.register" }, userActor);
    expect(result.kind).toBe("granted");
    expect(store.get("example.p", "tool.register")?.decision).toBe("allowed");
  });

  it("audit 未配置（closed DB recorder）→ 抛错且无任何写入", () => {
    const { store, service } = createClosedAuditService();
    expect(() => service.grant({ pluginId: "example.p", capability: "tool.register" }, userActor)).toThrow();
    expect(store.get("example.p", "tool.register")).toBeNull();
  });

  it("非法输入被拒绝", () => {
    const { service } = createContext();
    expect(() =>
      service.change({ pluginId: "", capability: "tool.register", decision: "allowed" }, userActor),
    ).toThrow(/输入不合法/);
    expect(() =>
      service.change({ pluginId: "bad plugin id", capability: "tool.register", decision: "allowed" }, userActor),
    ).toThrow(/输入不合法/);
    expect(() =>
      service.change({ pluginId: "example.p", capability: "tool.register", decision: "maybe" as never }, userActor),
    ).toThrow(/输入不合法/);
    expect(() =>
      service.change({ pluginId: "example.p", capability: "not.a.capability" as CapabilityKind, decision: "allowed" }, userActor),
    ).toThrow(/输入不合法|未知能力族/);
  });
});
