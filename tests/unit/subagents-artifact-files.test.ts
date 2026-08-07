import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  type SubagentArtifactId,
  type SubagentArtifactRef,
  type SubagentCapabilitySummary,
  type SubagentRunId,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SubagentStoreError } from "../../src/runtime/subagents/stores/errors.js";
import {
  ArtifactStore,
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
  type SubagentOwnership,
} from "../../src/runtime/subagents/stores/index.js";
import {
  SubagentArtifactFileService,
  hashContent,
  subagentArtifactRefOf,
} from "../../src/runtime/subagents/transcript/artifact-files.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Artifact 文件路由与完整性测试（plans/phase-14.md §17.3）
//
// - 平台 Artifact 写入：Thread artifacts/ 目录约定、原子写、contentHash/size 登记；
// - 完整性校验：篡改文件 → subagent_artifact_integrity_failed + 回调触发；
// - Workspace 文件只登记引用不复制（读取抛 integrity_failed）；
// - 删除：平台 Artifact 连文件删除；workspace_file 引用不删外部文件；
// - 路径安全：非法 artifactId/threadId/ownerAgentId 拒绝（防穿越）。
// ═══════════════════════════════════════════════════════════════

const NOW = "2026-08-07T10:00:00.000Z";

const temporaryDirectories: string[] = [];
const openDatabases: Database.Database[] = [];

function createDatabase(): { directory: string; db: Database.Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagents-artifact-"));
  temporaryDirectories.push(directory);
  const db = openMetadataDatabase(path.join(directory, "metadata.db"));
  openDatabases.push(db);
  return { directory, db };
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭或无效句柄，忽略
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function ownership(agent = "agent-a", session = "sess-main"): SubagentOwnership {
  return { ownerAgentId: agent, parentSessionId: session };
}

function ceiling(): SubagentCapabilitySummary {
  return {
    ceilingHash: "hash12345678",
    workspaceAccess: "read",
    toolIds: [],
    pluginContributionIds: [],
    skillRefs: [],
    network: "inherit",
    fixedDenials: [],
  };
}

const THREAD_ID = "sat_thread00001" as SubagentThreadId;
const RUN_ID = "sar_run0000001" as SubagentRunId;
const ARTIFACT_ID = "saa_artifact001" as SubagentArtifactId;

interface Harness {
  readonly directory: string;
  readonly db: Database.Database;
  readonly service: SubagentArtifactFileService;
  readonly integrityEvents: Array<{ artifactId: string; reason: string }>;
}

function createHarness(): Harness {
  const { directory, db } = createDatabase();
  const threads = new ThreadStore(db);
  const runs = new RunStore(db, threads);
  const messages = new MessageStore(db, threads);
  const artifacts = new ArtifactStore(db, threads);
  const transactions = new SubagentTransactions(db, {
    threadStore: threads,
    runStore: runs,
    messageStore: messages,
    mailboxStore: new ParentMailboxStore(db),
  });
  transactions.createThreadWithFirstRun({
    thread: {
      threadId: THREAD_ID,
      title: "artifact test",
      modelProviderId: "faux",
      modelId: "faux-1",
      modelSource: "user_default",
      thinkingLevel: "normal",
      workspaceCwd: path.join(directory, "workspace"),
      capabilityCeiling: ceiling(),
      contextPacketHash: "hash12345678",
      createdFromTurnId: "turn-1",
    },
    ownership: ownership(),
    firstRun: { runId: RUN_ID, triggerMessageId: "sam_trigger1" as never },
    taskEnvelope: {
      protocol: "opencolorful.agent-message",
      version: 1,
      messageId: "sam_trigger1" as never,
      contextId: THREAD_ID,
      taskId: RUN_ID,
      sender: { kind: "parent_agent", id: "agent-a" },
      recipient: { kind: "subagent", id: RUN_ID },
      messageType: "task",
      deliveryMode: "immediate",
      parts: [{ kind: "text", text: "start" }],
      metadata: { createdAt: NOW, traceId: "trace-1", schemaName: "subagent.task" },
    },
    now: NOW,
  });
  const integrityEvents: Harness["integrityEvents"] = [];
  const service = new SubagentArtifactFileService({
    artifacts,
    threads,
    paths: { subagentsBase: path.join(directory, "agents") } as never,
    onIntegrityFailed: (event) => integrityEvents.push({ artifactId: event.artifactId, reason: event.reason }),
  });
  return { directory, db, service, integrityEvents };
}

describe("SubagentArtifactFileService：平台 Artifact 写入与读取", () => {
  it("写入：文件落在 <base>/<owner>/subagents/<threadId>/artifacts/，元数据含 contentHash/size", () => {
    const h = createHarness();
    const record = h.service.writePlatformArtifact({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "report.md",
      mimeType: "text/markdown",
      content: "平台生成的内容",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    });
    expect(record.contentHash).toBe(hashContent("平台生成的内容"));
    expect(record.sizeBytes).toBe(Buffer.byteLength("平台生成的内容", "utf8"));
    expect(record.resourceKind).toBe("subagent_artifact");
    const filePath = path.join(h.directory, "agents", "agent-a", "subagents", THREAD_ID, "artifacts", ARTIFACT_ID);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("平台生成的内容");

    const ref = subagentArtifactRefOf(record);
    expect(ref).toEqual({ artifactId: ARTIFACT_ID, name: "report.md", contentHash: record.contentHash } satisfies SubagentArtifactRef);
  });

  it("读取：contentHash 匹配返回正文；幂等写返回原记录不重复写", () => {
    const h = createHarness();
    h.service.writePlatformArtifact({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "a.txt",
      mimeType: "text/plain",
      content: "hello",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    });
    const result = h.service.readArtifactContent(ARTIFACT_ID, ownership());
    expect(result.content.toString("utf8")).toBe("hello");
    const again = h.service.writePlatformArtifact({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "a.txt",
      mimeType: "text/plain",
      content: "changed-content-not-written",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    });
    expect(again.contentHash).toBe(hashContent("hello"));
    expect(h.service.readArtifactContent(ARTIFACT_ID, ownership()).content.toString("utf8")).toBe("hello");
  });

  it("篡改文件 → subagent_artifact_integrity_failed + 完整性回调（§17.3）", () => {
    const h = createHarness();
    h.service.writePlatformArtifact({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "a.txt",
      mimeType: "text/plain",
      content: "original",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    });
    const filePath = path.join(h.directory, "agents", "agent-a", "subagents", THREAD_ID, "artifacts", ARTIFACT_ID);
    fs.writeFileSync(filePath, "tampered", "utf8");
    try {
      h.service.readArtifactContent(ARTIFACT_ID, ownership());
      expect.unreachable("应当抛 integrity 错误");
    } catch (error) {
      expect((error as SubagentStoreError).code).toBe("subagent_artifact_integrity_failed");
    }
    expect(h.integrityEvents).toHaveLength(1);
    expect(h.integrityEvents[0]?.artifactId).toBe(ARTIFACT_ID);
    expect(h.integrityEvents[0]?.reason).toBe("contentHash mismatch");
  });

  it("文件缺失 → subagent_artifact_integrity_failed", () => {
    const h = createHarness();
    h.service.writePlatformArtifact({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "a.txt",
      mimeType: "text/plain",
      content: "original",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    });
    const filePath = path.join(h.directory, "agents", "agent-a", "subagents", THREAD_ID, "artifacts", ARTIFACT_ID);
    fs.unlinkSync(filePath);
    expect(() => h.service.readArtifactContent(ARTIFACT_ID, ownership())).toThrow(/missing/);
  });
});

describe("SubagentArtifactFileService：Workspace 文件引用与删除", () => {
  it("workspace_file 只登记引用不复制；读取抛 integrity_failed（无平台正文）", () => {
    const h = createHarness();
    const workspacePath = path.join(h.directory, "workspace", "notes.md");
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    fs.writeFileSync(workspacePath, "外部工作区内容", "utf8");
    const record = h.service.registerWorkspaceFileRef({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      name: "notes.md",
      contentHash: hashContent("外部工作区内容"),
      sizeBytes: Buffer.byteLength("外部工作区内容", "utf8"),
      resourceId: "notes.md",
      visibility: "user",
      ownership: ownership(),
      createdAt: NOW,
    });
    expect(record.resourceKind).toBe("workspace_file");
    expect(record.canonicalPath).toBeNull();
    // 平台 artifacts/ 目录下没有文件
    expect(fs.existsSync(path.join(h.directory, "agents", "agent-a", "subagents", THREAD_ID, "artifacts"))).toBe(false);
    // 外部文件仍存在（未被复制/删除）
    expect(fs.readFileSync(workspacePath, "utf8")).toBe("外部工作区内容");
    expect(() => h.service.readArtifactContent(ARTIFACT_ID, ownership())).toThrow(SubagentStoreError);
  });

  it("删除：平台 Artifact 连文件删除；workspace_file 引用不删外部文件", () => {
    const h = createHarness();
    h.service.writePlatformArtifact({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "a.txt",
      mimeType: "text/plain",
      content: "delete-me",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    });
    const filePath = path.join(h.directory, "agents", "agent-a", "subagents", THREAD_ID, "artifacts", ARTIFACT_ID);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(h.service.deleteArtifact(ARTIFACT_ID, ownership())).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(h.service.listByThread(THREAD_ID, ownership())).toHaveLength(0);
  });

  it("跨归属访问 → subagent_ownership_denied", () => {
    const h = createHarness();
    h.service.writePlatformArtifact({
      artifactId: ARTIFACT_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "a.txt",
      mimeType: "text/plain",
      content: "hello",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    });
    expect(() => h.service.readArtifactContent(ARTIFACT_ID, ownership("agent-b", "sess-main"))).toThrow(/owner/);
  });
});

describe("SubagentArtifactFileService：路径安全", () => {
  it("非法 artifactId/threadId 拒绝（防穿越）", () => {
    const h = createHarness();
    expect(() => h.service.writePlatformArtifact({
      artifactId: "../../escape" as SubagentArtifactId,
      threadId: THREAD_ID,
      runId: RUN_ID,
      kind: "text",
      name: "x",
      mimeType: null,
      content: "x",
      visibility: "parent",
      ownership: ownership(),
      createdAt: NOW,
    })).toThrow(SubagentStoreError);
    expect(() => h.service.threadArtifactsDir("agent-a", "../evil" as SubagentThreadId)).toThrow(SubagentStoreError);
    expect(() => h.service.threadArtifactsDir("../evil", THREAD_ID)).toThrow(SubagentStoreError);
  });
});
