import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ObservabilityQuery } from "../../../src/observability/observability-query.js";
import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { PluginSkillBridge, createPluginFacadeStatePort, type PluginSkillStatePort } from "../../../src/runtime/skills/plugin/plugin-skill-bridge.js";
import { makeEnv, makeSkillPackageAt } from "./helpers.js";
import { cleanupT6Harnesses, createT6Harness, type T6Harness } from "./t6-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T7 Plugin Skill Bundle 桥（plans/phase-13.md §13.1 / §18.6）
// - 启用 → Catalog 登记（sourceKind=plugin / sourceId=插件 id / 版本=插件版本）；
// - 更新 → 新版本追加、旧版本保留；卸载 → blocked + 来源诊断 + 正文 fail-closed；
// - 转存（fixPluginSkillToManaged）→ managed 登记 + 严格审计 + 正文复制；
// - initialize 启动恢复：enabled → sync，其余 → block；
// - 事件：skill.discovered / skill.blocked 落 activity_events。
// ═══════════════════════════════════════════════════════════════

interface FakePluginRecord {
  readonly status: "enabled" | "disabled";
  readonly activeVersion: string;
  /** contributionId → 绝对 skillsDir */
  readonly bundles: Readonly<Record<string, { readonly version: string; readonly skillsDir: string; readonly name: string }>>;
}

function makeFakeState(records: Readonly<Record<string, FakePluginRecord>>): PluginSkillStatePort {
  return {
    isEnabled(pluginId) {
      return records[pluginId]?.status === "enabled";
    },
    activeVersion(pluginId) {
      return records[pluginId]?.activeVersion;
    },
    listPluginIds() {
      return Object.keys(records);
    },
    listSkillBundles(pluginId) {
      const record = records[pluginId];
      if (record === undefined) {
        return [];
      }
      return Object.entries(record.bundles).map(([contributionId, bundle]) => ({
        pluginId,
        contributionId,
        version: bundle.version,
        name: bundle.name,
        skillsDir: bundle.skillsDir,
      }));
    },
    listAgentBindings() {
      return [];
    },
  };
}

/** 建插件版本目录：<home>/plugins/installed/<pluginId>/<version>/skills/<name>/（返回 skills/ 根） */
function makePluginSkillsDir(harness: T6Harness, pluginId: string, version: string, name: string): string {
  const skillsDir = path.join(harness.home, "plugins", "installed", pluginId, version, "skills");
  makeSkillPackageAt(skillsDir, name, { name });
  return skillsDir;
}

afterEach(() => {
  cleanupT6Harnesses();
});

describe("PluginSkillBridge.syncPluginSkills", () => {
  it("插件启用 → Catalog 登记（sourceKind=plugin，sourceId=插件 id，版本=插件版本）", () => {
    const harness = createT6Harness();
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.2.0", "demo-skill");
    const state = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.2.0", bundles: { "b-1": { version: "1.2.0", skillsDir, name: "Demo Bundle" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });

    const summary = bridge.syncPluginSkills("plg-1");

    expect(summary.version).toBe("1.2.0");
    expect(summary.imported).toHaveLength(1);
    const registered = harness.catalog.list({ sourceKind: "plugin" });
    expect(registered).toHaveLength(1);
    expect(registered[0]!.skillRef.sourceKind).toBe("plugin");
    expect(registered[0]!.sourceId).toBe("plg-1");
    expect(registered[0]!.version).toBe("1.2.0");
    expect(registered[0]!.status.validity).toBe("valid");
    expect(registered[0]!.status.trust).toBe("trusted");
    expect(registered[0]!.provenance?.sourceRef).toContain("plg-1@1.2.0");
    // 事件：skill.discovered 落 activity_events（携带 skillRefKey/sourceId）
    const rows = new ObservabilityQuery(harness.db).queryActivities({ eventName: "skill.discovered" }, null, 50).items;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as { attributes: Record<string, unknown> };
    expect(payload.attributes["skillRefKey"]).toBe(skillRefKey(registered[0]!.skillRef));
    expect(payload.attributes["sourceId"]).toBe("plg-1");
    // search_text 含 skillRefKey（/logs 全文搜索可命中）
    const searchTextRow = harness.db.prepare("SELECT search_text AS searchText FROM activity_events WHERE event_name = 'skill.discovered'").get() as { searchText: string };
    expect(searchTextRow.searchText).toContain(skillRefKey(registered[0]!.skillRef));
  });

  it("插件更新 → 新版本追加登记，旧版本条目保留（可回滚）", () => {
    const harness = createT6Harness();
    const skillsDirV1 = makePluginSkillsDir(harness, "plg-1", "1.0.0", "demo-skill");
    const state = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir: skillsDirV1, name: "B" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    bridge.syncPluginSkills("plg-1");

    // 更新：新版本目录 + activeVersion 提升（旧 skillsDir 仍保留）
    const skillsDirV2 = makePluginSkillsDir(harness, "plg-1", "2.0.0", "demo-skill");
    const stateV2 = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "2.0.0", bundles: { "b-1": { version: "2.0.0", skillsDir: skillsDirV2, name: "B" } } },
    });
    const bridgeV2 = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state: stateV2, audit: harness.audit });
    bridgeV2.syncPluginSkills("plg-1");

    const registered = harness.catalog.list({ sourceKind: "plugin" });
    expect(registered).toHaveLength(2);
    const versions = registered.map((skill) => skill.version).sort();
    expect(versions).toEqual(["1.0.0", "2.0.0"]);
    const v1 = registered.find((skill) => skill.version === "1.0.0")!;
    const v2 = registered.find((skill) => skill.version === "2.0.0")!;
    expect(v1.skillRef.contentHash).not.toBe(v2.skillRef.contentHash);
  });

  it("插件未启用 → fail-closed 转 block，不登记", () => {
    const harness = createT6Harness();
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.0.0", "demo-skill");
    const state = makeFakeState({
      "plg-1": { status: "disabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir, name: "B" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    const summary = bridge.syncPluginSkills("plg-1");

    expect(summary.imported).toHaveLength(0);
    expect(harness.catalog.list({ sourceKind: "plugin" })).toHaveLength(0);
    expect(bridge.sourceBlockedInfo("plg-1").blocked).toBe(true);
  });

  it("损坏包（含被拒文件类型）→ 跳过登记（fail-closed），不抛错", () => {
    const harness = createT6Harness();
    const skillsDir = path.join(harness.home, "plugins", "installed", "plg-1", "1.0.0", "skills");
    // 有 SKILL.md 但包含拒绝类型（.exe → skill_binary_denied）：peek 通过但完整校验失败
    const brokenDir = path.join(skillsDir, "broken-skill");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "SKILL.md"), "---\nname: broken-skill\ndescription: broken\n---\nbody\n", "utf8");
    fs.writeFileSync(path.join(brokenDir, "evil.exe"), Buffer.from("MZ..."), "utf8");
    const goodDir = makeSkillPackageAt(skillsDir, "good-skill", { name: "good-skill" });
    const state = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir, name: "B" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    const summary = bridge.syncPluginSkills("plg-1");

    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]!.skillId).toBe("good-skill");
    expect(summary.skipped.some((item) => item.skillId === "broken-skill")).toBe(true);
    expect(goodDir).toBeTruthy();
  });
});

describe("PluginSkillBridge.blockPluginSkills / 联动", () => {
  it("插件卸载 → 条目保留 + blocked + 来源诊断 + 正文读取 fail-closed", () => {
    const harness = createT6Harness();
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.0.0", "demo-skill");
    const state = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir, name: "B" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    bridge.syncPluginSkills("plg-1");
    const ref = harness.catalog.list({ sourceKind: "plugin" })[0]!.skillRef;

    const result = bridge.blockPluginSkills("plg-1", "plugin_uninstalled");

    expect(result.affected).toBe(1);
    // 条目保留
    expect(harness.catalog.list({ sourceKind: "plugin" })).toHaveLength(1);
    // blocked + 来源诊断（blockedReason 含插件卸载）
    const overlay = bridge.overlayStatus(harness.catalog.resolveBySkillRef(ref));
    expect(overlay.readiness).toBe("blocked");
    expect(overlay.blockedReason).toContain("plugin_uninstalled");
    // 正文读取 fail-closed（SkillError.code 断言）
    expect(errorCodeOf(() => bridge.assertPluginSkillReadable(ref))).toBe("skill_content_read_denied");
    // 事件：skill.blocked 落 activity_events
    const rows = new ObservabilityQuery(harness.db).queryActivities({ eventName: "skill.blocked" }, null, 50).items;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as { attributes: Record<string, unknown> };
    expect(payload.attributes["pluginId"]).toBe("plg-1");
    expect(payload.attributes["count"]).toBe(1);
    // 非插件 Skill 不受影响
    expect(() => bridge.assertPluginSkillReadable({ ...ref, sourceKind: "managed" })).not.toThrow();
  });

  it("requires.plugins 联动：overlayStatus 用真实绑定重算 readiness", () => {
    const harness = createT6Harness();
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.0.0", "gated-skill");
    // Skill 要求另一个插件 p9（未绑定）→ degraded；绑定后 → ready
    fs.writeFileSync(
      path.join(skillsDir, "gated-skill", "SKILL.md"),
      "---\nname: gated-skill\ndescription: gated\nmetadata:\n  opencolorful:\n    version: 1\n    requires:\n      plugins: [p9]\n---\nbody\n",
      "utf8",
    );
    const state = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir, name: "B" } } },
      "p9": { status: "enabled", activeVersion: "1.0.0", bundles: {} },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    bridge.syncPluginSkills("plg-1");
    const registered = harness.catalog.list({ sourceKind: "plugin" })[0]!;

    // 未绑定 p9 → degraded
    expect(bridge.overlayStatus(registered, "agent-1").readiness).toBe("degraded");
    // 绑定且启用 p9 → ready
    const stateBound = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir, name: "B" } } },
      "p9": { status: "enabled", activeVersion: "1.0.0", bundles: {} },
    });
    const boundState: PluginSkillStatePort = {
      ...stateBound,
      listAgentBindings(agentId) {
        return agentId === "agent-1" ? [{ pluginId: "p9", enabled: true }] : [];
      },
    };
    const bridgeBound = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state: boundState, audit: harness.audit });
    expect(bridgeBound.overlayStatus(registered, "agent-1").readiness).toBe("ready");
    // 绑定但停用 → blocked
    const stateDisabledBinding: PluginSkillStatePort = {
      ...stateBound,
      listAgentBindings() {
        return [{ pluginId: "p9", enabled: false }];
      },
    };
    const bridgeDisabled = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state: stateDisabledBinding, audit: harness.audit });
    expect(bridgeDisabled.overlayStatus(registered, "agent-1").readiness).toBe("blocked");
    // buildAgentEnvironment：plugins 维 = 已绑定且启用
    expect(bridgeBound.buildAgentEnvironment("agent-1").plugins).toEqual(["p9"]);
  });
});

describe("PluginSkillBridge.fixPluginSkillToManaged", () => {
  it("转存 → managed 登记 + 正文复制 + 严格审计，插件条目保留", () => {
    const harness = createT6Harness();
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.0.0", "demo-skill");
    const state = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir, name: "B" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    bridge.syncPluginSkills("plg-1");
    const pluginEntry = harness.catalog.list({ sourceKind: "plugin" })[0]!;

    const result = bridge.fixPluginSkillToManaged({ pluginId: "plg-1", skillId: pluginEntry.skillId, actor: { kind: "user", id: "tester" } });

    expect(result.skillRef.sourceKind).toBe("managed");
    // 正文复制到 Managed Store
    const copiedRoot = result.skillRef.sourceId;
    expect(fs.existsSync(path.join(copiedRoot, "SKILL.md"))).toBe(true);
    // managed 登记存在；插件条目保留（独立操作）
    expect(harness.catalog.list({ sourceKind: "managed" })).toHaveLength(1);
    expect(harness.catalog.list({ sourceKind: "plugin" })).toHaveLength(1);
    // 严格审计：audit.skill.install_started/completed 同 action
    const auditRows = harness.db
      .prepare("SELECT event_name, action, before_revision AS beforeRevision, after_revision AS afterRevision FROM audit_events WHERE action = 'skill.plugin_fix_to_managed' ORDER BY id ASC")
      .all() as Array<{ event_name: string; action: string; beforeRevision: string | null; afterRevision: string | null }>;
    expect(auditRows.map((row) => row.event_name)).toEqual(["audit.skill.install_started", "audit.skill.install_completed"]);
    expect(auditRows[0]!.beforeRevision).toBe(skillRefKey(pluginEntry.skillRef));
    // revision 字段受 audit payload schema 64 字符上限约束（长 refKey 截断）；
    // managed refKey 含绝对路径 → 平台脱敏为 [WIN_PATH]（Phase 11：日志不留路径），
    // 断言保留 skillId 前缀即可
    expect(auditRows[1]!.afterRevision).toContain("demo-skill@");
    expect(auditRows[1]!.afterRevision).not.toContain("C:");
    const targetRow = harness.db
      .prepare("SELECT target_id AS targetId FROM audit_events WHERE action = 'skill.plugin_fix_to_managed' AND event_name = 'audit.skill.install_completed'")
      .get() as { targetId: string };
    expect(targetRow.targetId).toContain("skill:demo-skill@");
    // 转存后仍可解析 managed 条目（内容一致）
    expect(harness.catalog.resolveBySkillRef(result.skillRef).status.validity).toBe("valid");
  });

  it("转存时审计不可用 → 拒绝（fail-closed）", () => {
    const harness = createT6Harness();
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.0.0", "demo-skill");
    const state = makeFakeState({
      "plg-1": { status: "enabled", activeVersion: "1.0.0", bundles: { "b-1": { version: "1.0.0", skillsDir, name: "B" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state });
    bridge.syncPluginSkills("plg-1");
    const pluginEntry = harness.catalog.list({ sourceKind: "plugin" })[0]!;
    expect(errorCodeOf(() => bridge.fixPluginSkillToManaged({ pluginId: "plg-1", skillId: pluginEntry.skillId }))).toBe("skill_operation_failed");
  });

  it("未知 skillId / 来源不存在 → skill_unknown_skillref", () => {
    const harness = createT6Harness();
    const state = makeFakeState({});
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    expect(errorCodeOf(() => bridge.fixPluginSkillToManaged({ pluginId: "plg-1", skillId: "nope" }))).toBe("skill_unknown_skillref");
  });
});

describe("PluginSkillBridge.initialize / 端口适配", () => {
  it("启动恢复：enabled → sync，其余 → block", () => {
    const harness = createT6Harness();
    const skillsDirA = makePluginSkillsDir(harness, "plg-a", "1.0.0", "demo-a");
    const skillsDirB = makePluginSkillsDir(harness, "plg-b", "1.0.0", "demo-b");
    const state = makeFakeState({
      "plg-a": { status: "enabled", activeVersion: "1.0.0", bundles: { "b": { version: "1.0.0", skillsDir: skillsDirA, name: "A" } } },
      "plg-b": { status: "disabled", activeVersion: "1.0.0", bundles: { "b": { version: "1.0.0", skillsDir: skillsDirB, name: "B" } } },
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    const result = bridge.initialize();

    expect(result.synced).toEqual(["plg-a"]);
    expect(result.blocked).toEqual(["plg-b"]);
    expect(harness.catalog.list({ sourceKind: "plugin" })).toHaveLength(1);
    expect(bridge.sourceBlockedInfo("plg-b").blocked).toBe(true);
  });

  it("createPluginFacadeStatePort：相对 skillsDir 解析为版本目录绝对路径；逃逸贡献跳过", () => {
    const harness = createT6Harness();
    // 建真实插件版本目录：plugins/installed/plg-1/1.0.0/skills/
    const versionDir = path.join(harness.home, "plugins", "installed", "plg-1", "1.0.0");
    const skillsDir = makeSkillPackageAt(path.join(versionDir, "skills"), "demo", { name: "demo" });
    const port = createPluginFacadeStatePort({
      paths: harness.paths,
      getActivePlugin: (pluginId) => (pluginId === "plg-1" ? { version: "1.0.0", status: "enabled" } : undefined),
      listAllPlugins: () => [{ pluginId: "plg-1", status: "enabled" }],
      listSkillBundles: (pluginId) =>
        pluginId === "plg-1"
          ? [
              { pluginId, contributionId: "b-1", version: "1.0.0", name: "B", skillsDir: "skills" },
              { pluginId, contributionId: "b-escape", version: "1.0.0", name: "Esc", skillsDir: "../../../outside" },
            ]
          : [],
      listAgentBindings: () => [],
    });

    expect(port.isEnabled("plg-1")).toBe(true);
    expect(port.activeVersion("plg-1")).toBe("1.0.0");
    const bundles = port.listSkillBundles("plg-1");
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.contributionId).toBe("b-1");
    expect(bundles[0]!.skillsDir).toBe(path.join(versionDir, "skills"));
    expect(skillsDir).toBeTruthy();
  });

describe("PluginSkillBridge.listAgentBoundPluginSkills（T12 P0-3）", () => {
  it("Agent 已绑定且启用的插件贡献 → 返回精确 SkillRef；未绑定/未启用/未登记 → 空", () => {
    const harness = createT6Harness();
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.0.0", "bound-skill");
    const skillsDir2 = makePluginSkillsDir(harness, "plg-2", "1.0.0", "other-skill");
    const state: PluginSkillStatePort = {
      isEnabled(pluginId) {
        return pluginId === "plg-1" || pluginId === "plg-2";
      },
      activeVersion(pluginId) {
        return pluginId === "plg-1" || pluginId === "plg-2" ? "1.0.0" : undefined;
      },
      listPluginIds() {
        return ["plg-1", "plg-2"];
      },
      listSkillBundles(pluginId) {
        if (pluginId === "plg-1") {
          return [{ pluginId, contributionId: "b-1", version: "1.0.0", name: "B1", skillsDir }];
        }
        if (pluginId === "plg-2") {
          return [{ pluginId, contributionId: "b-2", version: "1.0.0", name: "B2", skillsDir: skillsDir2 }];
        }
        return [];
      },
      listAgentBindings(agentId) {
        // agent-1 绑定并启用 plg-1；plg-2 未绑定；agent-2 无绑定
        if (agentId === "agent-1") {
          return [
            { pluginId: "plg-1", enabled: true },
            { pluginId: "plg-2", enabled: false },
          ];
        }
        return [];
      },
    };
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    bridge.syncPluginSkills("plg-1");
    bridge.syncPluginSkills("plg-2");

    // agent-1：绑定且启用 plg-1 → 返回其贡献；plg-2 绑定但停用 → 不返回
    const bound = bridge.listAgentBoundPluginSkills("agent-1");
    const boundIds = bound.map((skill) => skill.skillId);
    expect(boundIds).toContain("bound-skill");
    expect(boundIds).not.toContain("other-skill");
    // 无绑定 Agent → 空
    expect(bridge.listAgentBoundPluginSkills("agent-2")).toHaveLength(0);
  });
});



describe("PluginSkillBridge.listAgentBoundPluginSkills（T13 P0-2/P0-3 生产级回归）", () => {
  function makeBundledState(input: {
    readonly getActiveVersion: () => string;
    readonly bundles: { readonly contributionId: string; readonly skillsDir: string }[];
    readonly bindings: (agentId: string) => readonly { readonly pluginId: string; readonly enabled: boolean; readonly contributions?: readonly string[] }[];
  }): PluginSkillStatePort {
    return {
      isEnabled() {
        return true;
      },
      activeVersion() {
        return input.getActiveVersion();
      },
      listPluginIds() {
        return ["plg-1"];
      },
      listSkillBundles(pluginId) {
        if (pluginId !== "plg-1") {
          return [];
        }
        return input.bundles.map((bundle) => ({
          pluginId,
          contributionId: bundle.contributionId,
          version: input.getActiveVersion(),
          name: bundle.contributionId,
          skillsDir: bundle.skillsDir,
        }));
      },
      listAgentBindings(agentId) {
        return input.bindings(agentId);
      },
    };
  }

  it("P0-2：contribution 白名单——只绑定 events（未绑定 skills）→ 插件 Skill 不可见；绑定 skills → 可见；空数组 = 全部", () => {
    const harness = createT6Harness();
    // 两个 bundle 各自独立的 skillsDir（同一 skills/ 根无法区分 contribution）
    const skillsDir = makePluginSkillsDir(harness, "plg-1", "1.0.0", "whitelist-skill");
    const eventsDir = path.join(harness.home, "plugins", "installed", "plg-1", "1.0.0", "events-skill-bundle");
    makeSkillPackageAt(eventsDir, "events-skill", { name: "events-skill" });

    const state = makeBundledState({
      getActiveVersion: () => "1.0.0",
      bundles: [
        { contributionId: "skills", skillsDir },
        { contributionId: "events", skillsDir: eventsDir },
      ],
      bindings: (agentId) => (agentId === "agent-1" ? [{ pluginId: "plg-1", enabled: true, contributions: ["events"] }] : []),
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    bridge.syncPluginSkills("plg-1");

    // 只绑定 events contribution：skill-bundle "skills" 的贡献不可见
    const eventsOnly = bridge.listAgentBoundPluginSkills("agent-1");
    expect(eventsOnly.map((skill) => skill.skillId)).not.toContain("whitelist-skill");

    // 绑定 skills contribution → 可见
    const stateSkills = makeBundledState({
      getActiveVersion: () => "1.0.0",
      bundles: [
        { contributionId: "skills", skillsDir },
        { contributionId: "events", skillsDir: eventsDir },
      ],
      bindings: () => [{ pluginId: "plg-1", enabled: true, contributions: ["skills"] }],
    });
    const bridgeSkills = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state: stateSkills, audit: harness.audit });
    const skillsOnly = bridgeSkills.listAgentBoundPluginSkills("agent-1");
    expect(skillsOnly.map((skill) => skill.skillId)).toContain("whitelist-skill");

    // 空数组 = 全部启用（协议语义）→ 两个 bundle 的 Skill 都可见
    const stateAll = makeBundledState({
      getActiveVersion: () => "1.0.0",
      bundles: [
        { contributionId: "skills", skillsDir },
        { contributionId: "events", skillsDir: eventsDir },
      ],
      bindings: () => [{ pluginId: "plg-1", enabled: true, contributions: [] }],
    });
    const bridgeAll = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state: stateAll, audit: harness.audit });
    const all = bridgeAll.listAgentBoundPluginSkills("agent-1");
    expect(all.map((skill) => skill.skillId)).toEqual(expect.arrayContaining(["whitelist-skill", "events-skill"]));
  });

  it("P0-3：activeVersion 过滤——1.0.0 更新到 2.0.0 后只返回 active 版本（旧版本保留供 rollback 但不进当前 Turn）", () => {
    const harness = createT6Harness();
    // 两个版本目录（skillId 同名，版本不同）；active 版本可切换
    const dirV1 = makePluginSkillsDir(harness, "plg-1", "1.0.0", "ver-skill");
    const dirV2 = makePluginSkillsDir(harness, "plg-1", "2.0.0", "ver-skill");
    let activeVersion = "1.0.0";
    const state = makeBundledState({
      getActiveVersion: () => activeVersion,
      bundles: [{ contributionId: "skills", skillsDir: activeVersion === "1.0.0" ? dirV1 : dirV2 }],
      bindings: () => [{ pluginId: "plg-1", enabled: true, contributions: ["skills"] }],
    });
    const bridge = new PluginSkillBridge({ catalog: harness.catalog, paths: harness.paths, environment: makeEnv(), state, audit: harness.audit });
    // 1.0.0 激活时 sync → v1 登记
    bridge.syncPluginSkills("plg-1");
    expect(harness.catalog.list({ sourceKind: "plugin" }).some((skill) => skill.skillRef.version === "1.0.0")).toBe(true);

    // 更新到 2.0.0：active 切换后再次 sync → v2 追加、v1 保留（rollback 需要）
    activeVersion = "2.0.0";
    bridge.syncPluginSkills("plg-1");
    const catalogVersions = harness.catalog.list({ sourceKind: "plugin" }).filter((skill) => skill.skillId === "ver-skill");
    expect(catalogVersions.length).toBeGreaterThanOrEqual(2);

    // listAgentBoundPluginSkills 只返回 active（2.0.0）——历史版本不进当前 Turn
    const bound = bridge.listAgentBoundPluginSkills("agent-1");
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every((skill) => skill.skillRef.version === "2.0.0")).toBe(true);
  });
});
}); // PluginSkillBridge.initialize / 端口适配

/** 捕获 SkillError 稳定 reasonCode（跨语言消息不参与断言）。 */
function errorCodeOf(action: () => unknown): string {
  try {
    action();
    return "no-error";
  } catch (error) {
    if (error instanceof SkillError) {
      return error.code;
    }
    throw error;
  }
}
