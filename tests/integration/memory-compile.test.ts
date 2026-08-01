import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { SessionSummaryStore } from "../../src/storage/memory/summary-store.js";
import { MemoryDailyStateStore, MemoryWatermarkStore } from "../../src/storage/memory/recovery-store.js";
import { MemoryCompilePipeline } from "../../src/runtime/memory/compile-pipeline.js";

const contexts: Array<{ dir: string; close: () => void }> = [];
afterEach(() => { for (const context of contexts.splice(0)) { context.close(); fs.rmSync(context.dir, { recursive: true, force: true }); } });
function context() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-compile-")); const db = openMetadataDatabase(getRuntimePaths({ OPENCOLORFUL_HOME: dir }).database);
  contexts.push({ dir, close: () => db.close() });
  return { dir, db };
}

describe("memory compile pipeline", () => {
  it("runs without network and assembles four sections", async () => {
    const { dir, db } = context(); const memoryDir = path.join(dir, "memory");
    const summaries = new SessionSummaryStore(db); summaries.upsert({ sessionId: "s", branchRevision: "b", agentId: "a", summary: "### 重要事实\n- 事实\n### 时间线\n- 时间线", messageCount: 1, cursor: {} });
    const pipeline = new MemoryCompilePipeline({ summaryStore: summaries, dailyStateStore: new MemoryDailyStateStore(db), watermarkStore: new MemoryWatermarkStore(db), completeText: async ({ prompt }) => prompt.includes("重要事实") ? "- 事实" : "正文" });
    const result = await pipeline.runDaily("a", memoryDir, "2026-08-01");
    expect(result.revision).toHaveLength(12); expect(fs.readFileSync(path.join(memoryDir, "memory.md"), "utf8")).toContain("## 今天");
  });
});
