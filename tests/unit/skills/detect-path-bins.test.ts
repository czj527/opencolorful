import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectPathBins } from "../../../src/runtime/skills/composition.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T11（P1-6）detectPathBins 上限测试
// - 单目录上限 500、全 PATH 上限 5000（per-dir 配额，不跨目录累计）：
//   超大目录占满全局配额会把后续目录（如 git 所在目录）挤出检测结果，
//   P1-6 要求上限按目录分配，检测语义不随 PATH 目录数量劣化。
// ═══════════════════════════════════════════════════════════════

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ocf-pathbins-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** 按平台生成可检测的 bin 文件名（win32 需要 .exe 后缀）。 */
function binName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/** 在目录内创建 count 个空文件，文件名为 seq-<index>（带平台后缀）。 */
function fillFiles(dir: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(dir, binName(`seq-${index}`)), "", "utf8");
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withPath(entries: readonly string[], fn: () => string[]): string[] {
  const previous = process.env.PATH;
  process.env.PATH = entries.join(path.delimiter);
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previous;
    }
  }
}

describe("detectPathBins（P1-6）", () => {
  it("超大目录不挤占后续目录：git 所在目录仍被检测（回归验收场景）", () => {
    // 目录 A：600 个文件（超过单目录 500 上限；后 100 个不应被扫描）
    const dirA = makeDir("a");
    fillFiles(dirA, 600);
    // 目录 B：git（旧实现全局 2000 上限会被 A 的大目录挤掉；新实现按目录分配）
    const dirB = makeDir("b");
    fs.writeFileSync(path.join(dirB, binName("git")), "", "utf8");

    const bins = withPath([dirA, dirB], () => detectPathBins());
    expect(bins).toContain("git");
    // 目录 A 第 501+ 个文件被单目录上限截断（seq-500/seq-599 不应出现）
    expect(bins).not.toContain("seq-599");
  });

  it("单目录上限 500：前 500 个正常进入，超出的不进入", () => {
    const dir = makeDir("c");
    fillFiles(dir, 501);
    fs.writeFileSync(path.join(dir, binName("tail-marker")), "", "utf8"); // 第 502 个

    const bins = withPath([dir], () => detectPathBins());
    expect(bins).toContain("seq-499"); // 第 500 个（0 起始）→ 进入
    expect(bins).not.toContain("tail-marker"); // 超出 500 → 截断
  });

  it("全 PATH 上限 5000：前 10 个目录各 500 后，第 11 个目录不再扫描", () => {
    const many: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const dir = makeDir(`d${index}`);
      fillFiles(dir, 500);
      many.push(dir);
    }
    const last = makeDir("last");
    fs.writeFileSync(path.join(last, binName("never-seen")), "", "utf8");

    const bins = withPath([...many, last], () => detectPathBins());
    expect(bins).toContain("seq-0"); // 前 10 目录正常
    expect(bins).not.toContain("never-seen"); // 配额用尽 → 第 11 目录跳过
  });

  it("空/不存在/不可读目录跳过，不误判", () => {
    const missing = path.join(os.tmpdir(), `ocf-pathbins-missing-${Date.now()}`);
    const good = makeDir("e");
    fs.writeFileSync(path.join(good, binName("node")), "", "utf8");

    const bins = withPath([missing, "", good], () => detectPathBins());
    expect(bins).toContain("node");
  });
});
