import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ObservabilityQuery } from "../../../src/observability/observability-query.js";
import { PathGuard } from "../../../src/sandbox/path-guard.js";
import { inspectLocalDirectory } from "../../../src/runtime/skills/sources/skill-source-adapter.js";
import { SkillScriptRunner, type SkillScriptExecutor, type SkillScriptSandboxPort } from "../../../src/runtime/skills/plugin/skill-script-runner.js";
import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { makeEnv } from "./helpers.js";
import { cleanupT6Harnesses, createT6Harness, type T6Harness } from "./t6-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T7 SkillScriptRunner（plans/phase-13.md §12.3 / §18.5）
// - bundle 内 scripts/ 相对路径允许（canonical 校验）；
// - 逃逸/符号链接/非常规文件 → denied（稳定 reasonCode）；
// - 无 Sandbox 能力 → blocked 拒绝，不降级宿主进程执行；
// - PathGuard/危险命令预检沿用 Phase 9 语义；
// - workspaceCwd 语义：执行 cwd = workspaceCwd，process.cwd 不得替代；
// - 事件：skill.script.started/completed/failed/denied。
// ═══════════════════════════════════════════════════════════════

function makePackageWithScript(harness: T6Harness, name: string): { readonly root: string; readonly skillRefKey: string } {
  const root = path.join(harness.home, "packages", name);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: 脚本测试\n---\nbody\n`, "utf8");
  fs.writeFileSync(path.join(root, "scripts", "build.js"), "console.log('hi')\n", "utf8");
  const inspection = inspectLocalDirectory(root);
  if (inspection.contentHash.length === 0) {
    throw new Error("包检查失败：无内容哈希");
  }
  const registered = harness.catalog.ingestCandidate({
    candidate: { sourceId: root, sourceKind: "managed", displayName: name, version: "1.0.0" },
    inspection,
    trusted: true,
    environment: makeEnv(),
  });
  return { root, skillRefKey: skillRefKey(registered.skillRef) };
}

function makeSkillRef(harness: T6Harness, name: string) {
  const listed = harness.catalog.list({ sourceKind: "managed", query: name })[0]!;
  return listed.skillRef;
}

function fullSandbox(): SkillScriptSandboxPort {
  const guard = new PathGuard({ rules: [], defaultLevel: "FULL", allowExternalReads: true });
  const denied: Array<{ operation: string; targetPath: string }> = [];
  return {
    pathGuard: guard,
    recordDenied: (operation, targetPath) => {
      denied.push({ operation, targetPath });
    },
    recordPreflightDenied: () => undefined,
    __denied: denied,
  } as SkillScriptSandboxPort & { __denied: Array<{ operation: string; targetPath: string }> };
}

function blockingSandbox(): SkillScriptSandboxPort {
  const guard = new PathGuard({ rules: [], defaultLevel: "BLOCKED", allowExternalReads: false });
  const denied: Array<{ operation: string; targetPath: string }> = [];
  return {
    pathGuard: guard,
    recordDenied: (operation, targetPath) => {
      denied.push({ operation, targetPath });
    },
    recordPreflightDenied: () => undefined,
    __denied: denied,
  } as SkillScriptSandboxPort & { __denied: Array<{ operation: string; targetPath: string }> };
}

afterEach(() => {
  cleanupT6Harnesses();
});

describe("SkillScriptRunner", () => {
  it("bundle 内脚本允许：cwd=workspaceCwd，记录 started/completed 事件", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "scripty");
    const skillRef = makeSkillRef(harness, "scripty");
    const workspaceCwd = path.join(harness.home, "workspace");
    fs.mkdirSync(workspaceCwd, { recursive: true });
    const executed: Array<{ scriptPath: string; args: readonly string[]; cwd: string }> = [];
    const executor: SkillScriptExecutor = {
      run: (input) => {
        executed.push({ scriptPath: input.scriptPath, args: input.args, cwd: input.cwd });
        return { status: "completed", exitCode: 0 };
      },
    };
    const runner = new SkillScriptRunner({ catalog: harness.catalog, sandbox: fullSandbox(), executor });

    const result = await runner.runScript({ skillRef, scriptRelativePath: "scripts/build.js", args: ["--prod"], workspaceCwd, agentId: "agent-1", sessionId: "s-1" });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.exitCode).toBe(0);
    }
    expect(executed).toHaveLength(1);
    // workspaceCwd 语义：cwd = workspaceCwd（绝非 process.cwd()）
    expect(executed[0]!.cwd).toBe(workspaceCwd);
    expect(executed[0]!.cwd).not.toBe(process.cwd());
    expect(executed[0]!.args).toEqual(["--prod"]);
    expect(executed[0]!.scriptPath.endsWith(path.join("scripts", "build.js"))).toBe(true);
    // 事件：started + completed 落库，携带 skillRefKey（managed 来源含路径 →
    // 平台脱敏为 [WIN_PATH]，只保留 skillId 前缀；插件来源无路径则原样）
    const rows = new ObservabilityQuery(harness.db).queryActivities({ eventName: "skill.script.completed" }, null, 50).items;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as { attributes: Record<string, unknown> };
    expect(String(payload.attributes["skillRefKey"])).toContain("scripty@");
    expect(payload.attributes["script"]).toBe("scripts/build.js");
    expect(payload.attributes["exitCode"]).toBe(0);
  });

  it("逃逸拒绝：scripts/ 外路径与 .. 穿越 → denied skill_path_escape", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "esc");
    const skillRef = makeSkillRef(harness, "esc");
    const runner = new SkillScriptRunner({ catalog: harness.catalog, sandbox: fullSandbox(), executor: { run: () => ({ status: "completed", exitCode: 0 }) } });

    const outside = await runner.runScript({ skillRef, scriptRelativePath: "SKILL.md", workspaceCwd: harness.home });
    expect(outside.status).toBe("denied");
    if (outside.status === "denied") {
      expect(outside.reasonCode).toBe("skill_path_escape");
    }
    const traversal = await runner.runScript({ skillRef, scriptRelativePath: "scripts/../SKILL.md", workspaceCwd: harness.home });
    expect(traversal.status).toBe("denied");
    if (traversal.status === "denied") {
      expect(traversal.reasonCode).toBe("skill_path_escape");
    }
    const absolute = await runner.runScript({ skillRef, scriptRelativePath: "C:/windows/system32/cmd.exe", workspaceCwd: harness.home });
    expect(absolute.status).toBe("denied");
    if (absolute.status === "denied") {
      expect(absolute.reasonCode).toBe("skill_path_escape");
    }
    // 逃逸也记录 skill.script.denied
    const deniedRows = new ObservabilityQuery(harness.db).queryActivities({ eventName: "skill.script.denied" }, null, 50).items;
    expect(deniedRows.length).toBeGreaterThanOrEqual(3);
  });

  it("无 Sandbox 能力 → denied skill_readiness_blocked（不降级宿主进程执行）", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "nosandbox");
    const skillRef = makeSkillRef(harness, "nosandbox");
    const executed: string[] = [];
    const runner = new SkillScriptRunner({
      catalog: harness.catalog,
      executor: {
        run: (input) => {
          executed.push(input.scriptPath);
          return { status: "completed", exitCode: 0 };
        },
      },
    });

    const result = await runner.runScript({ skillRef, scriptRelativePath: "scripts/build.js", workspaceCwd: harness.home });

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_readiness_blocked");
    }
    expect(executed).toHaveLength(0); // 绝不执行
  });

  it("PathGuard 拒绝 → denied + sandbox.path.denied 记录", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "guarded");
    const skillRef = makeSkillRef(harness, "guarded");
    const sandbox = blockingSandbox();
    const runner = new SkillScriptRunner({ catalog: harness.catalog, sandbox, executor: { run: () => ({ status: "completed", exitCode: 0 }) } });

    const result = await runner.runScript({ skillRef, scriptRelativePath: "scripts/build.js", workspaceCwd: harness.home, agentId: "agent-1" });

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_readiness_blocked");
    }
    const denied = (sandbox as SkillScriptSandboxPort & { __denied: unknown[] }).__denied;
    expect(denied.length).toBeGreaterThan(0);
  });

  it("无执行入口 → denied（不直接 child_process）", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "noexec");
    const skillRef = makeSkillRef(harness, "noexec");
    const runner = new SkillScriptRunner({ catalog: harness.catalog, sandbox: fullSandbox() });

    const result = await runner.runScript({ skillRef, scriptRelativePath: "scripts/build.js", workspaceCwd: harness.home });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_readiness_blocked");
    }
  });

  it("插件来源阻断门 → denied skill_content_read_denied", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "blocked-src");
    const skillRef = makeSkillRef(harness, "blocked-src");
    const runner = new SkillScriptRunner({
      catalog: harness.catalog,
      sandbox: fullSandbox(),
      executor: { run: () => ({ status: "completed", exitCode: 0 }) },
      blockedSourceCheck: (ref) => (ref.sourceKind === "plugin" ? { blocked: true, reason: "plugin_uninstalled" } : { blocked: false }),
    });

    const result = await runner.runScript({ skillRef: { ...skillRef, sourceKind: "plugin" }, scriptRelativePath: "scripts/build.js", workspaceCwd: harness.home });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_content_read_denied");
    }
  });

  it("executor 返回 denied → skill.script.denied 事件（稳定 reasonCode）", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "exec-denied");
    const skillRef = makeSkillRef(harness, "exec-denied");
    const runner = new SkillScriptRunner({
      catalog: harness.catalog,
      sandbox: fullSandbox(),
      executor: { run: () => ({ status: "denied", reasonCode: "skill_readiness_blocked", reason: "危险命令模式" }) },
    });

    const result = await runner.runScript({ skillRef, scriptRelativePath: "scripts/build.js", workspaceCwd: harness.home });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_readiness_blocked");
    }
    const rows = new ObservabilityQuery(harness.db).queryActivities({ eventName: "skill.script.denied" }, null, 50).items;
    expect(rows).toHaveLength(1);
  });

  it("workspaceCwd 缺失 → denied skill_operation_failed（process.cwd 不得替代）", async () => {
    const harness = createT6Harness();
    makePackageWithScript(harness, "nocwd");
    const skillRef = makeSkillRef(harness, "nocwd");
    const executed: string[] = [];
    const runner = new SkillScriptRunner({
      catalog: harness.catalog,
      sandbox: fullSandbox(),
      executor: {
        run: (input) => {
          executed.push(input.cwd);
          return { status: "completed", exitCode: 0 };
        },
      },
    });

    const result = await runner.runScript({ skillRef, scriptRelativePath: "scripts/build.js", workspaceCwd: "   " });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_operation_failed");
    }
    expect(executed).toHaveLength(0);
  });

  it("unknown skillRef → denied skill_unknown_skillref（不抛错）", async () => {
    const harness = createT6Harness();
    const runner = new SkillScriptRunner({ catalog: harness.catalog, sandbox: fullSandbox(), executor: { run: () => ({ status: "completed", exitCode: 0 }) } });
    const result = await runner.runScript({
      skillRef: { skillId: "ghost", sourceId: "ghost", sourceKind: "managed", version: "1.0.0", contentHash: "x".repeat(64) },
      scriptRelativePath: "scripts/build.js",
      workspaceCwd: harness.home,
    });
    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reasonCode).toBe("skill_unknown_skillref");
    }
  });
});
