import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OpenClawSkillSource } from "../../src/runtime/skills/sources/openclaw-skill-source.js";
import { HermesSkillSource } from "../../src/runtime/skills/sources/hermes-skill-source.js";
import type { SkillSourceAdapter } from "../../src/runtime/skills/sources/skill-source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T9 可选 Live 测试（plans/phase-13.md §18.7 / §15.2）
//
// - 只通过 `npm run test:skills-live` 运行（vitest.live.config.ts 注入
//   OPENCOLORFUL_LIVE=1）；默认 `npm test` 不加载本文件（.live.ts 后缀
//   不在默认 include 内），双重保护下也不发起任何网络请求；
// - 使用 LOCKFILE.json 中"锁定版本 + 内容哈希"的真实 instruction-only 包：
//   verified=true 条目下载后必须哈希一致（安全红线，失败即 fail）；
//   网络不可达 / verified=false 条目只输出兼容性/网络诊断并跳过——
//   live 失败绝不污染默认质量门；
// - 全程使用临时目录（镜像 + OPENCOLORFUL_HOME 语义），结束后清理；
// - 不依赖个人凭据/付费 API（候选包均 MIT + 纯指令 + Windows 可用）。
// ═══════════════════════════════════════════════════════════════

interface LiveLockEntry {
  readonly id: string;
  readonly ecosystem: "openclaw" | "hermes";
  readonly displayName: string;
  readonly version: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly sourceUrl: string;
  readonly pinnedCommit: string;
  readonly downloadBase: string;
  /** 上游仓库内包目录前缀（files 剥离该前缀后即镜像条目内相对路径） */
  readonly packagePrefix: string;
  readonly files: readonly string[];
  readonly packageHash: string;
  readonly instructionsOnly: boolean;
  readonly windowsOk: boolean;
  readonly paywall: string;
  readonly verified: boolean;
  readonly note?: string;
}

interface LiveLockfile {
  readonly version: number;
  readonly note: string;
  readonly entries: readonly LiveLockEntry[];
}

const LOCKFILE_PATH = path.resolve("tests/skills-live/LOCKFILE.json");

function loadLockfile(): LiveLockfile {
  const parsed = JSON.parse(fs.readFileSync(LOCKFILE_PATH, "utf8")) as LiveLockfile;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("LOCKFILE.json 结构非法（version 必须是 1，entries 必须是数组）");
  }
  return parsed;
}

/** 锁定哈希：按排序条目相对路径 + \0 + 字节 拼接后的 sha256（与 LOCKFILE 一致）。 */
function computePackageHash(entryDir: string, files: readonly string[]): string {
  const h = crypto.createHash("sha256");
  for (const rel of [...files].sort()) {
    h.update(rel + "\0");
    h.update(fs.readFileSync(path.join(entryDir, rel)));
  }
  return h.digest("hex");
}

/** curl 下载单个文件（失败抛错，由调用方转诊断）。 */
function downloadFile(url: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync(
    "curl",
    ["--silent", "--show-error", "--location", "--fail", "--max-time", "60", "--output", dest, url],
    { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** 条目内相对路径 = 上游文件路径剥离 packagePrefix（镜像条目根须含 SKILL.md）。 */
function entryRelativePath(entry: LiveLockEntry, upstreamPath: string): string {
  const prefix = entry.packagePrefix.replace(/\/+$/, "");
  if (upstreamPath === prefix) {
    throw new Error(`LOCKFILE 条目 ${entry.id}：file 与 packagePrefix 相同（缺文件）`);
  }
  if (!upstreamPath.startsWith(`${prefix}/`)) {
    throw new Error(`LOCKFILE 条目 ${entry.id}：文件 ${upstreamPath} 不在 packagePrefix（${prefix}）内`);
  }
  return upstreamPath.slice(prefix.length + 1);
}

/** 下载锁定的包到镜像条目目录（mirror/<id>@<version>/），校验 packageHash。 */
function buildMirrorEntry(entry: LiveLockEntry, mirrorRoot: string): string {
  const entryDir = path.join(mirrorRoot, `${entry.id}@${entry.version}`);
  fs.mkdirSync(entryDir, { recursive: true });
  for (const rel of entry.files) {
    const url = `${entry.downloadBase}${rel}`;
    const dest = path.join(entryDir, entryRelativePath(entry, rel));
    downloadFile(url, dest);
    if (fs.statSync(dest).size === 0) {
      throw new Error(`下载内容为空：${url}`);
    }
  }
  const entryFiles = entry.files.map((rel) => entryRelativePath(entry, rel));
  if (!entryFiles.includes("SKILL.md")) {
    throw new Error(`LOCKFILE 条目 ${entry.id}：剥离前缀后缺少 SKILL.md（不是完整包）`);
  }
  const actual = computePackageHash(entryDir, entryFiles);
  if (actual !== entry.packageHash) {
    throw new Error(
      `锁定哈希不匹配：${entry.id}（期望 ${entry.packageHash.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）。` +
        "内容被篡改或 pin 失效，拒绝继续（安全红线）；请核对 pinnedCommit 后回填 LOCKFILE",
    );
  }
  return entryDir;
}

function adapterFor(entry: LiveLockEntry, mirrorRoot: string): SkillSourceAdapter {
  if (entry.ecosystem === "openclaw") {
    return new OpenClawSkillSource({ registryDir: mirrorRoot });
  }
  return new HermesSkillSource({ registryDir: mirrorRoot });
}

/** 单个条目流程：下载 → 哈希校验 → discover → inspect（兼容等级）→ stage → 清理。 */
function runEntry(entry: LiveLockEntry): string[] {
  const diagnostics: string[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-live-"));
  try {
    const mirrorRoot = path.join(root, "mirror");
    const entryDir = buildMirrorEntry(entry, mirrorRoot);
    const adapter = adapterFor(entry, mirrorRoot);
    const sourceRef = `${entry.ecosystem}:${entry.id}@${entry.version}`;

    // discover（skills_list 语义）
    const candidates = adapter.discover(entry.id);
    expect(candidates.some((candidate) => candidate.sourceId === sourceRef)).toBe(true);

    // inspect（skill_view 语义）：兼容等级必须落入受支持集合
    const inspection = adapter.inspect(sourceRef);
    const level = inspection.manifest?.compatibilityLevel;
    expect(level).toBeDefined();
    expect(["native", "pi-compatible", "openclaw", "hermes"]).toContain(level);
    diagnostics.push(`[skills-live] ${entry.id}: 兼容等级 ${level}（license=${entry.license}，version=${entry.version}）`);
    if (inspection.compatibility !== null && inspection.compatibility.missing.length > 0) {
      diagnostics.push(`[skills-live] ${entry.id}: 兼容诊断 missing=${inspection.compatibility.missing.join(",")}`);
    }

    // 纯指令包：不得携带 scripts/ 风险
    const risks = inspection.risks ?? [];
    expect(risks.some((risk) => risk.code === "scripts")).toBe(false);

    // stage：兼容边界拒绝时必须是带迁移建议的稳定错误（不允许静默空壳）
    let stagedOk = false;
    try {
      const staged = adapter.stage(sourceRef, { stagingRoot: path.join(root, "staging") });
      expect(staged.contentHash).toMatch(/^sha256-[0-9a-f]{57}$/);
      expect(staged.packageRoot).toContain(path.join(root, "staging"));
      stagedOk = true;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unknown";
      const message = error instanceof Error ? error.message : String(error);
      expect(code).toBe("skill_package_invalid");
      expect(message).toContain("迁移建议");
      diagnostics.push(`[skills-live] ${entry.id}: 兼容失败（${code}），已按迁移建议拒绝，未生成空壳`);
    }
    diagnostics.push(`[skills-live] ${entry.id}: stage ${stagedOk ? "成功" : "拒绝"}（哈希已复核 ${entry.packageHash.slice(0, 12)}…）`);
    expect(entryDir.startsWith(mirrorRoot)).toBe(true);
    return diagnostics;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

const LIVE_MODE = process.env.OPENCOLORFUL_LIVE === "1";

describe.skipIf(!LIVE_MODE)("skills-live：真实生态包（锁定版本 + 哈希）", () => {
  it("LOCKFILE.json 结构合法", () => {
    const lockfile = loadLockfile();
    expect(lockfile.entries.length).toBeGreaterThan(0);
    for (const entry of lockfile.entries) {
      expect(entry.files.length).toBeGreaterThan(0);
      expect(entry.downloadBase.startsWith("https://")).toBe(true);
      expect(["openclaw", "hermes"]).toContain(entry.ecosystem);
    }
  });

  it("verified 条目：下载 → 哈希校验 → 发现 → 检查 → 暂存（网络失败仅诊断，不 fail 默认门）", () => {
    const lockfile = loadLockfile();
    const verified = lockfile.entries.filter((entry) => entry.verified);
    expect(verified.length).toBeGreaterThan(0);
    const diagnostics: string[] = [];
    let hadNetworkFailure = false;
    for (const entry of verified) {
      try {
        diagnostics.push(...runEntry(entry));
      } catch (error) {
        const isNetworkFailure = /curl|下载|网络|ENOTFOUND|ECONNREFUSED|超时|timeout/i.test(error instanceof Error ? error.message : String(error));
        if (isNetworkFailure) {
          hadNetworkFailure = true;
          diagnostics.push(`[skills-live] ${entry.id}: 网络/下载诊断（跳过，不 fail 默认门）：${error instanceof Error ? error.message : String(error)}`);
        } else {
          throw error; // 哈希不匹配等安全红线：必须失败
        }
      }
    }
    // 输出诊断（结果可由人工核对；网络失败不改变测试结论）
    for (const line of diagnostics) {
      console.log(line);
    }
    expect(hadNetworkFailure || diagnostics.length > 0).toBe(true);
  });

  it("unverified 条目：只输出诊断并跳过（提示如何验证后回填）", () => {
    const lockfile = loadLockfile();
    const unverified = lockfile.entries.filter((entry) => !entry.verified);
    for (const entry of unverified) {
      console.log(`[skills-live] ${entry.id}: 未验证锁定条目，跳过。验证步骤见 tests/skills-live/README.md（${entry.sourceUrl}）`);
    }
    expect(unverified.length).toBeGreaterThan(0);
  });
});
