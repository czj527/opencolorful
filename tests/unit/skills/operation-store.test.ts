import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillOperationStore } from "../../../src/runtime/skills/installer/operation-store.js";
import { openMetadataDatabase } from "../../../src/storage/database.js";
import { tempPaths } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 skill_operations 状态机测试（plans/phase-13.md §9.1 / §13.2）
// ═══════════════════════════════════════════════════════════════

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function makeStore(): SkillOperationStore {
  const { paths, home } = tempPaths();
  const database = openMetadataDatabase(path.join(paths.home, "metadata.sqlite"));
  cleanups.push(() => {
    database.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return new SkillOperationStore(database);
}

describe("SkillOperationStore", () => {
  it("started → completed 状态迁移与记录保留", () => {
    const store = makeStore();
    store.startOperation({ operationId: "op-1", kind: "install", sourceRef: "src://a", agentId: "agent-1", sessionId: "sess-1" });
    let record = store.getOperation("op-1");
    expect(record?.status).toBe("started");
    expect(record?.kind).toBe("install");
    expect(record?.agentId).toBe("agent-1");
    expect(record?.sessionId).toBe("sess-1");
    expect(record?.completedAt).toBeNull();

    store.finishOperation("op-1", "completed");
    record = store.getOperation("op-1");
    expect(record?.status).toBe("completed");
    expect(record?.completedAt).not.toBeNull();
  });

  it("failed 记录 errorCode（不暴露内部细节，只留稳定 reasonCode）", () => {
    const store = makeStore();
    store.startOperation({ operationId: "op-2", kind: "update", sourceRef: "src://b" });
    store.finishOperation("op-2", "failed", { errorCode: "skill_version_conflict" });
    expect(store.getOperation("op-2")?.status).toBe("failed");
    expect(store.getOperation("op-2")?.errorCode).toBe("skill_version_conflict");
  });

  it("findOpenOperations 只返回 started（T10 启动恢复扫描用）", () => {
    const store = makeStore();
    store.startOperation({ operationId: "op-open", kind: "install", sourceRef: "src://c" });
    store.startOperation({ operationId: "op-done", kind: "uninstall", sourceRef: "src://d" });
    store.finishOperation("op-done", "completed");
    const open = store.findOpenOperations();
    expect(open).toHaveLength(1);
    expect(open[0]?.operationId).toBe("op-open");
  });

  it("非法 kind 拒绝（与 migration CHECK 一致，fail-closed）", () => {
    const store = makeStore();
    expect(() => store.startOperation({ operationId: "op-x", kind: "bogus" as never })).toThrowError();
  });
});
