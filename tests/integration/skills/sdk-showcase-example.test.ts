import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { skillRefKey } from "../../../src/contracts/skill-protocol.js";
import { packSkillPackage } from "../../../src/runtime/skills/pack.js";
import { cleanupT6Harnesses, createT6Harness, type T6Harness } from "../../unit/skills/t6-harness.js";
import { rmrf, tmpDir } from "../../unit/skills/helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 官方示例集成测试（plans/phase-13.md §15.3 / §18.6）
//
// examples/skills/sdk-showcase-skill → `skills pack`（真实 pack.ts）
// → session-file 登记 → SkillCoreService.install（与 CLI/Web 同一
// Service）→ 断言 installed、Catalog 登记、内容哈希与 pack 输出一致、
// 正文可经受控读取。
// ═══════════════════════════════════════════════════════════════

const EXAMPLE_DIR = path.resolve("examples/skills/sdk-showcase-skill");

let harness: T6Harness;
let workdir: string;

afterEach(() => {
  cleanupT6Harnesses();
  if (workdir !== undefined) {
    rmrf(workdir);
    workdir = "";
  }
});

describe("官方 sdk-showcase-skill 打包并安装", () => {
  it("pack → install → Catalog 登记，哈希与 pack 输出一致", async () => {
    expect(fs.existsSync(path.join(EXAMPLE_DIR, "SKILL.md"))).toBe(true);
    harness = createT6Harness();
    workdir = tmpDir("ocf-example-");

    // 1) 真实 `skills pack` 逻辑（pack.ts）
    const zipPath = path.join(workdir, "sdk-showcase-1.0.0.skill");
    const packed = packSkillPackage(EXAMPLE_DIR, zipPath);
    expect(packed.skillId).toBe("sdk-showcase-skill");
    expect(packed.version).toBe("1.0.0");
    expect(packed.fileCount).toBeGreaterThanOrEqual(3); // SKILL.md + references + templates
    expect(fs.statSync(zipPath).size).toBeGreaterThan(0);

    // 2) session-file 登记（安装器唯一接受的档案入口）
    const fileKey = harness.registerSessionZip(zipPath, "session-1");

    // 3) 与 CLI/Web 同一 SkillCoreService 安装
    const result = harness.core.install({
      sourceRef: fileKey,
      kind: "session-file",
      sessionId: "session-1",
      agentId: "agent-1",
    });
    expect(result.status).toBe("installed");

    // 4) Catalog 登记：精确 SkillRef，哈希与 pack 输出一致（不可伪造）
    const registered = harness.catalog.list({}).find((skill) => skill.skillId === "sdk-showcase-skill");
    expect(registered).toBeDefined();
    expect(registered?.skillRef.contentHash).toBe(packed.contentHash);
    expect(skillRefKey(registered!.skillRef)).toBe(result.skillRef !== undefined ? skillRefKey(result.skillRef) : "");

    // 5) 正文经受控读取（readBody 路径），references/templates 在包内
    const inspected = await harness.core.inspect({
      skillRef: registered!.skillRef,
      sessionId: "session-1",
      readBody: true,
    });
    expect(inspected.ok).toBe(true);
    expect(inspected.body).toContain("SDK Showcase Skill");
    expect(inspected.manifest?.name).toBe("SDK Showcase Skill");
  });

  it("示例包结构：references/templates 存在且无 scripts（纯 instruction-only）", () => {
    expect(fs.existsSync(path.join(EXAMPLE_DIR, "references", "checklist.md"))).toBe(true);
    expect(fs.existsSync(path.join(EXAMPLE_DIR, "templates", "report.md"))).toBe(true);
    expect(fs.existsSync(path.join(EXAMPLE_DIR, "scripts"))).toBe(false);
    expect(fs.existsSync(path.join(EXAMPLE_DIR, "README.md"))).toBe(true);
  });
});
