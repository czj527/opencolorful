import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";

import type { ProducerContext } from "../../../src/contracts/observability.js";
import { skillRefKey, type SkillRef } from "../../../src/contracts/skill-protocol.js";
import { getRuntimePaths, type RuntimePaths } from "../../../src/config/paths.js";
import { openMetadataDatabase } from "../../../src/storage/database.js";
import { ObservabilityContext } from "../../../src/observability/observability-context.js";
import { instrument } from "../../../src/observability/instrument.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { AgentSkillConfigStore } from "../../../src/runtime/skills/agent/agent-skill-config.js";
import { AgentSkillService } from "../../../src/runtime/skills/binding/skill-binding-service.js";
import { SkillBundleService } from "../../../src/runtime/skills/bundles/skill-bundle-service.js";
import { SessionSkillService } from "../../../src/runtime/skills/session/session-skill-service.js";
import { AgentSkillBindingStore } from "../../../src/storage/agent-skill-binding-store.js";
import { SkillBundleStore } from "../../../src/storage/skill-bundle-store.js";
import { SessionSkillBindingStore } from "../../../src/storage/session-skill-binding-store.js";
import { SkillActivationGrantStore } from "../../../src/storage/skill-activation-grant-store.js";
import { SkillOperationStore } from "../../../src/runtime/skills/installer/operation-store.js";
import { SessionFileRegistry } from "../../../src/runtime/skills/installer/session-file-registry.js";
import { SkillStager } from "../../../src/runtime/skills/installer/stager.js";
import { SkillInstaller } from "../../../src/runtime/skills/installer/skill-installer.js";
import { BuiltinSkillSource } from "../../../src/runtime/skills/sources/builtin-source.js";
import { ManagedSkillSource } from "../../../src/runtime/skills/sources/managed-source.js";
import { ArchiveSkillSource } from "../../../src/runtime/skills/sources/archive-source.js";
import { OpenClawSkillSource } from "../../../src/runtime/skills/sources/openclaw-skill-source.js";
import { HermesSkillSource } from "../../../src/runtime/skills/sources/hermes-skill-source.js";
import { SkillSnapshotService } from "../../../src/runtime/skills/snapshot/skill-snapshot.js";
import { SkillContentService } from "../../../src/runtime/skills/content/skill-content-service.js";
import { resolveSkillCandidates, type ResolveOutput } from "../../../src/runtime/skills/resolver.js";
import { makeEnv, tempPaths, rmrf } from "../../unit/skills/helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 生态 fixture 全流水线（plans/phase-13.md §18.7 / §8.4 / §15.2）
//
// 固定本地 fixture（tests/fixtures/skills/）走完整链路：
//   发现（兼容等级正确）→ 检查 → 安装 → 绑定 → Snapshot → 加载
//   （经 SkillContentService）→ 脚本风险标记 → 二进制拒绝 → 卸载。
// 默认 CI 全程离线：不请求外网、不依赖个人凭据、不依赖远程市场。
// ═══════════════════════════════════════════════════════════════

const FIXTURES = path.resolve("tests/fixtures/skills");

const producer: ProducerContext = {
  component: "t9-eco-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t9",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

interface EcoHarness {
  readonly paths: RuntimePaths;
  readonly home: string;
  readonly db: Database.Database;
  readonly catalog: SkillCatalog;
  readonly installer: SkillInstaller;
  readonly stager: SkillStager;
  readonly agentService: AgentSkillService;
  readonly content: SkillContentService;
  readonly snapshots: SkillSnapshotService;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function makeHarness(): EcoHarness {
  const { paths, home } = tempPaths("ocf-t9-eco-");
  const db = openMetadataDatabase(path.join(home, "metadata.sqlite"));
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(home, "logs"),
    spoolRoot: path.join(home, "spool"),
  });
  instrument.init(context);
  const now = (): Date => new Date("2026-01-01T00:00:00.000Z");

  const catalog = new SkillCatalog();
  const configStore = new AgentSkillConfigStore(paths);
  const bindingStore = new AgentSkillBindingStore(db);
  const bundles = new SkillBundleStore(db);
  const sessionBindings = new SessionSkillBindingStore(db);
  const grants = new SkillActivationGrantStore(db);
  const operations = new SkillOperationStore(db);
  const sessionFiles = new SessionFileRegistry();
  const adapters = [new BuiltinSkillSource(paths), new ManagedSkillSource(paths), new ArchiveSkillSource(paths)];
  const stager = new SkillStager({ paths, adapters, sessionFiles });
  const installer = new SkillInstaller({
    paths,
    catalog,
    operations,
    sessionFiles,
    adapters,
    stager,
    environment: makeEnv(),
  });
  const agentService = new AgentSkillService({
    paths,
    catalog,
    configStore,
    bindingStore,
    bundles,
    audit: context.audit,
    operations,
    now,
  });
  const bundleService = new SkillBundleService({
    paths,
    bundles,
    catalog,
    configStore,
    bindingStore,
    audit: context.audit,
    operations,
    now,
  });
  void bundleService;
  const sessionService = new SessionSkillService({ catalog, sessionBindings, grants, now });
  void sessionService;
  const snapshots = new SkillSnapshotService({ now });
  const content = new SkillContentService({ catalog, snapshots, grants, now });

  cleanups.push(() => {
    instrument.reset();
    try {
      db.close();
    } catch {
      // ignore
    }
    rmrf(home);
  });
  return { paths, home, db, catalog, installer, stager, agentService, content, snapshots };
}

/** 安装 fixture 包（kind=local，完整流水线）并返回登记结果。 */
function installFixture(harness: EcoHarness, fixtureDir: string, trust = true): ReturnType<SkillInstaller["install"]> {
  return harness.installer.install({ sourceRef: path.join(FIXTURES, fixtureDir), kind: "local", trust });
}

/** 绑定 → 解析 → Snapshot → 读取正文（加载路径，经 SkillContentService）。 */
async function bindAndLoad(harness: EcoHarness, ref: SkillRef, env = makeEnv()): Promise<string> {
  const bound = harness.agentService.bindSkill({
    agentId: "agent-1",
    skillRef: ref,
    actor: { kind: "user", id: "t9-test" },
  });
  expect(bound.status).toBe("bound");
  const resolveOutput: ResolveOutput = resolveSkillCandidates({
    candidates: harness.catalog.list({}),
    pinnedRefs: [ref],
    environment: env,
  });
  expect(resolveOutput.visible.length).toBeGreaterThan(0);
  const snapshot = harness.snapshots.createSkillSnapshot({
    agentId: "agent-1",
    sessionId: "session-1",
    turnId: "turn-1",
    resolveOutput,
  });
  const result = await harness.content.readSkillBody({ snapshot, skillRef: ref });
  expect(result.body.length).toBeGreaterThan(0);
  expect(result.truncated).toBe(false);
  return result.body;
}

describe("生态 fixture 全流水线（默认 CI，离线）", () => {
  it("OpenClaw 格式：发现（兼容等级）→ 检查 → 安装 → 绑定 → 加载 → 卸载", async () => {
    const harness = makeHarness();
    // 1) 发现：OpenClaw 适配器（registry-openclaw 镜像，等价 ClawHub 搜索）
    const eco = new OpenClawSkillSource({ registryDir: path.join(FIXTURES, "registry-openclaw") });
    const candidates = eco.discover();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.some((c) => c.sourceKind === "external" && c.version === "1.0.0")).toBe(true);
    // 2) 检查：兼容等级正确 + requires 映射
    const inspection = eco.inspect("openclaw:hello-openclaw@1.0.0");
    expect(inspection.manifest?.compatibilityLevel).toBe("openclaw");
    // 3) 安装（同一条流水线：stager → validate → catalog）
    const installed = installFixture(harness, "openclaw-fmt");
    expect(installed.skillRef.skillId).toBe("openclaw-fmt");
    expect(installed.registered.compatibility?.level).toBe("openclaw");
    expect(installed.registered.manifest?.opencolorful?.requires?.bins).toEqual(["git"]);
    expect(installed.registered.manifest?.opencolorful?.requires?.os).toEqual(["win32", "darwin", "linux"]);
    expect(installed.registered.manifest?.opencolorful?.requires?.capabilities).toEqual(["filesystem-read"]);
    // 4) 绑定 + Snapshot + 加载（经 SkillContentService）
    const body = await bindAndLoad(harness, installed.skillRef);
    expect(body).toContain("OpenClaw Fmt");
    // 5) 卸载：Catalog 移除 + installed 目录删除
    const uninstalled = harness.installer.uninstall({ skillId: "openclaw-fmt" });
    expect(uninstalled.removedRefs).toBe(1);
    expect(harness.catalog.list({}).filter((s) => s.skillId === "openclaw-fmt")).toHaveLength(0);
    expect(fs.existsSync(path.join(harness.paths.skillsInstalled, "openclaw-fmt"))).toBe(false);
  });

  it("Hermes 格式：发现 → 检查（hermes 等级）→ 安装 → 绑定 → 加载 → 卸载", async () => {
    const harness = makeHarness();
    const eco = new HermesSkillSource({ registryDir: path.join(FIXTURES, "registry-hermes") });
    const candidates = eco.discover();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceId).toBe("hermes:hermes-notes@1.3.0");
    const inspection = eco.inspect("hermes:hermes-notes@1.3.0");
    expect(inspection.manifest?.compatibilityLevel).toBe("hermes");
    // 转换后形态的 requires（platforms/commands/required_environment* 已并入）
    expect(inspection.manifest?.opencolorful?.requires?.os).toEqual(["linux", "win32", "darwin"]);
    expect(inspection.manifest?.opencolorful?.requires?.bins).toEqual(["jq", "git", "python3"]);
    expect(inspection.manifest?.opencolorful?.requires?.env).toEqual(["HERMES_HOME"]);
    // 兼容报告保留描述性诊断（metadata.hermes.tags 等），不阻断安装
    expect(inspection.compatibility?.missing.some((key) => key.startsWith("metadata.hermes."))).toBe(true);

    // T2 基础形态单包（kind=local 安装流）
    const installed = installFixture(harness, "hermes-fmt");
    expect(installed.registered.compatibility?.level).toBe("hermes");
    expect(installed.registered.manifest?.opencolorful?.requires?.os).toEqual(["linux", "win32"]);
    expect(installed.registered.manifest?.opencolorful?.requires?.bins).toEqual(["python3"]);
    expect(installed.registered.manifest?.opencolorful?.requires?.env).toEqual(["HOME"]);
    expect(installed.registered.manifest?.opencolorful?.requires?.tools).toEqual(["notes-tool"]);
    // 默认环境缺 python3 → readiness blocked（fail-closed 门控，不静默加载）
    const gated = resolveSkillCandidates({
      candidates: harness.catalog.list({}),
      pinnedRefs: [installed.skillRef],
      environment: makeEnv(),
    });
    expect(gated.visible).toHaveLength(0);
    expect(gated.diagnostics.some((d) => d.code === "skill_readiness_blocked")).toBe(true);
    // 满足 requires 的环境 → 可见并可加载
    const body = await bindAndLoad(harness, installed.skillRef, makeEnv({ bins: ["git", "python3"] }));
    expect(body).toContain("Hermes Fmt");
    expect(harness.installer.uninstall({ skillId: "hermes-fmt" }).removedRefs).toBe(1);
  });

  it("PI / Claude / Codex 标准 fixture：pi-compatible 等级，目录结构直接兼容", async () => {
    const harness = makeHarness();
    const cases = [
      { fixture: "pi-standard", skillId: "pi-standard", expectName: "PI Standard" },
      { fixture: "claude-dotdir/.claude/skills/claude-helper", skillId: "claude-helper", expectName: "Claude Helper" },
      { fixture: "codex-dotdir/.codex/skills/codex-helper", skillId: "codex-helper", expectName: "Codex Helper" },
    ];
    for (const entry of cases) {
      const installed = installFixture(harness, entry.fixture);
      expect(installed.registered.manifest?.compatibilityLevel).toBe("pi-compatible");
      expect(installed.registered.manifest?.name).toBe(entry.expectName);
      expect(skillRefKey(installed.skillRef).startsWith(`${entry.skillId}@`)).toBe(true);
      const body = await bindAndLoad(harness, installed.skillRef);
      expect(body.length).toBeGreaterThan(0);
      expect(harness.installer.uninstall({ skillId: entry.skillId }).removedRefs).toBe(1);
    }
    // pi-standard 的 allowed-tools 只解析为依赖提示，不产生任何授权
    const pi = installFixture(harness, "pi-standard");
    expect(pi.registered.manifest?.allowedTools).toEqual(["bash", "grep"]);
    expect(harness.installer.uninstall({ skillId: "pi-standard" }).removedRefs).toBe(1);
  });

  it("scripts 风险：inspect 标记 scripts，安装成功但绝不执行来源脚本", async () => {
    const harness = makeHarness();
    const inspection = harness.installer.inspectSource({ sourceRef: path.join(FIXTURES, "risky-scripts"), kind: "local" });
    expect(inspection.risks.some((risk) => risk.code === "scripts")).toBe(true);
    expect(inspection.inspection.errors).toHaveLength(0);
    const installed = installFixture(harness, "risky-scripts");
    expect(installed.risks.some((risk) => risk.code === "scripts")).toBe(true);
    // 安装产物只是复制：scripts/ 原样存在，安装过程不产出任何执行痕迹
    const installedScripts = path.join(harness.paths.skillsInstalled, "risky-scripts", "1.0.0", "scripts");
    expect(fs.readdirSync(installedScripts).sort()).toEqual(["run.sh", "setup.py"]);
    expect(fs.readFileSync(path.join(installedScripts, "run.sh"), "utf8")).toContain("must never run");
    expect(harness.installer.uninstall({ skillId: "risky-scripts" }).removedRefs).toBe(1);
  });

  it("二进制拒绝：skill_binary_denied + 迁移建议（建议转 Plugin）", async () => {
    const harness = makeHarness();
    const inspection = harness.installer.inspectSource({ sourceRef: path.join(FIXTURES, "binary-pkg"), kind: "local" });
    expect(inspection.inspection.errors.some((error) => error.reasonCode === "skill_binary_denied")).toBe(true);
    let caught: unknown;
    try {
      installFixture(harness, "binary-pkg");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { code: string }).code).toBe("skill_binary_denied");
    // local 路径的错误来自适配器 buildStagedPackage（二进制校验 fail-closed）；
    // 生态适配器路径在 stage 追加迁移建议（单元测试已覆盖）
    expect((caught as { message: string }).message).toContain("二进制");
    expect(harness.catalog.list({}).filter((s) => s.skillId === "binary-pkg")).toHaveLength(0);
  });

  it("兼容失败（unsupported）：生态适配器 stage 拒绝并给迁移建议（不生成空壳）", async () => {
    const harness = makeHarness();
    // 检查：兼容等级 unsupported + requiresManualMigration
    const eco = new OpenClawSkillSource({ registryDir: path.join(FIXTURES, "registry-openclaw") });
    const inspection = eco.inspect("openclaw:broken-unsupported@0.1.0");
    expect(inspection.manifest?.compatibilityLevel).toBe("unsupported");
    expect(inspection.compatibility?.requiresManualMigration).toBe(true);
    // stage：拒绝 + 迁移建议
    let caught: unknown;
    try {
      eco.stage("openclaw:broken-unsupported@0.1.0", { stagingRoot: path.join(harness.home, "staging-test") });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).toBe("skill_package_invalid");
    expect((caught as { message: string }).message).toContain("迁移建议");
    // 独立 compat-failure fixture 的检查路径同样给出 unsupported 诊断
    const localInspection = harness.installer.inspectSource({ sourceRef: path.join(FIXTURES, "compat-failure"), kind: "local" });
    expect(localInspection.inspection.manifest?.compatibilityLevel).toBe("unsupported");
    expect(localInspection.inspection.compatibility?.requiresManualMigration).toBe(true);
    // 没有产生任何已安装登记（不生成表面成功空壳）
    expect(harness.catalog.list({}).length).toBe(0);
  });

  it("接线状态：T3 SkillStager 仍拦截 openclaw/hermes kind（组合根合并项，见 README）", () => {
    const harness = makeHarness();
    for (const kind of ["openclaw", "hermes"] as const) {
      let caught: unknown;
      try {
        harness.stager.stage({ sourceRef: `${kind}:anything@1.0.0`, kind, operationId: `op-${kind}` });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as { code: string }).code).toBe("skill_source_unsupported");
    }
  });
});
