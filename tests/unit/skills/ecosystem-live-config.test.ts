import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 live 测试配置校验（默认 CI 内运行，不发起任何网络请求）
//
// 保证 §18.7 的门禁语义：
// - `test:skills-live` 脚本存在（可选 live 入口）；
// - 默认 vitest include（tests/**/*.test.ts）不匹配 tests/skills-live/*.live.ts，
//   即默认 `npm test` 绝不加载 live 测试（不请求外网）；
// - LOCKFILE.json 结构合法（锁定版本 + 内容哈希 + 文件清单）。
// ═══════════════════════════════════════════════════════════════

const ROOT = path.resolve(".");

describe("skills-live 配置（默认 CI，离线）", () => {
  it("package.json 提供 test:skills-live 脚本", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["test:skills-live"]).toBe("vitest run --config vitest.live.config.ts");
  });

  it("默认 include 不匹配 .live.ts（npm test 不跑 live）", () => {
    const config = fs.readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain('include: ["tests/**/*.test.ts"]');
    const liveConfig = fs.readFileSync(path.join(ROOT, "vitest.live.config.ts"), "utf8");
    expect(liveConfig).toContain("tests/skills-live/**/*.live.ts");
    expect(liveConfig).toContain('OPENCOLORFUL_LIVE');
    // live 测试文件带 skipIf 双保险：缺 env 时即使被加载也跳过
    const liveTest = fs.readFileSync(path.join(ROOT, "tests", "skills-live", "live-skills.live.ts"), "utf8");
    expect(liveTest).toContain("describe.skipIf");
  });

  it("LOCKFILE.json 结构合法：锁定版本 + 内容哈希 + 文件清单", () => {
    const lockfile = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "skills-live", "LOCKFILE.json"), "utf8")) as {
      version: number;
      entries: Array<{
        id: string;
        ecosystem: string;
        version: string;
        license: string;
        pinnedCommit: string;
        downloadBase: string;
        files: string[];
        packageHash: string;
        verified: boolean;
      }>;
    };
    expect(lockfile.version).toBe(1);
    expect(lockfile.entries.length).toBeGreaterThan(0);
    const verified = lockfile.entries.filter((entry) => entry.verified);
    expect(verified.length).toBeGreaterThan(0);
    for (const entry of lockfile.entries) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(["openclaw", "hermes"]).toContain(entry.ecosystem);
      expect(entry.license.length).toBeGreaterThan(0);
      expect(entry.files.length).toBeGreaterThan(0);
      expect(entry.downloadBase.startsWith("https://")).toBe(true);
      if (entry.verified) {
        expect(entry.pinnedCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(entry.packageHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
