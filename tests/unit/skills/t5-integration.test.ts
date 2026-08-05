import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPiSkillsFromSnapshot } from "../../../src/pi-sdk/skill-loader.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { LoadHandleRegistry } from "../../../src/runtime/skills/content/load-handle.js";
import { SkillContentService } from "../../../src/runtime/skills/content/skill-content-service.js";
import { SkillSnapshotService } from "../../../src/runtime/skills/snapshot/skill-snapshot.js";
import { createSkillPackage, ingestPackage, makeEnv, makeSkillPackageAt, rmrf, tmpDir } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 集成链路测试（tests/unit/skills/）
// ResolveOutput → Snapshot → PI loader → ContentService → loadHandle
// ═══════════════════════════════════════════════════════════════

describe("T5 集成：Resolve → Snapshot → PI loader → ContentService → loadHandle", () => {
  let root: string;
  let catalog: SkillCatalog;
  let snapshots: SkillSnapshotService;
  let content: SkillContentService;
  let handles: LoadHandleRegistry;
  let nowValue: Date;

  beforeEach(() => {
    root = tmpDir("ocf-t5-integration-");
    catalog = new SkillCatalog();
    nowValue = new Date("2026-01-01T00:00:00.000Z");
    snapshots = new SkillSnapshotService({ now: () => nowValue });
    content = new SkillContentService({ catalog, snapshots, now: () => nowValue });
    handles = new LoadHandleRegistry({ now: () => nowValue });
  });

  afterEach(() => {
    rmrf(root);
  });

  it("完整链路：解析 → 快照 → PI pointer → 受控读取（SKILL.md + 支持文件）", async () => {
    // 1. 建包并登记（SKILL.md + references/guide.md 一起参与包哈希）
    const dir = createSkillPackage(root, { name: "chain", description: "链路 Skill", version: "1.0.0", body: "链路正文" });
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "guide.md"), "# Guide\n详情内容", "utf8");
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());

    // 2. 解析 → 快照
    const resolve = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [], environment: makeEnv() });
    expect(resolve.visible).toHaveLength(1);
    const snapshot = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: resolve,
    });

    // 3. 快照 → PI Skill pointer（元数据只含指针，不含正文）
    const { skills } = buildPiSkillsFromSnapshot(snapshot);
    expect(skills).toHaveLength(1);
    const pointer = skills[0];
    if (pointer === undefined) throw new Error("pointer 为空");
    expect(pointer.name).toBe("chain");
    expect(pointer.description).toBe("链路 Skill");
    expect(pointer.filePath.endsWith("SKILL.md")).toBe(true);
    expect(pointer.sourceInfo.source).toBe(
      `${registered.skillRef.skillId}@${registered.skillRef.sourceId}@${registered.skillRef.version}`,
    );

    // 4. ContentService 受控读取（模型按 filePath 读取时经过的入口）
    const body = await content.readSkillBody({ snapshot, skillRef: registered.skillRef });
    expect(body.body).toContain("链路正文");
    const guide = await content.readSkillBody({ snapshot: body.snapshot, skillRef: registered.skillRef, relativePath: "references/guide.md" });
    expect(guide.body).toBe("# Guide\n详情内容");
    expect(guide.snapshot.supportFiles).toHaveLength(1);
    expect(guide.snapshot.supportFiles[0]?.relativePath).toBe("references/guide.md");
  });

  it("loadHandle 全流程：签发 → 消费 → 受控读取（哈希仍校验）", async () => {
    const dir = createSkillPackage(root, { name: "handle-skill", version: "1.0.0" });
    const registered = ingestPackage(catalog, dir, "managed", makeEnv());
    const resolve = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [], environment: makeEnv() });
    const snapshot = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: resolve,
    });

    // 签发 + 消费（模拟会话内安装后的受控读取）
    const handle = handles.issueLoadHandle({
      turnId: "turn-1",
      sessionId: "session-1",
      skillRef: registered.skillRef,
      contentHash: registered.skillRef.contentHash,
      ttlMs: 60_000,
    });
    const consume = handles.consumeLoadHandle({ handleId: handle.handleId, turnId: "turn-1", sessionId: "session-1" });
    expect(consume.status).toBe("granted");
    if (consume.status !== "granted") throw new Error("消费失败");

    const result = await content.readSkillBody({
      snapshot,
      skillRef: registered.skillRef,
      handle: consume.handle,
    });
    expect(result.body).toContain("这是 Skill 正文。");

    // 重放被拒（一次性）
    const replay = handles.consumeLoadHandle({ handleId: handle.handleId, turnId: "turn-1", sessionId: "session-1" });
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") {
      expect(replay.reasonCode).toBe("skill_load_handle_consumed");
    }

    // 即使持有有效 handle，内容被篡改仍 fail-closed（哈希校验在 ContentService）
    const tampered = createSkillPackage(root, { name: "tamper-skill", version: "1.0.0" });
    const tamperRegistered = ingestPackage(catalog, tampered, "managed", makeEnv());
    const tamperResolve = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [], environment: makeEnv() });
    const tamperSnapshot = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: tamperResolve,
    });
    const tamperHandle = handles.issueLoadHandle({
      turnId: "turn-1",
      sessionId: "session-1",
      skillRef: tamperRegistered.skillRef,
      contentHash: tamperRegistered.skillRef.contentHash,
      ttlMs: 60_000,
    });
    handles.consumeLoadHandle({ handleId: tamperHandle.handleId, turnId: "turn-1", sessionId: "session-1" });
    fs.writeFileSync(path.join(tampered, "SKILL.md"), "---\nname: tamper-skill\ndescription: d\n---\nEVIL", "utf8");
    await expect(
      content.readSkillBody({ snapshot: tamperSnapshot, skillRef: tamperRegistered.skillRef, handle: tamperHandle }),
    ).rejects.toMatchObject({ code: "skill_content_hash_mismatch" });
  });

  it("会话内安装不修改已开始的 Snapshot（旧快照仍按冻结 Ref 读取）", async () => {
    // turn-1 开始时只有 v1
    const dirV1 = createSkillPackage(root, { name: "evolving", version: "1.0.0", body: "v1 正文" });
    const v1 = ingestPackage(catalog, dirV1, "managed", makeEnv());
    const snapshotTurn1 = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      resolveOutput: catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [], environment: makeEnv() }),
    });

    // 会话内安装 v2（新版本登记到不同目录，snapshotId 不变，旧快照不修改）
    const dirV2 = makeSkillPackageAt(root, "v2/evolving", { name: "evolving", version: "2.0.0", body: "v2 正文" });
    ingestPackage(catalog, dirV2, "managed", makeEnv());
    const turn2Resolve = catalog.listByAgent({ agentId: "agent-1", pinnedRefs: [], environment: makeEnv() });
    const snapshotTurn2 = snapshots.createSkillSnapshot({
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-2",
      resolveOutput: turn2Resolve,
    });
    expect(snapshotTurn2.snapshotId).not.toBe(snapshotTurn1.snapshotId);
    expect(snapshotTurn2.entries[0]?.skillRef.version).toBe("2.0.0");
    // 旧快照冻结的 v1 Ref 仍可读取（fail-closed 哈希校验 v1 包）
    const oldRead = await content.readSkillBody({ snapshot: snapshotTurn1, skillRef: v1.skillRef });
    expect(oldRead.body).toContain("v1 正文");
  });
});
