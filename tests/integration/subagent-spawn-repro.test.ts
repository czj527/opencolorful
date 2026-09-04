import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type SubagentRunId,
  type SubagentThreadId,
} from "../../src/contracts/subagents.js";
import { defaultPreferences } from "../../src/contracts/preferences.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import {
  ArtifactStore,
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
  WorkspaceLeaseStore,
} from "../../src/runtime/subagents/stores/index.js";
import { SubagentRuntimeHost } from "../../src/runtime/subagents/runtime/runtime-host.js";
import { SubagentScheduler } from "../../src/runtime/subagents/runtime/scheduler.js";
import { createPiSubagentSessionFactory } from "../../src/runtime/subagents/runtime/pi-session-adapter.js";
import { SubagentTranscriptView } from "../../src/runtime/subagents/transcript/transcript-view.js";
import { SubagentArtifactFileService } from "../../src/runtime/subagents/transcript/artifact-files.js";
import { SubagentReplayStore } from "../../src/runtime/subagents/transcript/replay-store.js";
import { SubagentToolActivityTracker } from "../../src/runtime/subagents/transcript/tool-summary.js";
import { selectSecondary } from "../../src/runtime/model-policy.js";
import {
  registerSubagentContext,
  type SubagentToolServices,
} from "../../src/pi-sdk/subagent-tools-context.js";
import { SUBAGENT_FILE_TOOL_DEFS } from "../../src/server/routes/subagent-ability-tools.js";
import subagentToolsExtension from "../../src/pi-sdk/subagent-tools.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════
// Phase 14 #13/#14 实证复现：faux provider + 临时 OPENCOLORFUL_HOME
//
// 目的：
// 1. 验证 spawn 后 Run 不再永久 queued（execute CAS 失败会 surfaced 为 rejected，
//    成功则到达 running/terminal）。
// 2. 验证能力工具（read）在子会话中不再"执行器未就绪"（abilityExecutors 经
//    globalThis 锚定后 pi-session-adapter 能查到 run-scoped 执行器）。
//
// 本测试使用真实 SubagentRuntimeHost/Scheduler/pi-session-adapter 组合，但用 PI
// faux provider 替代真实网络模型；OPENCOLORFUL_HOME 指向临时目录，测完关闭
// DB/Runtime/订阅。
// ═══════════════════════════════════════════════════════════════

const OWNER = "agent-repro";
const SESSION_ID = "sess-repro";

describe("subagent spawn repro (#13/#14)", () => {
  let tempHome: string;
  let database: Database.Database;
  let cleanup: () => void;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-subagent-repro-"));
    process.env.OPENCOLORFUL_HOME = tempHome;
    database = openMetadataDatabase(path.join(tempHome, "metadata.db"));
  });

  afterEach(() => {
    cleanup?.();
    try {
      database.close();
    } catch {
      // ignore
    }
    delete process.env.OPENCOLORFUL_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("spawn → Run 启动并终态化；能力工具可被调用", async () => {
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: tempHome });
    const threads = new ThreadStore(database);
    const runs = new RunStore(database, threads);
    const messages = new MessageStore(database, threads);
    const artifacts = new ArtifactStore(database, threads);
    const mailbox = new ParentMailboxStore(database);
    const leases = new WorkspaceLeaseStore(database);
    const transactions = new SubagentTransactions(database, { threadStore: threads, runStore: runs, messageStore: messages, mailboxStore: mailbox });

    // Faux provider + ModelRuntime
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({ authPath: paths.authFile, modelsPath: null, allowModelNetwork: false });
    runtime.registerProvider("faux", {
      name: "Faux",
      baseUrl: "http://localhost:0",
      api: faux.provider as never,
      streamSimple: faux.provider.stream as never,
      models: [{
        id: "faux-1",
        name: "Faux Model",
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4000,
      }],
    });
    await runtime.setRuntimeApiKey("faux", "dummy-key");

    const sessionFactory = createPiSubagentSessionFactory({
      threadStore: threads,
      modelRuntime: () => ({ resolveModel: (p: string, m: string) => ({ providerId: p, modelId: m, model: runtime.getModel("faux", "faux-1"), runtime, credentialConfigured: true }) } as never),
      authPath: paths.authFile,
      threadDirResolver: (input) => path.join(paths.subagentsBase, input.ownerAgentId, "subagents", input.threadId),
    });

    const terminals: Array<{ runId: string; status: string; reasonCode: string | null }> = [];
    let scheduler: SubagentScheduler;
    const host = new SubagentRuntimeHost({
      runs,
      messages,
      transactions,
      sessionFactory,
      bootId: "boot-repro",
      onTerminal: (event) => terminals.push({ runId: event.runId, status: event.status, reasonCode: event.reasonCode }),
      onRunFinished: () => scheduler.onRunTerminal(),
    });
    scheduler = new SubagentScheduler({ host });
    const replay = new SubagentReplayStore(database);
    const toolTracker = new SubagentToolActivityTracker();
    const transcriptView = new SubagentTranscriptView({ threads, runs, messages, artifacts });
    const artifactFiles = new SubagentArtifactFileService({ artifacts, threads, paths });
    const projector = { projectRunQueued: () => undefined, projectThreadCreated: () => undefined, projectArtifactIntegrityFailed: () => undefined } as never;

    let seq = 0;
    const newId = (prefix: "sat_" | "sar_" | "sam_" | "saa_" | "smb_" | "sas_"): string => `${prefix}${(seq += 1).toString().padStart(12, "0")}`;
    const ownership = { ownerAgentId: OWNER, parentSessionId: SESSION_ID };
    const abilityCalls: Array<{ name: string; args: unknown }> = [];

    const services: SubagentToolServices = {
      preferences: () => ({ subagents: { defaultModel: null } }),
      selectSecondary: (reason, explicit) => selectSecondary(reason, {
        ...(explicit !== undefined && explicit !== null ? { explicit } : {}),
        preferences: {
          ...defaultPreferences(),
          subagents: { defaultModel: { providerId: "faux", modelId: "faux-1" } },
        },
        modelService: {
          listProviders: () => [{ providerId: "faux", credentialConfigured: true }],
          resolveModel: () => ({}),
        },
      }),
      currentModel: () => ({ providerId: "faux", modelId: "faux-1" }),
      parentSnapshot: () => ({ toolIds: ["read"], pluginContributions: [], skillEntries: [] }),
      modelResolver: () => true,
      toolCatalog: (name) => SUBAGENT_FILE_TOOL_DEFS.find((def) => def.name === name) ?? null,
      createRunToolExecutor: ({ snapshot }) => {
        const missing = snapshot.toolIds.filter((name) => SUBAGENT_FILE_TOOL_DEFS.find((def) => def.name === name) === null);
        if (missing.length > 0) {
          return { ok: false, reason: `快照工具无法解析（fail-closed）：${missing.join(", ")}` };
        }
        return {
          ok: true,
          executor: async (input) => {
            abilityCalls.push({ name: input.name, args: input.args });
            if (input.name === "read") {
              return { ok: true, text: "file content" };
            }
            return { ok: false, text: `unavailable: ${input.name}` };
          },
        };
      },
      workspaceCwd: () => paths.home,
      threadDirResolver: (input) => path.join(paths.subagentsBase, input.ownerAgentId, "subagents", input.threadId),
      threads,
      runs,
      messages,
      artifacts,
      mailbox,
      leases,
      transactions,
      dispatcher: { dispatch: async () => undefined } as unknown as SubagentToolServices["dispatcher"],
      coordinator: { signal: () => undefined, waitForNotifications: async () => ({ items: [], nextCursor: null }) } as unknown as SubagentToolServices["coordinator"],
      scheduler,
      host,
      transcriptView,
      artifactFiles,
      replay,
      toolTracker,
      projector,
      audit: () => ({ kind: "accepted", eventId: "audit-repro", rowId: 1 }),
      available: () => true,
      now: () => Date.now(),
      newId,
    };
    const ctx = { ownerAgentId: OWNER, sessionId: SESSION_ID, turnIdSlot: { current: "turn-1" }, traceSlot: { current: undefined }, services };
    registerSubagentContext(SESSION_ID, ctx);

    const tools = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>();
    const fakePi = {
      registerTool(def: { name: string; execute(...args: unknown[]): Promise<unknown> }) {
        tools.set(def.name, def);
      },
    } as unknown as ExtensionAPI;
    subagentToolsExtension(fakePi);

    cleanup = () => {
      scheduler.drain();
      host.dispose();
    };

    // 1. 预先设置子会话响应：先调用 read（能力工具），再 report_subagent_result
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "test.txt" })]),
      fauxAssistantMessage([fauxToolCall("report_subagent_result", {
        disposition: "satisfied",
        summary: "完成",
        criteria: [{ criterion: "c1", status: "met", evidenceRefs: [] }],
        artifacts: [],
        unresolvedIssues: [],
        recommendedNextAction: "accept",
      })]),
    ]);

    // 2. spawn_subagent
    const spawnDef = tools.get("spawn_subagent");
    expect(spawnDef).toBeDefined();
    const spawnResult = (await spawnDef!.execute("tc-spawn", {
      brief: {
        version: 1,
        title: "实证任务",
        objective: "验证子代理启动与能力工具",
        successCriteria: ["Run 启动", "能力工具可用"],
        deliverables: ["结果"],
        context: ["已有上下文"],
        constraints: ["不修改平台代码"],
        nonGoals: ["不做 E2E 覆盖"],
        executionMode: "research",
        reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "references" },
      },
      context: {
        version: 1,
        userRequest: "读取文件并汇报",
        parentSummary: "",
        messageRefs: [],
        resources: [],
        knownFacts: ["平台为 Windows"],
        unresolvedQuestions: [],
      },
      limits: { maxModelIterations: 4, maxToolCalls: 8 },
    }, undefined, undefined, { sessionManager: { getSessionId: () => SESSION_ID } })) as { content: Array<{ text: string }> };
    const spawnJson = JSON.parse(spawnResult.content[0]?.text ?? "{}") as Record<string, unknown>;

    // #13 关键断言：spawn 不再静默 accepted 后永久 queued；若 execute CAS 仍失败，
    // 这里会 surfaced 为 error + reasonCode。
    expect(spawnJson.status, `spawn failed: ${JSON.stringify(spawnJson)}`).toBe("ok");
    const threadId = spawnJson.threadId as SubagentThreadId;
    const runId = spawnJson.runId as SubagentRunId;

    // 2. 等待 Run 终态化（子会话 faux provider 会调用 report_subagent_result）
    //    子会话 prompt 含 [任务目标] 标记，faux 返回 read 工具调用 → 再返回 result
    const run = runs.get(runId, ownership);
    expect(run).not.toBeNull();

    const deadline = Date.now() + 15_000;
    while (!terminals.some((t) => t.runId === runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const terminal = terminals.find((t) => t.runId === runId);
    const finalRun = runs.get(runId, ownership);
    expect(finalRun?.status).toBe("succeeded");
    expect(terminal?.status).toBe("succeeded");

    // #14 关键断言：能力工具 read 被成功调用（说明 pi-session-adapter 查到了执行器）
    expect(abilityCalls).toContainEqual({ name: "read", args: { path: "test.txt" } });
  });
});
