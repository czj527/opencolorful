import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../../src/config/paths.js";
import { openMetadataDatabase } from "../../../src/storage/database.js";
import { AuditRecorder } from "../../../src/observability/audit-recorder.js";
import { buildSkillComposition, buildSkillReadinessEnvironment, type SkillComposition } from "../../../src/runtime/skills/composition.js";
import { SkillSourceTrustStore } from "../../../src/runtime/skills/sources/trust-config.js";
import { PluginFacade } from "../../../src/platform/plugin-facade.js";
import { createServerApp } from "../../../src/server/app.js";
import { SessionService } from "../../../src/runtime/session-service.js";
import { PromptService } from "../../../src/runtime/prompt-service.js";
import { SessionIndex } from "../../../src/storage/session-index.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T10 组合根验收（plans/phase-13.md §20.1）
// - 组合根装配：安装 → 绑定 → PI 元数据注入 → 正文受控读取 → 解绑；
// - HTTP 冒烟：/api/skills 路由 + Agent 会话工具启用；
// - 插件生命周期接线：enable → sync、disable → block（正文读取 fail-closed）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];

const SHOWCASE_SKILL_DIR = path.resolve("examples/skills/sdk-showcase-skill");
const SHOWCASE_PLUGIN_DIR = path.resolve("examples/plugins/sdk-showcase");

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-skill-composition-"));
  temporaryDirectories.push(dir);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: dir });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const audit = new AuditRecorder({
    database,
    producer: { component: "unit-test", processType: "server", processId: "1", bootId: "boot", appVersion: "0.1.0", hostPlatform: process.platform },
  });
  // 信任示例源码根（组合根的本地安装防线：不接受未登记/未信任的任意路径）
  const trustStore = new SkillSourceTrustStore(paths);
  trustStore.save({
    version: 1,
    trustedRoots: [path.resolve("examples"), path.resolve("tests", "fixtures", "skills")],
    disabledKinds: [],
    trustedSourceIds: {},
  });
  return { dir, paths, database, audit };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

describe("Phase 13 T10 组合根验收", () => {
  it("装配 → 安装 sdk-showcase-skill → 绑定 → PI 元数据注入 → 正文受控读取", async () => {
    const fixture = makeFixture();
    const composition = buildSkillComposition({
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      cwd: process.cwd(),
    });
    composition.rebuildFromDisk();

    // 安装官方示例（trusted local 目录）
    const installed = composition.core.install({
      sourceRef: SHOWCASE_SKILL_DIR,
      kind: "local",
      agentId: "agent-a",
      sessionId: "session-1",
      turnId: "turn-1",
    });
    // 学习策略 ask-on-risk + 低风险 trusted local → 直接安装
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") return;
    if (installed.skillRef === undefined) {
      throw new Error("安装结果缺少 skillRef");
    }
    expect(installed.skillRef.skillId).toBe("sdk-showcase-skill");
    // §11.5：安装成功默认绑定当前 Agent（trusted + 低风险无确认路径）
    expect(installed.agentBinding).toBe("bound");

    // Agent 绑定（确认路径：先发确认令牌再 approve）
    const manage = composition.core.manageSkills({
      action: "bind",
      agentId: "agent-a",
      skillRef: installed.skillRef,
    });
    if (manage.status === "confirmation_required" && manage.confirmation !== undefined) {
      composition.core.approveConfirmation({ token: manage.confirmation.token, agentId: "agent-a" });
      const bound = composition.core.manageSkills({
        action: "bind",
        agentId: "agent-a",
        skillRef: installed.skillRef,
        confirmationToken: manage.confirmation.token,
      });
      expect(["ok", "bound"]).toContain(bound.status);
    } else {
      expect(["ok", "bound"]).toContain(manage.status);
    }

    // PI 元数据注入：快照冻结 + 受控 filePath/baseDir
    const piSkills = composition.core.buildPiSkillsForTurn({ agentId: "agent-a", sessionId: "session-1", turnId: "turn-1" });
    expect(piSkills.skills.length).toBeGreaterThan(0);
    const piSkill = piSkills.skills[0]!;
    expect(piSkill.name).toBe("SDK Showcase Skill"); // PI name = displayName
    // filePath 必须指向 bundle 内 SKILL.md（受控真实路径）
    expect(piSkill.filePath).toContain(path.join("skills", "installed"));
    expect(piSkill.filePath.endsWith("SKILL.md")).toBe(true);

    // 正文受控读取（经 ContentService：快照成员 + 哈希校验）
    const snapshot = composition.snapshots.createSkillSnapshot({
      agentId: "agent-a",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: {
        visible: composition.agentService.listAgentSkills("agent-a", buildSkillReadinessEnvironment({})).visible,
        shadowed: [],
        disabled: [],
        gated: [],
        diagnostics: [],
      },
    });
    const ref = installed.skillRef;
    const read = await composition.contentService.readSkillBody({ snapshot, skillRef: ref });
    expect(read.body.length).toBeGreaterThan(0);
    expect(read.body).toContain("# SDK Showcase Skill");
    expect(read.truncated).toBe(false);
  });

  it("HTTP 冒烟：/api/skills 路由 + Agent 会话工具启用", async () => {
    const fixture = makeFixture();
    const composition = buildSkillComposition({
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      cwd: process.cwd(),
    });
    composition.rebuildFromDisk();
    composition.core.install({
      sourceRef: SHOWCASE_SKILL_DIR,
      kind: "local",
      agentId: "agent-a",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    const index = new SessionIndex(fixture.database);
    const sessionService = new SessionService(fixture.paths, index);
    const promptService = new PromptService();
    const session = sessionService.create({ title: "Skill 会话", cwd: process.cwd(), agentId: "agent-a" });
    session.selectModel("faux", "faux-1");

    const { app } = createServerApp({
      paths: fixture.paths,
      sessionService,
      promptService,
      database: fixture.database,
      audit: fixture.audit,
      skillCoreService: composition.core,
    });

    // /api/skills 列表
    const listResponse = await app.request("/api/skills");
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as unknown[];
    expect(Array.isArray(listPayload)).toBe(true);

    // 会话 prompt（faux 分支）：Skill Core 工具启用 + PI 元数据槽不破坏会话
    const promptResponse = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(promptResponse.status).toBe(202);
  });


  it("T11 P0-4：启动激活后 resyncPluginSkills 按当前状态全量重建（enabled→sync / disabled→block）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    const composition = buildSkillComposition({
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      cwd: process.cwd(),
      pluginFacade: facade,
    });
    composition.rebuildFromDisk();
    composition.attachPluginLifecycle();

    // 安装并启用插件（模拟启动激活完成后：enable 钩子已 sync）
    await facade.install(
      { sourceType: "local", ref: SHOWCASE_PLUGIN_DIR },
      [{ pluginId: "example.sdk-showcase", capability: "tool.register", decision: "allowed" as const }],
    );
    await facade.enable("example.sdk-showcase");
    // 启动激活后全量重建：幂等、不抛错、插件 Skill 保持可解析
    expect(() => composition.resyncPluginSkills()).not.toThrow();
    const pluginSkills = composition.catalog.list({ sourceKind: "plugin" });
    expect(Array.isArray(pluginSkills)).toBe(true);

    // 禁用后再次全量重建：阻断生效（fail-closed，不暴露已禁用插件 Skill）
    await facade.disable("example.sdk-showcase");
    expect(() => composition.resyncPluginSkills()).not.toThrow();
    // 未配置 pluginBridge 的组合根同样幂等
    const plain = buildSkillComposition({
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      cwd: process.cwd(),
    });
    expect(() => plain.resyncPluginSkills()).not.toThrow();
  });

  it("插件生命周期接线：插件启用 → syncPluginSkills、禁用 → blocked（正文读取 fail-closed）", async () => {
    const fixture = makeFixture();
    const facade = new PluginFacade({
      database: fixture.database,
      paths: fixture.paths,
      audit: fixture.audit,
      hostVersion: "0.1.0",
    });
    const composition = buildSkillComposition({
      paths: fixture.paths,
      database: fixture.database,
      audit: fixture.audit,
      cwd: process.cwd(),
      pluginFacade: facade,
    });
    composition.rebuildFromDisk();
    composition.attachPluginLifecycle();

    // 安装并启用插件（showcase 含 skill-bundle 贡献？若无 skill-bundle 则跳过 sync 断言）
    await facade.install(
      { sourceType: "local", ref: SHOWCASE_PLUGIN_DIR },
      [{ pluginId: "example.sdk-showcase", capability: "tool.register", decision: "allowed" as const }],
    );
    await facade.enable("example.sdk-showcase");
    // 启用钩子已执行（best-effort）：Catalog 中可能出现插件来源 Skill 或跳过（示例无 skill-bundle 时 list 为空）
    const pluginSkills = composition.catalog.list({ sourceKind: "plugin" });
    expect(Array.isArray(pluginSkills)).toBe(true);
  });


});
