import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BuiltinSkillSource } from "../../../src/runtime/skills/sources/builtin-source.js";
import { ExternalLocalSkillSource } from "../../../src/runtime/skills/sources/external-local-source.js";
import { ManagedSkillSource } from "../../../src/runtime/skills/sources/managed-source.js";
import { PluginSkillSource } from "../../../src/runtime/skills/sources/plugin-source.js";
import { SkillSourceError } from "../../../src/runtime/skills/errors.js";
import { WorkspaceSkillSource } from "../../../src/runtime/skills/sources/workspace-source.js";
import { DefaultSkillTrustPolicy, SkillSourceTrustStore, defaultSkillSourcesConfig } from "../../../src/runtime/skills/sources/trust-config.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { scanSkills } from "../../../src/runtime/skills/catalog/scan.js";
import { createSkillPackage, makeEnv, makeSkillPackageAt, tempPaths, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 五类来源扫描测试（plans/phase-13.md §8.1 / §18.2）
// ═══════════════════════════════════════════════════════════════

describe("builtin / managed 来源扫描", () => {
  it("builtin：扫描 skillsBuiltin 子目录，版本缺省 1.0.0", () => {
    const { paths, home } = tempPaths();
    const root = createSkillPackage(paths.skillsBuiltin, { name: "builtin-skill" });
    void root;
    const source = new BuiltinSkillSource(paths);
    const candidates = source.discover();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceKind).toBe("builtin");
    expect(candidates[0]?.displayName).toBe("builtin-skill");
    expect(candidates[0]?.version).toBe("1.0.0");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("managed：扫描 skillsInstalled/<skillId>/<version>/，版本取目录名", () => {
    const { paths, home } = tempPaths();
    const packageRoot = path.join(paths.skillsInstalled, "git-workflow", "1.2.0");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "SKILL.md"), "---\nname: git-workflow\ndescription: d\n---\n正文\n", "utf8");
    const source = new ManagedSkillSource(paths);
    const candidates = source.discover();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceKind).toBe("managed");
    expect(candidates[0]?.version).toBe("1.2.0");
    expect(candidates[0]?.displayName).toBe("git-workflow");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("managed：query 过滤", () => {
    const { paths, home } = tempPaths();
    for (const skillId of ["git-workflow", "code-review"]) {
      const packageRoot = path.join(paths.skillsInstalled, skillId, "1.0.0");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "SKILL.md"), `---\nname: ${skillId}\ndescription: d\n---\n正文\n`, "utf8");
    }
    const source = new ManagedSkillSource(paths);
    expect(source.discover("git")).toHaveLength(1);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("workspace / 兼容目录（默认关闭，显式信任后开启）", () => {
  it("默认信任策略（无 trustedRoots）→ 不扫描", () => {
    const cwd = tmpDir();
    makeSkillPackageAt(path.join(cwd, ".claude", "skills"), "ws-skill", { name: "ws-skill" });
    const trust = new DefaultSkillTrustPolicy(defaultSkillSourcesConfig());
    const source = new WorkspaceSkillSource({ cwd, home: cwd, trust });
    expect(source.discover()).toHaveLength(0);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("显式信任 cwd → 扫描 .claude/skills 等兼容目录", () => {
    const cwd = tmpDir();
    makeSkillPackageAt(path.join(cwd, ".claude", "skills"), "ws-skill", { name: "ws-skill" });
    const trust = new DefaultSkillTrustPolicy({ version: 1, trustedRoots: [cwd], disabledKinds: [], trustedSourceIds: {} });
    const source = new WorkspaceSkillSource({ cwd, home: cwd, trust });
    const candidates = source.discover();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceKind).toBe("workspace");
    expect(candidates[0]?.displayName).toBe("ws-skill");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("workspace 兼容目录位于 home 时同样只信任后扫描", () => {
    const home = tmpDir();
    makeSkillPackageAt(path.join(home, ".agents", "skills"), "agent-skill", { name: "agent-skill" });
    const untrusted = new WorkspaceSkillSource({ cwd: home, home, trust: new DefaultSkillTrustPolicy(defaultSkillSourcesConfig()) });
    expect(untrusted.discover()).toHaveLength(0);
    const trusted = new WorkspaceSkillSource({ cwd: home, home, trust: new DefaultSkillTrustPolicy({ version: 1, trustedRoots: [home], disabledKinds: [], trustedSourceIds: {} }) });
    expect(trusted.discover()).toHaveLength(1);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("external 本地目录与 plugin 来源", () => {
  it("external：scope.baseDir 一层子目录扫描", () => {
    const base = tmpDir();
    createSkillPackage(base, { name: "ext-skill" });
    const trust = new DefaultSkillTrustPolicy(defaultSkillSourcesConfig());
    const source = new ExternalLocalSkillSource(trust);
    const candidates = source.discover("", { baseDir: base });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceKind).toBe("external");
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("plugin：未注入 provider → 空（fail-closed），注入后扫描", () => {
    const base = tmpDir();
    const dir = createSkillPackage(base, { name: "plugin-skill" });
    void dir;
    const empty = new PluginSkillSource();
    expect(empty.discover()).toHaveLength(0);
    const withProvider = new PluginSkillSource({
      provider: {
        list: () => [{ pluginId: "p1", contributionId: "c1", version: "2.0.0", skillsDir: base }],
      },
    });
    const candidates = withProvider.discover();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceKind).toBe("plugin");
    expect(candidates[0]?.version).toBe("2.0.0");
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("stage 由 T3 实现：完整包可暂存，无效路径抛 SkillSourceError", () => {
    const { paths, home } = tempPaths();
    const source = new BuiltinSkillSource(paths);
    // 不存在/非目录 → skill_source_not_found / skill_not_a_complete_package
    expect(() => source.stage(path.join(home, "missing"))).toThrow(SkillSourceError);
    const pkg = createSkillPackage(paths.skillsBuiltin, { name: "builtin-skill" });
    const staged = source.stage(pkg);
    expect(staged.packageRoot).toBeTruthy();
    expect(staged.contentHash.startsWith("sha256-")).toBe(true);
    expect(fs.existsSync(path.join(staged.packageRoot, "SKILL.md"))).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("信任配置读写", () => {
  it("save/load 往返一致", () => {
    const { paths, home } = tempPaths();
    const store = new SkillSourceTrustStore(paths);
    store.save({ version: 1, trustedRoots: ["C:\\work\\proj"], disabledKinds: [], trustedSourceIds: { "ext://a": true } });
    const loaded = store.load();
    expect(loaded.trustedRoots).toContain("C:\\work\\proj");
    expect(loaded.trustedSourceIds["ext://a"]).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("配置缺失/损坏 → 默认配置（fail-closed，不静默信任）", () => {
    const { paths, home } = tempPaths();
    const store = new SkillSourceTrustStore(paths);
    expect(store.load()).toEqual(defaultSkillSourcesConfig());
    fs.mkdirSync(path.dirname(paths.skillSources), { recursive: true });
    fs.writeFileSync(paths.skillSources, "not-json{", "utf8");
    expect(store.load()).toEqual(defaultSkillSourcesConfig());
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("scanSkills 编排", () => {
  it("五类来源统一扫描并登记（workspace 未信任 → skipped）", () => {
    const { paths, home } = tempPaths();
    // builtin
    createSkillPackage(paths.skillsBuiltin, { name: "builtin-skill" });
    // managed
    const managedRoot = path.join(paths.skillsInstalled, "git-workflow", "1.0.0");
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.writeFileSync(path.join(managedRoot, "SKILL.md"), "---\nname: git-workflow\ndescription: d\n---\n正文\n", "utf8");
    // workspace（兼容目录，但默认未信任）
    const cwd = tmpDir();
    makeSkillPackageAt(path.join(cwd, ".claude", "skills"), "ws-skill", { name: "ws-skill" });

    const env = makeEnv();
    const catalog = new SkillCatalog();
    const untrustedTrust = new DefaultSkillTrustPolicy(defaultSkillSourcesConfig());
    const report = scanSkills({ paths, cwd, home: cwd, trust: untrustedTrust, environment: env, catalog });
    expect(report.registered.map((skill) => skill.sourceKind).sort()).toEqual(["builtin", "managed"]);
    expect(report.skipped.some((item) => item.sourceKind === "workspace")).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("workspace 显式信任后进入 registered", () => {
    const { paths, home } = tempPaths();
    const cwd = tmpDir();
    makeSkillPackageAt(path.join(cwd, ".claude", "skills"), "ws-skill", { name: "ws-skill" });
    const trust = new DefaultSkillTrustPolicy({ version: 1, trustedRoots: [cwd], disabledKinds: [], trustedSourceIds: {} });
    const catalog = new SkillCatalog();
    const report = scanSkills({ paths, cwd, home: cwd, trust, environment: makeEnv(), catalog, includeKinds: ["workspace"] });
    expect(report.registered).toHaveLength(1);
    expect(report.registered[0]?.sourceKind).toBe("workspace");
    expect(report.registered[0]?.status.trust).toBe("trusted");
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
