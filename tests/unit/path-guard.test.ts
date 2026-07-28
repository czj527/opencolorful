import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathGuard } from "../../src/sandbox/path-guard.js";
import type {
  FileOperation,
  PathGuardPolicy,
} from "../../src/contracts/sandbox.js";

// ── helpers ──────────────────────────────────────────────────────────

let tempRoot: string;
let workspaceDir: string;
let blockedDir: string;
let readOnlyDir: string;

/**
 * 构建一个包含多条规则的测试用 policy。
 *
 * 规则（优先级从高到低）：
 *   1. blockedDir/  → BLOCKED
 *   2. readOnlyDir/ → READ_ONLY
 *   3. workspaceDir/ → FULL
 *   4. defaultLevel: BLOCKED（allowExternalReads: false）
 */
function makeTestPolicy(overrides: Partial<PathGuardPolicy> = {}): PathGuardPolicy {
  return {
    rules: [
      { path: blockedDir + path.sep, level: "BLOCKED", reason: "blocked subtree" },
      { path: readOnlyDir + path.sep, level: "READ_ONLY", reason: "read-only subtree" },
      { path: workspaceDir + path.sep, level: "FULL", reason: "workspace subtree" },
    ],
    defaultLevel: "BLOCKED",
    allowExternalReads: false,
    ...overrides,
  };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-pathguard-"));
  workspaceDir = path.join(tempRoot, "workspace");
  blockedDir = path.join(tempRoot, "blocked");
  readOnlyDir = path.join(tempRoot, "readonly");

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(readOnlyDir, { recursive: true });

  // 创建一些供测试用的真实文件
  fs.writeFileSync(path.join(workspaceDir, "file.txt"), "hello");
  fs.writeFileSync(path.join(blockedDir, "secret.txt"), "secret");
  fs.writeFileSync(path.join(readOnlyDir, "config.json"), "{}");
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ── tests ───────────────────────────────────────────────────────────

describe("PathGuard", () => {
  // ── 1. 精确路径匹配（FULL 区域允许 write）─────────────────────────
  it("allows write on a file inside a FULL subtree", () => {
    const guard = new PathGuard(makeTestPolicy());
    const target = path.join(workspaceDir, "file.txt");
    const result = guard.check("write", target);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe("FULL");
    expect(result.required).toBe("READ_WRITE");
  });

  // ── 2. 目录前缀匹配（/workspace/ 子树匹配）────────────────────────
  it("matches nested files inside a directory-prefix rule", () => {
    const guard = new PathGuard(makeTestPolicy());
    const nested = path.join(workspaceDir, "sub", "deep", "nested.txt");
    fs.mkdirSync(path.join(workspaceDir, "sub", "deep"), { recursive: true });
    fs.writeFileSync(nested, "data");

    const result = guard.check("read", nested);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe("FULL");
  });

  // ── 3. BLOCKED 区域拒绝 read ──────────────────────────────────────
  it("denies read on a file inside a BLOCKED subtree", () => {
    const guard = new PathGuard(makeTestPolicy());
    const target = path.join(blockedDir, "secret.txt");
    const result = guard.check("read", target);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe("BLOCKED");
  });

  // ── 4. READ_ONLY 区域允许 read、拒绝 write ────────────────────────
  it("allows read but denies write in a READ_ONLY subtree", () => {
    const guard = new PathGuard(makeTestPolicy());
    const target = path.join(readOnlyDir, "config.json");

    const readResult = guard.check("read", target);
    expect(readResult.allowed).toBe(true);
    expect(readResult.level).toBe("READ_ONLY");

    const writeResult = guard.check("write", target);
    expect(writeResult.allowed).toBe(false);
    expect(writeResult.level).toBe("READ_ONLY");
    expect(writeResult.required).toBe("READ_WRITE");
  });

  // ── 5. 符号链接解析：symlink 指向的 canonicalPath 匹配规则 ────────
  it("resolves symlinks and matches by canonical path", () => {
    const guard = new PathGuard(makeTestPolicy());
    // 在 tempRoot 下创建 symlink 指向 workspaceDir 下的文件
    const linkPath = path.join(tempRoot, "link-to-workspace-file");
    const realFile = path.join(workspaceDir, "file.txt");
    try {
      fs.symlinkSync(realFile, linkPath);
    } catch {
      // Windows 上非管理员可能无法创建 symlink，跳过此测试
      return;
    }

    const result = guard.check("read", linkPath);
    expect(result.allowed).toBe(true);
    // canonicalPath 应为真实路径（workspaceDir/file.txt），而非 symlink 路径
    expect(result.canonicalPath).toBe(fs.realpathSync(linkPath));
  });

  // ── 6. 不存在的路径：向上遍历到最近祖先，匹配祖先规则 ────────────
  it("matches non-existent paths by walking up to nearest existing ancestor", () => {
    const guard = new PathGuard(makeTestPolicy());
    // workspaceDir 存在，其子路径即使不存在也应按 workspaceDir 的 FULL 规则匹配
    const nonExistent = path.join(workspaceDir, "not-created-yet", "new-file.ts");

    const result = guard.check("read", nonExistent);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe("FULL");
    expect(result.canonicalPath).toBe(
      fs.realpathSync(workspaceDir) +
        path.sep +
        "not-created-yet" +
        path.sep +
        "new-file.ts",
    );
  });

  // ── 7. 多规则按优先级匹配（第一条命中生效）────────────────────────
  it("uses the first matching rule (priority order)", () => {
    // 规则：blockedDir/ (BLOCKED) 在前，workspaceDir/ (FULL) 在后
    // 但 blockedDir 不是 workspaceDir 的子目录，分别创建各自目录
    // 这里构造重叠规则来验证：先是一条 BLOCKED，再是一条 FULL（同目录）
    const overlapDir = path.join(tempRoot, "overlap");
    fs.mkdirSync(overlapDir, { recursive: true });
    const policy: PathGuardPolicy = {
      rules: [
        { path: overlapDir + path.sep, level: "BLOCKED", reason: "blocked first" },
        { path: overlapDir + path.sep, level: "FULL", reason: "full second" },
      ],
      defaultLevel: "BLOCKED",
      allowExternalReads: false,
    };
    const guard = new PathGuard(policy);
    const target = path.join(overlapDir, "anything.txt");

    // 第一条 BLOCKED 规则命中
    const result = guard.check("read", target);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe("BLOCKED");
  });

  // ── 8. defaultLevel 兜底（无规则匹配时）───────────────────────────
  it("falls back to defaultLevel when no rule matches", () => {
    const guard = new PathGuard(makeTestPolicy());
    // 某个不在任何规则范围内的路径
    const outsidePath = path.join(os.tmpdir(), "completely-outside.txt");
    const result = guard.check("read", outsidePath);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe("BLOCKED");
  });

  // ── 9. checkAll：全部通过 → 通过 ──────────────────────────────────
  it("checkAll returns allowed when all paths pass", () => {
    const guard = new PathGuard(makeTestPolicy());
    const paths = [
      path.join(workspaceDir, "a.txt"),
      path.join(workspaceDir, "b.txt"),
      path.join(workspaceDir, "c.txt"),
    ];
    const result = guard.checkAll("read", paths);
    expect(result.allowed).toBe(true);
    expect(result.level).toBe("FULL");
  });

  // ── 10. checkAll：有一条拒绝 → 拒绝 ───────────────────────────────
  it("checkAll returns denied as soon as one path is denied", () => {
    const guard = new PathGuard(makeTestPolicy());
    const paths = [
      path.join(workspaceDir, "ok.txt"),
      path.join(blockedDir, "secret.txt"), // 这条被拒绝
      path.join(workspaceDir, "also-ok.txt"),
    ];
    const result = guard.checkAll("read", paths);
    expect(result.allowed).toBe(false);
    expect(result.level).toBe("BLOCKED");
  });

  // ── 11. allowExternalReads 影响 read 兜底 ─────────────────────────
  it("upgrades default from BLOCKED to READ_ONLY for reads when allowExternalReads is true", () => {
    const policy = makeTestPolicy({
      defaultLevel: "BLOCKED",
      allowExternalReads: true,
    });
    const guard = new PathGuard(policy);
    const outsidePath = path.join(os.tmpdir(), "outside-read.txt");

    // read 操作：兜底应为 READ_ONLY
    const readResult = guard.check("read", outsidePath);
    expect(readResult.allowed).toBe(true);
    expect(readResult.level).toBe("READ_ONLY");

    // write 操作：allowExternalReads 不影响，兜底仍为 BLOCKED
    const writeResult = guard.check("write", outsidePath);
    expect(writeResult.allowed).toBe(false);
    expect(writeResult.level).toBe("BLOCKED");
  });

  // ── 12. delete 操作必须在 FULL 区域 ───────────────────────────────
  it("denies delete in READ_WRITE area (delete requires FULL)", () => {
    // 创建一个 READ_WRITE 区域但非 FULL
    const rwDir = path.join(tempRoot, "readwrite");
    fs.mkdirSync(rwDir, { recursive: true });
    const policy: PathGuardPolicy = {
      rules: [
        { path: rwDir + path.sep, level: "READ_WRITE", reason: "read-write area" },
      ],
      defaultLevel: "BLOCKED",
      allowExternalReads: false,
    };
    const guard = new PathGuard(policy);
    const target = path.join(rwDir, "file.txt");

    // read 和 write 应允许
    expect(guard.check("read", target).allowed).toBe(true);
    expect(guard.check("write", target).allowed).toBe(true);

    // delete 应拒绝（需要 FULL）
    const delResult = guard.check("delete", target);
    expect(delResult.allowed).toBe(false);
    expect(delResult.required).toBe("FULL");
    expect(delResult.level).toBe("READ_WRITE");
  });

  // ── 13. checkAll 空数组 ───────────────────────────────────────────
  it("checkAll with empty array returns allowed", () => {
    const guard = new PathGuard(makeTestPolicy());
    const result = guard.checkAll("read", []);
    expect(result.allowed).toBe(true);
  });

  // ── 14. 路径规范化：相对路径被 resolve 为绝对路径 ─────────────────
  it("normalizes relative paths via path.resolve", () => {
    const guard = new PathGuard(makeTestPolicy());
    // 切换到 workspaceDir，用相对路径调用 check
    const originalCwd = process.cwd();
    try {
      process.chdir(workspaceDir);
      const result = guard.check("read", "file.txt");
      expect(result.allowed).toBe(true);
      expect(result.level).toBe("FULL");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
