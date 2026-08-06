import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SkillRef } from "../../../src/contracts/skill-protocol.js";
import type { ResolveOutput } from "../../../src/runtime/skills/resolver.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { SkillContentService, type SkillActivationOverlayReader } from "../../../src/runtime/skills/content/skill-content-service.js";
import { SkillError } from "../../../src/runtime/skills/errors.js";
import { SkillPathError } from "../../../src/runtime/skills/path-safety.js";
import { SkillSnapshotService, type SkillSnapshot } from "../../../src/runtime/skills/snapshot/skill-snapshot.js";
import { createSkillPackage, ingestPackage, makeEnv, rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 SkillContentService 单元测试（tests/unit/skills/）
// ═══════════════════════════════════════════════════════════════

describe("SkillContentService", () => {
  let root: string;
  let catalog: SkillCatalog;
  let snapshots: SkillSnapshotService;
  let service: SkillContentService;
  let nowValue: Date;
  /** 测试注入的 readFile（默认走真实 bounded read） */
  let injectedRead: ((absPath: string, maxBytes: number) => Promise<Buffer>) | undefined;

  beforeEach(() => {
    root = tmpDir("ocf-content-");
    catalog = new SkillCatalog();
    nowValue = new Date("2026-01-01T00:00:00.000Z");
    snapshots = new SkillSnapshotService({ now: () => nowValue });
    injectedRead = undefined;
    service = new SkillContentService({
      catalog,
      snapshots,
      now: () => nowValue,
      budgets: {
        maxSingleFileBytes: 256 * 1024,
        maxSupportBytesPerTurn: 512 * 1024,
        contentReadTimeoutMs: 5000,
      },
      ...(injectedRead !== undefined ? { readFile: injectedRead } : {}),
    });
  });

  afterEach(() => {
    rmrf(root);
  });

  function resolveFor(agentId = "agent-1", pinnedRefs: readonly SkillRef[] = []): ResolveOutput {
    return catalog.listByAgent({ agentId, pinnedRefs, environment: makeEnv() });
  }

  function makeSnapshot(resolve: ResolveOutput = resolveFor()): SkillSnapshot {
    return snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: resolve,
    });
  }

  /** 建包（含 references 支持文件）+ 登记。 */
  function buildPackage(name: string, options: { readonly support?: string[]; readonly body?: string; readonly extraFrontmatter?: string } = {}) {
    const dir = createSkillPackage(root, { name, ...(options.body !== undefined ? { body: options.body } : {}), ...(options.extraFrontmatter !== undefined ? { extraFrontmatter: options.extraFrontmatter } : {}) });
    for (const rel of options.support ?? []) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `support:${rel}`, "utf8");
    }
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    // T11（P0-5）：managed 安装默认绑定当前 Agent → 固定引用进入解析（未绑定不进入可见集）
    return { dir, registered, resolve: resolveFor("agent-1", [registered.skillRef]) };
  }

  it("正常读取 SKILL.md：正文与包哈希匹配", async () => {
    const { registered, resolve } = buildPackage("alpha", { body: "这是 Skill 正文。" });
    const snapshot = makeSnapshot(resolve);
    const result = await service.readSkillBody({ snapshot, skillRef: registered.skillRef });
    expect(result.body).toContain("这是 Skill 正文。");
    expect(result.truncated).toBe(false);
    expect(result.snapshot).toBe(snapshot); // SKILL.md 不触发冻结新对象
    expect(result.fileHash).toMatch(/^sha256-/);
  });

  it("正常读取支持文件：首次访问冻结进 snapshot manifest，重读匹配同一哈希", async () => {
    const { registered, resolve } = buildPackage("alpha", { support: ["references/guide.md"] });
    const snapshot = makeSnapshot(resolve);
    const first = await service.readSkillBody({ snapshot, skillRef: registered.skillRef, relativePath: "references/guide.md" });
    expect(first.body).toBe("support:references/guide.md");
    expect(first.truncated).toBe(false);
    // 首读冻结：返回新快照，supportFiles 含条目
    expect(first.snapshot).not.toBe(snapshot);
    expect(first.snapshot.supportFiles).toHaveLength(1);
    expect(first.snapshot.supportFiles[0]?.relativePath).toBe("references/guide.md");
    expect(first.snapshot.supportFiles[0]?.fileHash).toBe(first.fileHash);

    // 重读：同一冻结哈希，返回原快照（幂等）
    const second = await service.readSkillBody({ snapshot: first.snapshot, skillRef: registered.skillRef, relativePath: "references/guide.md" });
    expect(second.body).toBe(first.body);
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.snapshot.supportFiles).toHaveLength(1);
  });

  it("重读时支持文件被改 → skill_content_hash_mismatch（首读冻结 fail-closed）", async () => {
    const { dir, registered, resolve } = buildPackage("alpha", { support: ["references/guide.md"] });
    const snapshot = makeSnapshot(resolve);
    const first = await service.readSkillBody({ snapshot, skillRef: registered.skillRef, relativePath: "references/guide.md" });
    fs.writeFileSync(path.join(dir, "references/guide.md"), "tampered!", "utf8");
    await expect(
      service.readSkillBody({ snapshot: first.snapshot, skillRef: registered.skillRef, relativePath: "references/guide.md" }),
    ).rejects.toMatchObject({ code: "skill_content_hash_mismatch" });
  });

  it("SKILL.md 被改 → skill_content_hash_mismatch（包哈希校验）", async () => {
    const { dir, registered, resolve } = buildPackage("alpha");
    const snapshot = makeSnapshot(resolve);
    const skillMd = path.join(dir, "SKILL.md");
    fs.writeFileSync(skillMd, `${fs.readFileSync(skillMd, "utf8")}\n-- tampered --\n`, "utf8");
    await expect(service.readSkillBody({ snapshot, skillRef: registered.skillRef })).rejects.toMatchObject({
      code: "skill_content_hash_mismatch",
    });
  });

  it("Snapshot 之外的 SkillRef → skill_not_in_snapshot（fail-closed）", async () => {
    const { resolve } = buildPackage("alpha");
    const other = createSkillPackage(root, { name: "beta", version: "1.0.0" });
    const otherRegistered = ingestPackage(catalog, other, "managed", makeEnv());
    // snapshot 在 beta 登记前冻结 → beta 不在可见集
    const snapshot = makeSnapshot(resolve);
    await expect(service.readSkillBody({ snapshot, skillRef: otherRegistered.skillRef })).rejects.toMatchObject({
      code: "skill_not_in_snapshot",
    });
  });

  it("路径逃逸（.. 穿越/绝对路径）→ skill_path_escape", async () => {
    const { registered, resolve } = buildPackage("alpha");
    const snapshot = makeSnapshot(resolve);
    await expect(
      service.readSkillBody({ snapshot, skillRef: registered.skillRef, relativePath: "../secret.txt" }),
    ).rejects.toBeInstanceOf(SkillPathError);
    await expect(
      service.readSkillBody({ snapshot, skillRef: registered.skillRef, relativePath: "C:/windows/evil.txt" }),
    ).rejects.toBeInstanceOf(SkillPathError);
  });

  it("源文件消失 → skill_content_missing（fail-closed）", async () => {
    const { dir, registered, resolve } = buildPackage("alpha", { support: ["references/guide.md"] });
    const snapshot = makeSnapshot(resolve);
    fs.rmSync(path.join(dir, "references"), { recursive: true, force: true });
    await expect(
      service.readSkillBody({ snapshot, skillRef: registered.skillRef, relativePath: "references/guide.md" }),
    ).rejects.toMatchObject({ code: "skill_content_missing" });
  });

  it("单文件超限 → skill_content_too_large 截断并标记 truncated（single_file）", async () => {
    service = new SkillContentService({
      catalog,
      snapshots,
      now: () => nowValue,
      budgets: { maxSingleFileBytes: 32, maxSupportBytesPerTurn: 512, contentReadTimeoutMs: 5000 },
    });
    const dir = path.join(root, "big-skill");
    fs.mkdirSync(dir, { recursive: true });
    const lines = ["---", "name: big", "description: big skill", "---", "x".repeat(100)];
    fs.writeFileSync(path.join(dir, "SKILL.md"), lines.join("\n"), "utf8");
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const snapshot = makeSnapshot(resolveFor("agent-1", [registered.skillRef]));
    const result = await service.readSkillBody({ snapshot, skillRef: registered.skillRef });
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe("single_file");
    expect(result.body.length).toBeLessThanOrEqual(32);
  });

  it("每轮支持文件总量超限 → 截断并标记 truncated（turn_budget）", async () => {
    service = new SkillContentService({
      catalog,
      snapshots,
      now: () => nowValue,
      budgets: { maxSingleFileBytes: 256 * 1024, maxSupportBytesPerTurn: 64, contentReadTimeoutMs: 5000 },
    });
    const dir = path.join(root, "multi");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: multi\ndescription: multi\n---\nbody", "utf8");
    fs.writeFileSync(path.join(dir, "a.md"), "a".repeat(50), "utf8");
    fs.writeFileSync(path.join(dir, "b.md"), "b".repeat(50), "utf8");
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const snapshot = makeSnapshot(resolveFor("agent-1", [registered.skillRef]));

    const first = await service.readSkillBody({ snapshot, skillRef: registered.skillRef, relativePath: "a.md" });
    expect(first.truncated).toBe(false);
    expect(first.body).toHaveLength(50);

    const second = await service.readSkillBody({ snapshot: first.snapshot, skillRef: registered.skillRef, relativePath: "b.md" });
    expect(second.truncated).toBe(true);
    expect(second.truncatedReason).toBe("turn_budget");
    expect(second.body).toHaveLength(64 - 50);
  });

  it("支持文件重读不重复计费（冻结内容同一 turn 可重读）", async () => {
    service = new SkillContentService({
      catalog,
      snapshots,
      now: () => nowValue,
      budgets: { maxSingleFileBytes: 256 * 1024, maxSupportBytesPerTurn: 60, contentReadTimeoutMs: 5000 },
    });
    const dir = path.join(root, "budget");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: budget\ndescription: b\n---\nbody", "utf8");
    fs.writeFileSync(path.join(dir, "a.md"), "a".repeat(50), "utf8");
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const snapshot = makeSnapshot(resolveFor("agent-1", [registered.skillRef]));

    const first = await service.readSkillBody({ snapshot, skillRef: registered.skillRef, relativePath: "a.md" });
    expect(first.body).toHaveLength(50);
    // 重读同一文件：不消耗新预算，返回冻结内容
    const reread = await service.readSkillBody({ snapshot: first.snapshot, skillRef: registered.skillRef, relativePath: "a.md" });
    expect(reread.body).toHaveLength(50);
    expect(reread.truncated).toBe(false);
  });

  it("读取超时 → skill_content_read_denied（fail-closed）", async () => {
    service = new SkillContentService({
      catalog,
      snapshots,
      now: () => nowValue,
      budgets: { maxSingleFileBytes: 256 * 1024, maxSupportBytesPerTurn: 512 * 1024, contentReadTimeoutMs: 20 },
      readFile: async (absPath) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
        return Buffer.from(fs.readFileSync(absPath));
      },
    });
    const { registered, resolve } = buildPackage("alpha");
    const snapshot = makeSnapshot(resolve);
    await expect(service.readSkillBody({ snapshot, skillRef: registered.skillRef })).rejects.toMatchObject({
      code: "skill_content_read_denied",
    });
  });

  it("loadHandle 绑定不符 → skill_content_read_denied", async () => {
    const { registered, resolve } = buildPackage("alpha");
    const other = createSkillPackage(root, { name: "beta", version: "1.0.0" });
    const otherRegistered = ingestPackage(catalog, other, "managed", makeEnv());
    const snapshot = makeSnapshot(resolve);
    await expect(
      service.readSkillBody({
        snapshot,
        skillRef: registered.skillRef,
        handle: { skillRef: otherRegistered.skillRef, contentHash: otherRegistered.skillRef.contentHash },
      }),
    ).rejects.toMatchObject({ code: "skill_content_read_denied" });
  });

  it("激活授权 overlay：快照冻结摘要授权读取（未消费未过期）", async () => {
    const dir = path.join(root, "granted");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: granted\ndescription: g\n---\nbody", "utf8");
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const refKey = `${registered.skillRef.skillId}@${registered.skillRef.sourceId}@${registered.skillRef.version}`;
    // 空可见集 + 冻结授权摘要 → 仍可读取（overlay 精确 Ref）
    const snapshot = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: { visible: [], shadowed: [], disabled: [], gated: [], diagnostics: [] },
      activationGrants: [
        {
          grantId: "grant-1",
          agentId: "agent-1",
          sessionId: "session-1",
          skillRefKey: refKey,
          contentHash: registered.skillRef.contentHash,
          issuedTurnId: "turn-1",
          expiresAt: "2026-01-02T00:00:00.000Z",
          consumedAt: null,
          reason: "test",
        },
      ],
    });
    const result = await service.readSkillBody({ snapshot, skillRef: registered.skillRef });
    expect(result.body).toContain("body");
  });

  it("激活授权已过期 → skill_not_in_snapshot（fail-closed）", async () => {
    const dir = path.join(root, "granted-expired");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: expired\ndescription: e\n---\nbody", "utf8");
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const refKey = `${registered.skillRef.skillId}@${registered.skillRef.sourceId}@${registered.skillRef.version}`;
    const snapshot = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: { visible: [], shadowed: [], disabled: [], gated: [], diagnostics: [] },
      activationGrants: [
        {
          grantId: "grant-expired",
          agentId: "agent-1",
          sessionId: "session-1",
          skillRefKey: refKey,
          contentHash: registered.skillRef.contentHash,
          issuedTurnId: "turn-1",
          expiresAt: "2025-12-31T00:00:00.000Z",
          consumedAt: null,
          reason: "test",
        },
      ],
    });
    await expect(service.readSkillBody({ snapshot, skillRef: registered.skillRef })).rejects.toMatchObject({
      code: "skill_not_in_snapshot",
    });
  });

  it("实时 overlay（当前 turn 签发、未过期）授权读取", async () => {
    const dir = path.join(root, "live-overlay");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: live\ndescription: l\n---\nbody", "utf8");
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const refKey = `${registered.skillRef.skillId}@${registered.skillRef.sourceId}@${registered.skillRef.version}`;
    const snapshot = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: { visible: [], shadowed: [], disabled: [], gated: [], diagnostics: [] },
    });
    const overlay: SkillActivationOverlayReader = {
      listBySession: () => [
        {
          grantId: "grant-live",
          agentId: "agent-1",
          sessionId: "session-1",
          skillRefKey: refKey,
          contentHash: registered.skillRef.contentHash,
          issuedTurnId: "turn-1",
          expiresAt: "2026-01-02T00:00:00.000Z",
          consumedAt: "2026-01-01T00:00:01.000Z",
          reason: "session-install",
        },
      ],
    };
    service = new SkillContentService({ catalog, snapshots, grants: overlay, now: () => nowValue });
    const result = await service.readSkillBody({ snapshot, skillRef: registered.skillRef });
    expect(result.body).toContain("body");
  });

  it("SkillError 错误码稳定（reasonCode 来自冻结枚举）", async () => {
    const { registered, resolve } = buildPackage("alpha");
    const snapshot = makeSnapshot(resolve);
    const other = createSkillPackage(root, { name: "gamma", version: "1.0.0" });
    const otherRegistered = ingestPackage(catalog, other, "managed", makeEnv());
    await expect(service.readSkillBody({ snapshot, skillRef: otherRegistered.skillRef })).rejects.toMatchObject({
      code: "skill_not_in_snapshot",
    });
    expect(registered.skillRef.contentHash).toMatch(/^sha256-/);
  });
});
