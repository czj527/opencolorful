import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInMemoryCredentialStore,
  createInMemorySession,
  createPersistentSession,
  getPiSdkVersion,
  listWorkspaceToolNames,
  openPersistentSession,
  runOfflineCompletionProbe,
  type PiMessageEntry,
} from "../../src/pi-sdk/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PI SDK adapter", () => {
  it("uses the pinned PI SDK version", () => {
    expect(getPiSdkVersion()).toBe("0.80.10");
  });

  it("creates an in-memory PI session without writing JSONL", () => {
    const session = createInMemorySession(process.cwd());

    session.appendUserMessage("hello");
    expect(session.id).toBeTruthy();
    expect(session.persisted).toBe(false);
    expect(session.entryCount).toBe(1);
  });

  it("stores API keys behind a non-secret credential interface", async () => {
    const credentials = createInMemoryCredentialStore();

    await credentials.setApiKey("example", "secret-value");
    expect(await credentials.has("example")).toBe(true);
    expect(await credentials.list()).toEqual([{ providerId: "example", type: "api_key" }]);
  });

  it("runs a faux completion without network access", async () => {
    await expect(runOfflineCompletionProbe("hello", "offline reply")).resolves.toEqual({
      provider: "faux",
      model: "faux-1",
      text: "offline reply",
    });
  });

  it("exposes PI tool factories as stable names", () => {
    expect(listWorkspaceToolNames(process.cwd(), "read-only")).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls"]),
    );
  });

  it("extracts thinking and toolCall blocks from assistant messages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-history-"));
    temporaryDirectories.push(dir);

    // 构造一条带有 thinking + toolCall 的 assistant 消息 JSONL
    const sessionFile = path.join(dir, "session.jsonl");
    const entries = [
      // Session header
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: process.cwd() }),
      // User message
      JSON.stringify({
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "请列出文件", timestamp: 1000000 },
      }),
      // Assistant message with text + thinking + toolCall blocks
      JSON.stringify({
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "我来帮你列出文件。" },
            { type: "thinking", thinking: "用户需要列出当前目录的文件，我应该使用 ls 工具。" },
            { type: "toolCall", id: "tc-1", name: "ls", arguments: { path: "." } },
          ],
          api: "faux",
          provider: "faux",
          model: "faux-1",
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 1000001,
        },
      }),
      // Tool result
      JSON.stringify({
        type: "message",
        id: "e3",
        parentId: "e2",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "ls",
          content: [{ type: "text", text: "file1.txt\nfile2.ts" }],
          isError: false,
          timestamp: 1000002,
        },
      }),
      // Second assistant message (final response)
      JSON.stringify({
        type: "message",
        id: "e4",
        parentId: "e3",
        timestamp: "2026-01-01T00:00:03Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "当前目录下有 file1.txt 和 file2.ts。" }],
          api: "faux",
          provider: "faux",
          model: "faux-1",
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 1000003,
        },
      }),
    ];
    fs.writeFileSync(sessionFile, entries.join("\n") + "\n", "utf8");

    const session = openPersistentSession(sessionFile, dir);
    const messageEntries = session.messageEntries;
    expect(messageEntries.length).toBe(3); // user + assistant(含tool) + assistant(最终)

    // 第一项：user 消息
    expect(messageEntries[0]!.role).toBe("user");
    expect(messageEntries[0]!.content).toBe("请列出文件");
    expect(messageEntries[0]!.thinking).toBeUndefined();
    expect(messageEntries[0]!.toolCalls).toBeUndefined();

    // 第二项：assistant 消息含 thinking + toolCall
    const assistantWithTool = messageEntries[1]!;
    expect(assistantWithTool.role).toBe("assistant");
    expect(assistantWithTool.content).toBe("我来帮你列出文件。");
    expect(assistantWithTool.thinking).toBe("用户需要列出当前目录的文件，我应该使用 ls 工具。");
    expect(assistantWithTool.toolCalls).toBeDefined();
    expect(assistantWithTool.toolCalls!.length).toBe(1);
    expect(assistantWithTool.toolCalls![0]!.toolCallId).toBe("tc-1");
    expect(assistantWithTool.toolCalls![0]!.toolName).toBe("ls");
    expect(assistantWithTool.toolCalls![0]!.status).toBe("completed");
    expect(assistantWithTool.toolCalls![0]!.result).toBe("file1.txt\nfile2.ts");

    // 第三项：最终 assistant 消息（无 thinking / toolCall）
    const finalAssistant = messageEntries[2]!;
    expect(finalAssistant.role).toBe("assistant");
    expect(finalAssistant.content).toBe("当前目录下有 file1.txt 和 file2.ts。");
    expect(finalAssistant.thinking).toBeUndefined();
    expect(finalAssistant.toolCalls).toBeUndefined();

    session.dispose();
  });

  it("maps tool error status correctly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-history-err-"));
    temporaryDirectories.push(dir);

    const sessionFile = path.join(dir, "session.jsonl");
    const entries = [
      JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "2026-01-01T00:00:00Z", cwd: process.cwd() }),
      JSON.stringify({
        type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "执行危险操作", timestamp: 1000000 },
      }),
      JSON.stringify({
        type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc-err", name: "bash", arguments: { command: "rm -rf /" } },
          ],
          api: "faux", provider: "faux", model: "faux-1",
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: 1000001,
        },
      }),
      JSON.stringify({
        type: "message", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "toolResult",
          toolCallId: "tc-err",
          toolName: "bash",
          content: [{ type: "text", text: "Permission denied" }],
          isError: true,
          timestamp: 1000002,
        },
      }),
    ];
    fs.writeFileSync(sessionFile, entries.join("\n") + "\n", "utf8");

    const session = openPersistentSession(sessionFile, dir);
    const messageEntries = session.messageEntries;
    expect(messageEntries.length).toBe(2);
    expect(messageEntries[1]!.toolCalls![0]!.status).toBe("error");
    expect(messageEntries[1]!.toolCalls![0]!.result).toBe("Permission denied");

    session.dispose();
  });

  it("messageEntries are stable sorted by entry order", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-history-order-"));
    temporaryDirectories.push(dir);

    const sessionFile = path.join(dir, "session.jsonl");
    const msgs = [
      { role: "user", content: "msg1", timestamp: 1000001 },
      { role: "assistant", content: "msg2", timestamp: 1000002 },
      { role: "user", content: "msg3", timestamp: 1000003 },
      { role: "assistant", content: "msg4", timestamp: 1000004 },
    ];
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s3", timestamp: "2026-01-01T00:00:00Z", cwd: process.cwd() }),
    ];
    let parentId: string | null = null;
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]!;
      const id = `m${i + 1}`;
      const message = msg.role === "user"
        ? { role: "user", content: msg.content, timestamp: msg.timestamp }
        : {
            role: "assistant",
            content: [{ type: "text" as const, text: msg.content }],
            api: "faux", provider: "faux", model: "faux-1",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop" as const, timestamp: msg.timestamp,
          };
      lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: `2026-01-01T00:00:0${i + 1}Z`, message }));
      parentId = id;
    }
    fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

    const session = openPersistentSession(sessionFile, dir);
    const entries = session.messageEntries;
    expect(entries.length).toBe(4);
    expect(entries.map((e) => e.content)).toEqual(["msg1", "msg2", "msg3", "msg4"]);
    session.dispose();
  });
});

describe("PI SDK import boundary", () => {
  it("accepts this source tree and rejects direct imports outside src/pi-sdk", () => {
    const script = path.resolve("scripts/verify-pi-sdk-imports.mjs");
    expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(0);

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-imports-"));
    temporaryDirectories.push(fixture);
    fs.mkdirSync(path.join(fixture, "src", "runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "src", "runtime", "bad.ts"),
      'import { SessionManager } from "@earendil-works/pi-coding-agent";\n',
    );

    const rejected = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("src/runtime/bad.ts");
  });
});
