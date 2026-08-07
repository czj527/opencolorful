import { describe, expect, it } from "vitest";

import type { SubagentRunId, SubagentThreadId } from "../../src/contracts/subagents.js";
import {
  SUBAGENT_TOOL_INPUT_SUMMARY_MAX,
  SubagentToolActivityTracker,
  relativizePath,
  summarizeToolArgs,
  summarizeToolOutput,
} from "../../src/runtime/subagents/transcript/tool-summary.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Tool 可见摘要与脱敏测试（plans/phase-14.md §17.2 / §25.7）
//
// - summarizeToolArgs：敏感 key 值不落盘、sk-/Authorization/URL 凭据/PII
//   被 redact、绝对路径转工作区相对、对象/数组浅层摘要、总量截断；
// - summarizeToolOutput：字符串 redact+截断，非字符串收敛为类型+大小；
// - Tracker：started → completed/failed/denied 生命周期、started 幂等、
//   有界缓冲（超容量丢最旧）、订阅广播。
// ═══════════════════════════════════════════════════════════════

const THREAD_ID = "sat_thread00001" as SubagentThreadId;
const RUN_ID = "sar_run0000001" as SubagentRunId;

describe("summarizeToolArgs：参数安全摘要", () => {
  it("敏感 key 值不落盘；secret-like 内容被 redact", () => {
    const summary = summarizeToolArgs("http_request", {
      url: "https://example.com",
      headers: { Authorization: "Bearer sk-proj-abcdef1234567890", "X-Key": "k-123" },
      apiKey: "sk-live-abcdef123456",
      body: "hello",
    });
    expect(summary).not.toContain("sk-proj");
    expect(summary).not.toContain("sk-live");
    expect(summary).not.toContain("Bearer");
    // key 名可见（摘要需要），值不落盘
    expect(summary).toContain("apiKey=[REDACTED]");
    expect(summary).toContain("[REDACTED]");
    expect(summary).toContain("url=https://example.com");
  });

  it("URL 凭据与邮箱被 redact", () => {
    const summary = summarizeToolArgs("fetch", {
      url: "https://user:pass@example.com/data",
      to: "alice@example.com",
    });
    expect(summary).not.toContain("user:pass");
    expect(summary).not.toContain("alice@example.com");
    expect(summary).toContain("[URL_CREDENTIAL]");
    expect(summary).toContain("[EMAIL]");
  });

  it("绝对路径转工作区相对显示（§17.2）", () => {
    const summary = summarizeToolArgs("write_file", {
      path: "C:\\workspace\\src\\a.ts",
      content: "export const x = 1;",
    }, { workspaceCwd: "C:\\workspace" });
    expect(summary).toContain("path=./src/a.ts");
    expect(summary).not.toContain("C:\\workspace");
    // content 属于正文，仅摘要化保留
    expect(summary).toContain("content=");
  });

  it("非工作区路径保留（经 redact 清洗）", () => {
    const summary = summarizeToolArgs("read", { path: "/Users/alice/secret.txt" });
    expect(summary).toContain("[PATH]");
    expect(summary).not.toContain("/Users/alice");
  });

  it("对象/数组收敛为浅层摘要；总量截断", () => {
    const big = summarizeToolArgs("run", { data: { a: 1, b: 2, c: 3, d: 4 }, list: [1, 2, 3, 4, 5] });
    expect(big).toContain("{a:1, b:2, c:3…+1}");
    expect(big).toContain("[1, 2, 3…+2]");
    const huge = summarizeToolArgs("run", { text: "x".repeat(10_000) });
    expect(huge.length).toBeLessThanOrEqual(SUBAGENT_TOOL_INPUT_SUMMARY_MAX + 32);
  });

  it("非对象输入（字符串/标量）直接摘要", () => {
    expect(summarizeToolArgs("echo", "hello world")).toContain("hello world");
    expect(summarizeToolArgs("echo", null)).toBe("null");
  });
});

describe("summarizeToolOutput：输出安全摘要", () => {
  it("字符串 redact + 截断", () => {
    const output = summarizeToolOutput("run_command", `result ok\nkey=sk-live-abcdef123456\n${"x".repeat(2000)}`);
    expect(output).not.toContain("sk-live");
    expect(output.length).toBeLessThanOrEqual(SUBAGENT_TOOL_INPUT_SUMMARY_MAX + 32);
    expect(output).toContain("result ok");
  });

  it("非字符串收敛为类型+大小", () => {
    expect(summarizeToolOutput("run", { rows: [1, 2, 3] })).toBe("[object 1 keys]");
    expect(summarizeToolOutput("run", [1, 2, 3])).toBe("[array 3]");
    expect(summarizeToolOutput("run", 42)).toBe("42");
    expect(summarizeToolOutput("run", null)).toBe("null");
  });
});

describe("relativizePath", () => {
  it("工作区前缀转相对；非前缀保留", () => {
    expect(relativizePath("C:\\ws\\a\\b.txt", "C:\\ws")).toBe("./a/b.txt");
    expect(relativizePath("/ws/a/b.txt", "/ws")).toBe("./a/b.txt");
    expect(relativizePath("/other/a.txt", "/ws")).toBe("/other/a.txt");
  });
});

describe("SubagentToolActivityTracker：transient 跟踪（§17.2）", () => {
  it("started → completed 生命周期带 durationMs 与输出摘要", () => {
    const tracker = new SubagentToolActivityTracker({ now: () => new Date("2026-08-07T10:00:00.000Z") });
    const started = tracker.started({ threadId: THREAD_ID, runId: RUN_ID, toolCallId: "tc-1", toolName: "read_file", args: { path: "/ws/a.txt" }, workspaceCwd: "/ws" });
    expect(started.status).toBe("started");
    expect(started.inputSummary).toContain("path=./a.txt");
    const completed = tracker.completed({
      threadId: THREAD_ID,
      toolCallId: "tc-1",
      output: "file content sk-live-abcdef123456",
      workspaceCwd: "/ws",
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.outputSummary).not.toContain("sk-live");
    expect(completed?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("failed/denied 终态携带 reasonCode；重复 started 幂等", () => {
    const tracker = new SubagentToolActivityTracker({ now: () => new Date("2026-08-07T10:00:00.000Z") });
    const first = tracker.started({ threadId: THREAD_ID, runId: RUN_ID, toolCallId: "tc-2", toolName: "write_file" });
    const second = tracker.started({ threadId: THREAD_ID, runId: RUN_ID, toolCallId: "tc-2", toolName: "write_file" });
    expect(second).toBe(first);
    const denied = tracker.denied({ threadId: THREAD_ID, toolCallId: "tc-2", reasonCode: "workspace_write_not_allowed" });
    expect(denied?.status).toBe("denied");
    expect(denied?.reasonCode).toBe("workspace_write_not_allowed");
    // 终态后再次 completed 返回 null
    expect(tracker.completed({ threadId: THREAD_ID, toolCallId: "tc-2" })).toBeNull();
  });

  it("有界缓冲：超容量丢弃最旧；listRecent 返回最近 N 条", () => {
    const tracker = new SubagentToolActivityTracker({ now: () => new Date("2026-08-07T10:00:00.000Z") });
    for (let index = 0; index < 220; index += 1) {
      tracker.started({ threadId: THREAD_ID, runId: RUN_ID, toolCallId: `tc-${index}`, toolName: "tool" });
    }
    const recent = tracker.listRecent(THREAD_ID, 50);
    expect(recent).toHaveLength(50);
    expect(recent[0]?.toolCallId).toBe("tc-170");
  });

  it("订阅广播：started/completed 实时推送", async () => {
    const tracker = new SubagentToolActivityTracker({ now: () => new Date("2026-08-07T10:00:00.000Z") });
    const received: string[] = [];
    tracker.subscribe((view) => received.push(`${view.toolCallId}:${view.status}`));
    tracker.started({ threadId: THREAD_ID, runId: RUN_ID, toolCallId: "tc-live", toolName: "tool" });
    tracker.completed({ threadId: THREAD_ID, toolCallId: "tc-live" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual(["tc-live:started", "tc-live:completed"]);
  });
});
