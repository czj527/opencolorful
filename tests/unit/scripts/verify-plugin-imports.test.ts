// ═══════════════════════════════════════════════════════════════
// scripts/verify-plugin-imports.mjs 的执行性回归测试
//
// 审计背景（docs/audits/2026-09-06-wave-a-b-delivery-quality.zh.md §7.1）：
// 该脚本的 CLI 入口判断曾把磁盘路径与 file:// URL 字符串直接比较，
// 恒为假 → 通过 `node scripts/verify-plugin-imports.mjs` 调用时扫描从未执行，
// check:plugin-imports 门禁恒 exit 0（no-op）。
//
// 测试意图：
// 1) CLI 用例通过 spawnSync 以真实子进程执行脚本——在入口判断修复前，
//    "违规 fixture → exit 1" 断言必然失败（旧代码恒 exit 0 且无任何输出），
//    这正是防止门禁再次静默失效的执行性回归；
// 2) 单元用例直接调用 findPluginImportViolations，
//    覆盖三类违规规则（相对路径进入 src/、@earendil-works/、协议包 dist 深路径）
//    以及允许项（包名消费协议包、包内相对导入）不误报。
// ═══════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { findPluginImportViolations } from "../../../scripts/verify-plugin-imports.mjs";

// tests/unit/scripts/*.test.ts → 仓库根（worktree 根）
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scriptPath = path.join(repoRoot, "scripts", "verify-plugin-imports.mjs");

const temporaryDirectories: string[] = [];

function createFixture(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "opencolorful-plugin-imports-"));
  temporaryDirectories.push(fixture);
  return fixture;
}

function writeFixtureFile(fixture: string, relPath: string, content: string): void {
  const full = path.join(fixture, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function runScript(fixture: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [scriptPath, fixture], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

afterAll(() => {
  for (const dir of temporaryDirectories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("verify-plugin-imports CLI（子进程真实执行）", () => {
  it("违规 fixture 退出 1 并输出违规描述", () => {
    const fixture = createFixture();
    writeFixtureFile(
      fixture,
      "packages/bad/src/violation.ts",
      [
        'import { app } from "../../src/server/app.js";',
        'import { SessionManager } from "@earendil-works/pi-coding-agent";',
        'import { x } from "@opencolorful/plugin-protocol/dist/index.js";',
        "export const used = [app, SessionManager, x];",
      ].join("\n"),
    );

    const result = runScript(fixture);

    // 修复前：入口判断恒为假、扫描不执行，此断言恒得 exit 0 —— 回归防线。
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("violation.ts");
    expect(result.stderr).toContain("import Server 内部实现");
    expect(result.stderr).toContain("import PI SDK");
    expect(result.stderr).toContain("import 协议包 dist 深路径");
  });

  it("干净 fixture 退出 0 并输出 OK", () => {
    const fixture = createFixture();
    writeFixtureFile(
      fixture,
      "packages/clean/src/index.ts",
      [
        'import type { PluginManifest } from "@opencolorful/plugin-protocol";',
        'import { helper } from "./helper.js";',
        "export const ok = helper;",
      ].join("\n"),
    );
    writeFixtureFile(fixture, "packages/clean/src/helper.ts", "export const helper = 1;\n");

    const result = runScript(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });
});

describe("findPluginImportViolations（直接调用）", () => {
  it("覆盖三类违规规则与 Server src/ 侧 dist 深路径规则", () => {
    const fixture = createFixture();
    writeFixtureFile(fixture, "packages/rel-bad/src/a.ts", 'import { app } from "../../src/server/app.js";\n');
    writeFixtureFile(fixture, "packages/pi-bad/src/b.ts", 'import { SessionManager } from "@earendil-works/pi-coding-agent";\n');
    writeFixtureFile(fixture, "packages/dist-bad/src/c.ts", 'import { x } from "@opencolorful/plugin-runtime/dist/index.js";\n');
    writeFixtureFile(fixture, "src/server-side.ts", 'import { y } from "@opencolorful/plugin-sdk/dist/index.js";\n');

    const violations = findPluginImportViolations(fixture);

    // 违规描述中的路径分隔符随平台变化，断言只用平台无关片段。
    expect(violations).toHaveLength(4);
    expect(violations.some((v) => v.includes("rel-bad") && v.includes("import Server 内部实现"))).toBe(true);
    expect(violations.some((v) => v.includes("pi-bad") && v.includes("import PI SDK"))).toBe(true);
    expect(violations.some((v) => v.includes("dist-bad") && v.includes("import 协议包 dist 深路径"))).toBe(true);
    expect(violations.some((v) => v.includes("server-side.ts") && v.includes("import 协议包 dist 深路径"))).toBe(true);
  });

  it("允许包名消费协议包与包内相对导入，不产生误报", () => {
    const fixture = createFixture();
    writeFixtureFile(
      fixture,
      "packages/clean/src/index.ts",
      [
        'import type { PluginManifest } from "@opencolorful/plugin-protocol";',
        'import { helper } from "./helper.js";',
        "export const ok = helper;",
      ].join("\n"),
    );
    writeFixtureFile(fixture, "packages/clean/src/helper.ts", "export const helper = 1;\n");

    expect(findPluginImportViolations(fixture)).toEqual([]);
  });
});
