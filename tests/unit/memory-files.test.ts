import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMemoryDir, getLogicalDate, listDailyFiles, writeDailyFile } from "../../src/runtime/memory/memory-files.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe("memory files", () => {
  it("creates directories, strips headers, and sorts daily files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-files-")); dirs.push(dir);
    await ensureMemoryDir(dir);
    await writeDailyFile(dir, "2026-08-02", "later");
    await writeDailyFile(dir, "2026-08-01", "earlier");
    expect(await listDailyFiles(dir)).toEqual([{ date: "2026-08-01", content: "earlier" }, { date: "2026-08-02", content: "later" }]);
  });
  it("uses the local 04:00 boundary", () => {
    expect(getLogicalDate(new Date(2026, 7, 1, 3, 59))).toBe("2026-07-31");
    expect(getLogicalDate(new Date(2026, 7, 1, 4, 0))).toBe("2026-08-01");
  });
});
