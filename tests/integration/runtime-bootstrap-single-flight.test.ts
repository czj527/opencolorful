import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { AgentStore } from "../../src/config/agent-store.js";
import type { AgentSettingsV2 } from "../../src/contracts/agent-settings.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { createTrustedServerApp } from "../fixtures/trusted-app.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import {
  createRuntimeBootstrap,
  EnsureRuntimeError,
} from "../../src/server/routes/runtime-bootstrap.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复回归（§10 后续修复 #1）：ensureRuntime per-session single-flight。
// 缺陷背景：ensureRuntime 的"检查 → 创建"横跨 await SessionRuntime.create
// 异步间隙，messages / compact / regenerate / branch switch 四个入口可并发
// 进入同一会话的装配。PromptService.register 是直接 Map.set——并发输家会
// 静默覆盖赢家 Runtime（旧实例的记忆/Skill/Todo/插件上下文无人 dispose，
// 泄漏），重建路径还可能把已 dispose 的实例注册回 PromptService。
// 修复后：同一会话的并发调用共享同一个 in-flight Promise；装配结束（成功
// 或失败）移除条目——失败后的下一次调用是全新尝试（可重试语义不变）。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: Array<import("better-sqlite3").Database> = [];
const openSessionServices: SessionService[] = [];
const openPromptServices: PromptService[] = [];

const blankBaseColor = {
  persona: "测试人格",
  personality: [] as readonly string[],
  replyStyle: "",
  innerSetting: "",
};

afterEach(() => {
  for (const promptService of openPromptServices.splice(0)) {
    try { promptService.dispose(); } catch { /* ignore */ }
  }
  for (const sessionService of openSessionServices.splice(0)) {
    try { sessionService.closeAll(); } catch { /* ignore */ }
  }
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

/** 统计每个会话的 register 次数（重复装配/覆盖的直接观测量）。 */
class CountingPromptService extends PromptService {
  private readonly registerCounts = new Map<string, number>();

  override register(runtime: SessionRuntime): void {
    this.registerCounts.set(runtime.sessionId, (this.registerCounts.get(runtime.sessionId) ?? 0) + 1);
    super.register(runtime);
  }

  registerCountOf(sessionId: string): number {
    return this.registerCounts.get(sessionId) ?? 0;
  }
}

/** 只让 getSettings 抛错并统计读取次数（失败装配的确定性注入点）。 */
class CountingFailingAgentStore extends AgentStore {
  settingsReads = 0;

  override getSettings(_agentId: string): AgentSettingsV2 {
    this.settingsReads += 1;
    throw new Error("注入的设置读取失败（测试内部细节，不得进入错误响应）");
  }
}

interface SingleFlightWorld {
  home: string;
  paths: ReturnType<typeof getRuntimePaths>;
  database: import("better-sqlite3").Database;
  sessionService: SessionService;
  promptService: CountingPromptService;
  replayStore: EventReplayStore;
  agentStore: AgentStore;
  /** 未绑定 Agent 的会话（faux 装配路径） */
  plainSessionId: string;
  /** 绑定 Agent 的会话（Agent 设置装配路径） */
  boundSessionId: string;
}

/** 创建 Agent + 三类会话的共用世界（数据面真实，Provider 走 faux，无真实网络）。 */
async function createWorld(): Promise<SingleFlightWorld> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-bootstrap-sf-"));
  temporaryDirectories.push(home);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: home });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const audit = new AuditRecorder({
    database,
    producer: { component: "agent-server", processType: "server", processId: "1", bootId: "boot-sf", appVersion: "test", hostPlatform: process.platform },
  });
  const sessionService = new SessionService(paths, new SessionIndex(database));
  openSessionServices.push(sessionService);
  const promptService = new CountingPromptService();
  openPromptServices.push(promptService);
  const replayStore = new EventReplayStore();
  const agentStore = new AgentStore(paths.agents);
  agentStore.create({
    id: "agent-sf",
    name: "Single-flight 回归助手",
    baseColor: blankBaseColor,
    sandbox: { protectedPaths: ["secrets/"] },
  });
  const { app } = createTrustedServerApp({
    paths,
    database,
    sessionService,
    promptService,
    replayStore,
    agentStore,
    audit,
  });

  async function createSession(title: string, agentId?: string): Promise<string> {
    // 无 Agent 绑定的会话无 cwd 兜底归属（保持必填）；绑定会话走 Agent workspace 兜底
    const body = agentId !== undefined ? { title, agentId } : { title, cwd: home };
    const res = await app.request("http://127.0.0.1/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    return created.id;
  }

  return {
    home,
    paths,
    database,
    sessionService,
    promptService,
    replayStore,
    agentStore,
    plainSessionId: await createSession("single-flight 无绑定会话"),
    boundSessionId: await createSession("single-flight 绑定会话", "agent-sf"),
  };
}

describe("Runtime Bootstrap：ensureRuntime per-session single-flight（P1 审计修复回归）", () => {
  it("并发首次装配合并为一次创建：N 个并发调用只 register 一次，顺序补调不重建", async () => {
    const world = await createWorld();
    const bootstrap = createRuntimeBootstrap({
      promptService: world.promptService,
      sessionService: world.sessionService,
      replayStore: world.replayStore,
      paths: world.paths,
      agentStore: world.agentStore,
      database: world.database,
    });

    await Promise.all([
      bootstrap.ensureRuntime(world.plainSessionId),
      bootstrap.ensureRuntime(world.plainSessionId),
      bootstrap.ensureRuntime(world.plainSessionId),
      bootstrap.ensureRuntime(world.plainSessionId),
    ]);

    // 修复前：四个调用各自通过 hasRuntime 检查 → 4 次 create / register 覆盖
    expect(world.promptService.registerCountOf(world.plainSessionId)).toBe(1);
    expect(world.promptService.hasRuntime(world.plainSessionId)).toBe(true);

    // 装配完成后顺序补调：无 runtime 缺失、无 profile 变化 → 不重建
    await bootstrap.ensureRuntime(world.plainSessionId);
    expect(world.promptService.registerCountOf(world.plainSessionId)).toBe(1);
  });

  it("失败装配对并发调用者共享同一拒绝；in-flight 清除后重试是全新尝试", async () => {
    const world = await createWorld();
    const failingStore = new CountingFailingAgentStore(world.paths.agents);
    const bootstrap = createRuntimeBootstrap({
      promptService: world.promptService,
      sessionService: world.sessionService,
      replayStore: world.replayStore,
      paths: world.paths,
      agentStore: failingStore,
      database: world.database,
    });

    const outcomes = await Promise.allSettled([
      bootstrap.ensureRuntime(world.boundSessionId),
      bootstrap.ensureRuntime(world.boundSessionId),
    ]);
    // 并发调用者共享同一次装配（设置只读 1 次），且全部收到稳定拒绝
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(EnsureRuntimeError);
      }
    }
    expect(failingStore.settingsReads).toBe(1);
    expect(world.promptService.hasRuntime(world.boundSessionId)).toBe(false);

    // 装配结束即清除条目：下一次调用是全新尝试（可重试语义不变）
    const retry: unknown = await bootstrap.ensureRuntime(world.boundSessionId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(retry).toBeInstanceOf(EnsureRuntimeError);
    expect(failingStore.settingsReads).toBe(2);
    expect(world.promptService.hasRuntime(world.boundSessionId)).toBe(false);
  });

  it("profile 失效重建路径不受影响：顺序重建与并发重建各自只装配一次", async () => {
    const world = await createWorld();
    const bootstrap = createRuntimeBootstrap({
      promptService: world.promptService,
      sessionService: world.sessionService,
      replayStore: world.replayStore,
      paths: world.paths,
      agentStore: world.agentStore,
      database: world.database,
    });

    await bootstrap.ensureRuntime(world.boundSessionId);
    expect(world.promptService.registerCountOf(world.boundSessionId)).toBe(1);

    // forget 跟踪 → 下一次 ensureRuntime 走 invalidate + 重建，恰好一次
    bootstrap.forgetRuntimeTracking(world.boundSessionId);
    await bootstrap.ensureRuntime(world.boundSessionId);
    expect(world.promptService.registerCountOf(world.boundSessionId)).toBe(2);

    // 并发重建：N 个调用者共享同一次重建装配（不是 N 次 invalidate/create 竞赛）
    bootstrap.forgetRuntimeTracking(world.boundSessionId);
    await Promise.all([
      bootstrap.ensureRuntime(world.boundSessionId),
      bootstrap.ensureRuntime(world.boundSessionId),
      bootstrap.ensureRuntime(world.boundSessionId),
    ]);
    expect(world.promptService.registerCountOf(world.boundSessionId)).toBe(3);
    expect(world.promptService.hasRuntime(world.boundSessionId)).toBe(true);
  });

  it("不同会话互不阻塞：并发装配两个会话各自创建各自的 Runtime", async () => {
    const world = await createWorld();
    const bootstrap = createRuntimeBootstrap({
      promptService: world.promptService,
      sessionService: world.sessionService,
      replayStore: world.replayStore,
      paths: world.paths,
      agentStore: world.agentStore,
      database: world.database,
    });

    await Promise.all([
      bootstrap.ensureRuntime(world.plainSessionId),
      bootstrap.ensureRuntime(world.boundSessionId),
    ]);
    expect(world.promptService.registerCountOf(world.plainSessionId)).toBe(1);
    expect(world.promptService.registerCountOf(world.boundSessionId)).toBe(1);
    expect(world.promptService.hasRuntime(world.plainSessionId)).toBe(true);
    expect(world.promptService.hasRuntime(world.boundSessionId)).toBe(true);
  });
});
