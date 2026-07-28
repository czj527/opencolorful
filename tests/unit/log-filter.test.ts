import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths, type RuntimePaths } from "../../src/config/paths.js";
import { filterLogLines, type LogQuery, type LogTail } from "../../src/supervisor/log-filter.js";

const temporaryDirectories: string[] = [];

function makeTempPaths(): RuntimePaths {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-logfilter-"));
  temporaryDirectories.push(home);
  return getRuntimePaths({ OPENCOLORFUL_HOME: home });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const LOG_SAMPLE = `\
2026-07-23T10:00:00.123Z [info] server online on 127.0.0.1:4310
2026-07-23T10:00:01.234Z [warn] slow provider response latency=2.4s
2026-07-23T10:00:02.345Z [info] using api_key=super-secret-key
2026-07-23T10:00:03.456Z [error] upstream failed Authorization: Bearer sk-abc123xyz
2026-07-23T10:00:04.567Z [warn] retrying request attempt=1
`;

describe("filterLogLines", () => {
  it("filters by warn and only returns matching lines", () => {
    const tail = filterLogLines(LOG_SAMPLE, { level: "warn" } as LogQuery, null);
    expect(tail.logs).toContain("slow provider response");
    expect(tail.logs).toContain("retrying request");
    expect(tail.logs).not.toContain("server online");
    expect(tail.logs).not.toContain("upstream failed");
  });

  it("filters by error and not by matching substrings in messages", () => {
    const input = `2026-07-23T10:00:00.000Z [info] handling error boundary gracefully
2026-07-23T10:00:01.000Z [error] real failure stack trace
`;
    const tail = filterLogLines(input, { level: "error" } as LogQuery, null);
    expect(tail.logs).toContain("real failure stack trace");
    expect(tail.logs).not.toContain("handling error boundary");
  });

  it("returns only the requested tail line count via limit", () => {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `2026-07-23T10:00:0${i}.000Z [info] line-${i}`,
    ).join("\n") + "\n";
    const tail = filterLogLines(lines, { limit: 3 } as LogQuery, null);
    const returned = tail.logs.split("\n").filter((line) => line.trim().length > 0);
    expect(returned.length).toBe(3);
    expect(returned[returned.length - 1]).toContain("line-9");
  });

  it("skips content already returned when since cursor is provided", () => {
    // 模拟增量读：第一次读完整个样本，cursor 指向末尾；之后追加新行再用 since 只读新增。
    const first = filterLogLines(LOG_SAMPLE, {} as LogQuery, null);
    expect(first.logs).toContain("server online");
    expect(first.nextCursor).not.toBeNull();

    const grown = LOG_SAMPLE + "2026-07-23T10:00:05.678Z [error] new failure after first read\n";
    const second = filterLogLines(grown, {} as LogQuery, first.nextCursor);
    expect(second.logs).not.toContain("server online");
    expect(second.logs).toContain("new failure after first read");
  });

  it("compares an absolute cursor against absolute line offsets", () => {
    const baseOffset = 1_048_576;
    const first = filterLogLines("old-line\n", {}, null, baseOffset);

    const second = filterLogLines(
      "old-line\nnew-line\n",
      {},
      first.nextCursor,
      baseOffset,
    );

    expect(second.logs).toBe("new-line\n");
  });

  it("does not advance past an incomplete trailing line", () => {
    const first = filterLogLines("partial", {}, null);
    expect(first.logs).toBe("");
    expect(first.nextCursor).toBeNull();

    const second = filterLogLines("partial-done\nnext\n", {}, first.nextCursor);
    expect(second.logs).toBe("partial-done\nnext\n");
  });

  it("matches a keyword query case-insensitively", () => {
    const tail = filterLogLines(LOG_SAMPLE, { query: "RETRYING" } as LogQuery, null);
    expect(tail.logs).toContain("retrying request");
    expect(tail.logs).not.toContain("server online");
  });
});

describe("filterLogLines redaction input preservation", () => {
  it("exposes raw sk keys and authorization headers for upstream sanitization", () => {
    // filterLogLines 故意不脱敏——敏感信息过滤由 Supervisor 路由负责。
    const tail: LogTail = filterLogLines(LOG_SAMPLE, { query: "sk-abc" } as LogQuery, null);
    expect(tail.logs).toContain("sk-abc123xyz");
    expect(tail.nextCursor).not.toBeNull();
  });
});
