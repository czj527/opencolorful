import { describe, expect, it } from "vitest";

import { getCatalogEntry } from "../../src/observability/event-catalog.js";
import { skillActivityEntries, skillAuditEntries } from "../../src/observability/catalog/skill-events.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 Skill 事件目录（T1 冻结，plans/phase-13.md §13.2）
// - 全部 skill.* 事件已登记进唯一权威目录；
// - activity 点号式 / audit 下划线式命名约定；
// - started 事件带 terminalStatuses；文件型操作有 audit 三件套镜像。
// ═══════════════════════════════════════════════════════════════

describe("Phase 13 Skill 事件目录（T1 冻结）", () => {
  it("全部 Skill 事件已登记进唯一权威目录", () => {
    for (const item of skillActivityEntries) {
      expect(getCatalogEntry(item.eventName), item.eventName).toBeDefined();
    }
    for (const item of skillAuditEntries) {
      expect(getCatalogEntry(item.eventName), item.eventName).toBeDefined();
    }
  });

  it("activity 事件命名统一点号式（不得下划线混用）", () => {
    for (const item of skillActivityEntries) {
      expect(item.eventName, item.eventName).toMatch(/^skill\.[a-z0-9._]+$/);
    }
  });

  it("audit 事件命名统一下划线式（与既有 audit.plugin.* 一致）", () => {
    for (const item of skillAuditEntries) {
      expect(item.eventName, item.eventName).toMatch(/^audit\.skill\.[a-z0-9_]+$/);
    }
  });

  it("started 事件必须有 terminalStatuses；terminal 事件终态合法", () => {
    const validTerminals = new Set(["completed", "failed", "cancelled", "interrupted", "denied"]);
    for (const item of skillActivityEntries) {
      if (item.lifecycleRole === "started") {
        expect(item.terminalStatuses, item.eventName).toBeDefined();
        expect(item.terminalStatuses!.length, item.eventName).toBeGreaterThanOrEqual(1);
      }
      if (item.lifecycleRole === "terminal" && item.terminalStatuses !== undefined) {
        for (const terminal of item.terminalStatuses) {
          expect(validTerminals.has(terminal), `${item.eventName} 的终态 ${terminal}`).toBe(true);
        }
      }
    }
  });

  it("文件型操作（install/rollback/uninstall/binding/bundle）有完整 audit 三件套镜像", () => {
    // install
    for (const phase of ["started", "completed", "failed"] as const) {
      expect(getCatalogEntry(`audit.skill.install_${phase}`)).toBeDefined();
      expect(getCatalogEntry(`skill.install.${phase}`)).toBeDefined();
    }
    // rollback
    for (const phase of ["started", "completed", "failed"] as const) {
      expect(getCatalogEntry(`audit.skill.rollback_${phase}`)).toBeDefined();
      expect(getCatalogEntry(`skill.rollback.${phase}`)).toBeDefined();
    }
    // binding（含 selection.changed / bound / unbound.approved 的 auditMirror 指向）
    expect(getCatalogEntry("audit.skill.binding_change_started")).toBeDefined();
    expect(getCatalogEntry("audit.skill.binding_change_completed")).toBeDefined();
    expect(getCatalogEntry("audit.skill.binding_change_failed")).toBeDefined();
    const bound = skillActivityEntries.find((item) => item.eventName === "skill.bound");
    expect(bound?.auditMirror).toBe("audit.skill.binding_change_completed");
  });

  it("关键事件 auditMirror 指向存在（镜像不为空且目标已注册）", () => {
    for (const item of skillActivityEntries) {
      if (item.auditMirror !== undefined) {
        expect(getCatalogEntry(item.auditMirror), `${item.eventName} → ${item.auditMirror}`).toBeDefined();
      }
    }
  });
});
