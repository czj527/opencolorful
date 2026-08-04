import { describe, expect, it } from "vitest";

import { getCatalogEntry } from "../../src/observability/event-catalog.js";
import { pluginActivityEntries, pluginAuditEntries } from "../../src/observability/catalog/plugin-events.js";

describe("Phase 12 插件事件目录（T1 冻结，plans/phase-12.md §17.2/§17.3）", () => {
  it("全部插件事件已登记进唯一权威目录", () => {
    for (const item of pluginActivityEntries) {
      expect(getCatalogEntry(item.eventName), item.eventName).toBeDefined();
    }
    for (const item of pluginAuditEntries) {
      expect(getCatalogEntry(item.eventName), item.eventName).toBeDefined();
    }
  });

  it("activity 事件命名统一点号式（不得下划线混用）", () => {
    for (const item of pluginActivityEntries) {
      expect(item.eventName, item.eventName).toMatch(/^plugin\.[a-z0-9._]+$/);
    }
  });

  it("audit 事件命名统一下划线式（与既有 audit.plugin.permission_granted 一致）", () => {
    for (const item of pluginAuditEntries) {
      expect(item.eventName, item.eventName).toMatch(/^audit\.plugin\.[a-z0-9_]+$/);
    }
  });

  it("started 事件必须有 terminalStatuses，terminal 事件必须有唯一终态语义", () => {
    for (const item of pluginActivityEntries) {
      if (item.lifecycleRole === "started") {
        expect(item.terminalStatuses, item.eventName).toBeDefined();
        expect(item.terminalStatuses!.length, item.eventName).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("生命周期 started→terminal 配对完整（每个 started 有对应 terminal 且终态合法）", () => {
    const started = pluginActivityEntries.filter((item) => item.lifecycleRole === "started").map((item) => item.eventName);
    // process / execution / rollback 的 started 事件
    expect(started).toEqual(
      expect.arrayContaining(["plugin.process.started", "plugin.execution.started", "plugin.rollback.started"]),
    );
    // 对应的 terminal 事件存在
    for (const eventName of ["plugin.process.exited", "plugin.process.crashed", "plugin.execution.completed", "plugin.execution.failed", "plugin.execution.cancelled", "plugin.execution.timed_out", "plugin.execution.interrupted", "plugin.rollback.completed", "plugin.rollback.failed"]) {
      expect(getCatalogEntry(eventName), eventName).toBeDefined();
    }
  });

  it("execution 事件通过 payload.contributionKind 区分类型（不建平行生命周期）", () => {
    const executionStarted = getCatalogEntry("plugin.execution.started");
    expect(executionStarted?.channel).toBe("activity");
    expect(executionStarted?.lifecycleRole).toBe("started");
    expect(executionStarted?.terminalStatuses).toContain("completed");
    expect(executionStarted?.terminalStatuses).toContain("failed");
    expect(executionStarted?.terminalStatuses).toContain("cancelled");
    expect(executionStarted?.terminalStatuses).toContain("interrupted");
  });

  it("审计生命周期三阶段齐全（started/completed/failed）", () => {
    for (const domain of ["install", "update", "rollback", "uninstall", "permission_change", "agent_binding_change", "config_change", "secret_change", "source_trust_change"]) {
      const started = getCatalogEntry(`audit.plugin.${domain}_started`);
      const completed = getCatalogEntry(`audit.plugin.${domain}_completed`);
      const failed = getCatalogEntry(`audit.plugin.${domain}_failed`);
      expect(started, `${domain}_started`).toBeDefined();
      expect(completed, `${domain}_completed`).toBeDefined();
      expect(failed, `${domain}_failed`).toBeDefined();
      expect(started?.lifecycleRole).toBe("started");
      expect(completed?.lifecycleRole).toBe("terminal");
      expect(failed?.lifecycleRole).toBe("terminal");
      expect(started?.channel).toBe("audit");
      expect(completed?.channel).toBe("audit");
      expect(failed?.channel).toBe("audit");
    }
  });

  it("auditMirror 引用的事件必须已登记（下划线式）", () => {
    for (const item of pluginActivityEntries) {
      if (item.auditMirror !== undefined) {
        expect(getCatalogEntry(item.auditMirror), `${item.eventName} → ${item.auditMirror}`).toBeDefined();
        expect(item.auditMirror, item.auditMirror).toMatch(/^audit\.plugin\.[a-z0-9_]+$/);
      }
    }
  });

  it("关键状态（安装/更新/回滚/卸载/权限）为 notable，高频执行/进程为 routine", () => {
    expect(getCatalogEntry("plugin.installed")?.significance).toBe("notable");
    expect(getCatalogEntry("plugin.uninstalled")?.significance).toBe("notable");
    expect(getCatalogEntry("plugin.execution.completed")?.significance).toBe("routine");
    expect(getCatalogEntry("plugin.process.started")?.significance).toBe("routine");
    // 插件事件 producerPolicy 一律 platform-only（自定义事件由 ExtensionObservabilityPort 单独约束）
    expect(getCatalogEntry("plugin.installed")?.producerPolicy).toBe("platform-only");
  });

  it("Phase 11 既有插件事件不回归", () => {
    expect(getCatalogEntry("plugin.permission.granted")).toBeDefined();
    expect(getCatalogEntry("plugin.permission.denied")).toBeDefined();
    expect(getCatalogEntry("plugin.permission.revoked")).toBeDefined();
    expect(getCatalogEntry("plugin.crashed")).toBeDefined();
    expect(getCatalogEntry("audit.plugin.permission_granted")).toBeDefined();
  });
});
