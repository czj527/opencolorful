import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assessPackageRisks, type SkillRiskMarker } from "../../../src/runtime/skills/installer/risk.js";
import { rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 风险标记（plans/phase-13.md §12.2；CLI validate/Web 详情共用）
//
// - scripts/ 目录 → scripts 标记（显著风险提示，不阻断）；
// - 禁止扩展名 → binary；未知扩展名 → unknown-file-type（默认拒绝）；
// - 干净包 → 无标记；标记绝不产生任何授权。
// ═══════════════════════════════════════════════════════════════

let workdir: string;

afterEach(() => {
  if (workdir !== undefined) {
    rmrf(workdir);
    workdir = "";
  }
});

function makeRoot(): string {
  workdir = tmpDir("ocf-risk-");
  fs.mkdirSync(path.join(workdir, "skill"), { recursive: true });
  return path.join(workdir, "skill");
}

function codes(markers: readonly SkillRiskMarker[]): readonly string[] {
  return markers.map((marker) => marker.code);
}

describe("assessPackageRisks", () => {
  it("干净包（只有 SKILL.md）无风险标记", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: x\n---\n", "utf8");
    expect(assessPackageRisks(root)).toHaveLength(0);
  });

  it("scripts/ 目录 → scripts 标记", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "run.sh"), "echo hi", "utf8");
    const markers = assessPackageRisks(root);
    expect(codes(markers)).toContain("scripts");
    const marker = markers.find((candidate) => candidate.code === "scripts");
    expect(marker?.message).toContain("Sandbox");
  });

  it("禁止扩展名（.exe）→ binary 标记（默认拒绝安装）", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "tool.exe"), "MZ", "utf8");
    const markers = assessPackageRisks(root);
    expect(codes(markers)).toContain("binary");
    expect(markers.find((candidate) => candidate.code === "binary")?.path).toBe("tool.exe");
  });

  it("未知扩展名（.xyz）→ unknown-file-type 标记", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "data.xyz"), "?", "utf8");
    const markers = assessPackageRisks(root);
    expect(codes(markers)).toContain("unknown-file-type");
  });

  it("遍历失败（符号链接）→ 返回空（让位于 validator 校验错误）", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: x\n---\n", "utf8");
    const linkTarget = path.join(workdir, "outside.txt");
    fs.writeFileSync(linkTarget, "外部", "utf8");
    try {
      fs.symlinkSync(linkTarget, path.join(root, "jump.txt"), "file");
    } catch {
      return; // 平台不允许符号链接时跳过
    }
    expect(assessPackageRisks(root)).toHaveLength(0);
  });
});
