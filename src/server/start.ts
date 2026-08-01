import { serve, type ServerType } from "@hono/node-server";

import type { RuntimePaths } from "../config/paths.js";
import { PreferencesStore } from "../config/preferences-store.js";
import { ProviderStore } from "../config/provider-store.js";
import { AgentStore } from "../config/agent-store.js";
import { createFolderPicker } from "../platform/folder-picker.js";
import { EventReplayStore } from "../runtime/event-replay-store.js";
import { ModelService } from "../runtime/model-service.js";
import { PromptService } from "../runtime/prompt-service.js";
import { SessionService } from "../runtime/session-service.js";
import { openMetadataDatabase } from "../storage/database.js";
import { SessionIndex } from "../storage/session-index.js";
import { UsageStore } from "../storage/usage-store.js";
import { UsageRecorder } from "../runtime/usage-recorder.js";
import { MemoryTicker } from "../runtime/memory/memory-ticker.js";
import { MemoryAgentResolver } from "../runtime/memory/resolver.js";
import { MemoryAgentScheduler } from "../runtime/memory/scheduler.js";
import { MemoryProposalStore } from "../storage/memory/proposal-store.js";
import { MemoryJournalStore } from "../storage/memory/journal-store.js";
import { MemoryPolicy } from "../runtime/memory/memory-policy.js";
import { ProposalApplication } from "../runtime/memory/proposal-application.js";
import { defaultMemoryAgentSettings } from "../contracts/memory.js";
import { MemoryRecallStore } from "../storage/memory/recall-store.js";
import { ActivationUpdater } from "../runtime/memory/activation-updater.js";
import { RollingSummaryService } from "../runtime/memory/rolling-summary.js";
import { EventIndexer } from "../runtime/memory/event-indexer.js";
import { MemoryCompilePipeline } from "../runtime/memory/compile-pipeline.js";
import { completeUtilityTextForResolved } from "../pi-sdk/complete-text.js";
import { MemoryBatchStore } from "../storage/memory/batch-store.js";
import { MemoryDailyStateStore, MemoryWatermarkStore, SchedulerStateStore } from "../storage/memory/recovery-store.js";
import { SessionSummaryStore } from "../storage/memory/summary-store.js";
import { MemoryEventStore } from "../storage/memory/event-store.js";
import { MemoryFactStore } from "../storage/memory/fact-store.js";
import path from "node:path";
import { createServerApp, type ServerAppOptions } from "./app.js";
import {
  acquireServerLock,
  markServerStopped,
  releaseServerLock,
  writeRuntimeState,
} from "./runtime-state.js";
import { ClientRegistry } from "./ws/client-registry.js";

export interface StartServerOptions {
  readonly host: string;
  readonly port: number;
  readonly paths: RuntimePaths;
  readonly version: string;
  readonly appOptions?: Omit<ServerAppOptions, "version" | "pid" | "startedAt">;
}

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

interface ProductionResources {
  readonly appOptions: Omit<ServerAppOptions, "version" | "pid" | "startedAt">;
  dispose(): void;
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function startForegroundServer(options: StartServerOptions): Promise<RunningServer> {
  acquireServerLock(options.paths);
  const startedAt = Date.now();
  let productionResources: ProductionResources | undefined;
  let server: ServerType | undefined;
  try {
    writeRuntimeState(options.paths, {
      pid: process.pid,
      host: options.host,
      port: options.port,
      version: options.version,
      status: "starting",
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    productionResources = options.appOptions === undefined
      ? await buildProductionResources(options.paths)
      : undefined;
    const appOptions = options.appOptions ?? productionResources!.appOptions;
    const { app, nodeWebSocket } = createServerApp({
      version: options.version,
      pid: process.pid,
      startedAt,
      paths: options.paths,
      ...appOptions,
    });
    const started = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
      let settled = false;
      const server = serve(
        { fetch: app.fetch, hostname: options.host, port: options.port },
        (info) => {
          settled = true;
          resolve({ server, port: info.port });
        },
      );
      server.once("error", (error) => {
        if (!settled) {
          reject(error);
        }
      });
    });
    server = started.server;

    nodeWebSocket.injectWebSocket(server);

    writeRuntimeState(options.paths, {
      pid: process.pid,
      host: options.host,
      port: started.port,
      version: options.version,
      status: "online",
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let stopped = false;
    return {
      host: options.host,
      port: started.port,
      async stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        try {
          appOptions.wsRegistry?.closeAll();
          await closeServer(server!);
        } finally {
          try {
            productionResources?.dispose();
          } finally {
            markServerStopped(options.paths);
            releaseServerLock(options.paths);
          }
        }
      },
    };
  } catch (error) {
    if (server !== undefined) await closeServer(server).catch(() => {});
    try {
      productionResources?.dispose();
    } finally {
      markServerStopped(options.paths);
      releaseServerLock(options.paths);
    }
    throw error;
  }
}

async function buildProductionResources(paths: RuntimePaths): Promise<ProductionResources> {
  const database = openMetadataDatabase(paths.database);
  try {
    const sessionIndex = new SessionIndex(database);
    const providerStore = new ProviderStore(paths.providerSettings);
    const modelService = await ModelService.create(paths, providerStore);
    // 记忆 ticker 在 sessionService 之后创建，archive 钩子用可变引用延迟接线
    let memoryTicker: MemoryTicker | undefined;
    const sessionService = new SessionService(
      paths,
      sessionIndex,
      (sessionId) => memoryTicker?.onSessionArchived(sessionId),
    );
    const preferencesStore = new PreferencesStore(paths.preferences);
    const agentStore = new AgentStore(paths.agents);
    // 启动时迁移旧 Agent 数据（去 type、profile.json→base-color.json、补 innerSetting）
    // 幂等、可恢复、单 agent 失败不阻塞其他
    const migrationReport = agentStore.migrate();
    if (migrationReport.failed > 0) {
      for (const failure of migrationReport.failures) {
        console.error(
          `[agent-migrate] ${failure.agentId} @ ${failure.stage}: ${failure.error}`,
        );
      }
    }
    const promptService = new PromptService();
    const folderPicker = createFolderPicker();
    const replayStore = new EventReplayStore();
    const wsRegistry = new ClientRegistry();
    const usageStore = new UsageStore(database);
    const usageRecorder = new UsageRecorder(replayStore, usageStore, (sessionId) => {
      try {
        const view = sessionService.getView(sessionId);
        return view.model;
      } catch {
        return null;
      }
    });
    // 工具型 LLM：取第一个已配置凭据的 Provider 及其第一个模型；
    // 无凭据/解析失败时抛错 → 各记忆组件走 degraded 路径（不阻塞对话）
    const completeText = async (req: { systemPrompt: string; prompt: string; maxTokens?: number }): Promise<string> => {
      const provider = modelService.listProviders().find((p) => p.credentialConfigured);
      if (provider === undefined) throw new Error("无可用 Provider 凭据");
      const model = modelService.listModels().find((m) => m.providerId === provider.providerId);
      if (model === undefined) throw new Error("Provider 未配置模型");
      const resolved = modelService.resolveModel(provider.providerId, model.modelId);
      return completeUtilityTextForResolved(resolved, {
        systemPrompt: req.systemPrompt,
        prompt: req.prompt,
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      });
    };

    const summaryStore = new SessionSummaryStore(database);
    const watermarkStore = new MemoryWatermarkStore(database);
    const compilePipeline = new MemoryCompilePipeline({
      summaryStore,
      dailyStateStore: new MemoryDailyStateStore(database),
      watermarkStore,
      completeText,
    });
    const ticker = new MemoryTicker({
      replayStore,
      sessionService,
      promptService,
      agentStore,
      summaryStore,
      batchStore: new MemoryBatchStore(database),
      watermarkStore,
      schedulerStore: new SchedulerStateStore(database),
      rollingSummary: new RollingSummaryService({ summaryStore, watermarkStore, completeText }),
      eventIndexer: new EventIndexer({
        eventStore: new MemoryEventStore(database),
        watermarkStore,
      }),
      compilePipeline,
      agentsDir: paths.agents,
    });
    memoryTicker = ticker;
    ticker.start();

    // ── Phase 10.5：记忆 Agent 整理（每日/每周窗口 + 高优先级 micro-seal）──
    const memoryAgentResolver = new MemoryAgentResolver({
      batchStore: new MemoryBatchStore(database),
      journalStore: new MemoryJournalStore(database),
      factStore: new MemoryFactStore(database),
      eventStore: new MemoryEventStore(database),
      recallStore: new MemoryRecallStore(database),
      proposalStore: new MemoryProposalStore(database),
      watermarkStore,
      summaryStore,
      application: new ProposalApplication({
        database,
        proposalStore: new MemoryProposalStore(database),
        factStore: new MemoryFactStore(database),
        eventStore: new MemoryEventStore(database),
        journalStore: new MemoryJournalStore(database),
        batchStore: new MemoryBatchStore(database),
        watermarkStore,
        policy: new MemoryPolicy({
          factStore: new MemoryFactStore(database),
          recallStore: new MemoryRecallStore(database),
          journalStore: new MemoryJournalStore(database),
          settingsResolver: () => defaultMemoryAgentSettings(),
        }),
      }),
      settingsResolver: () => defaultMemoryAgentSettings(),
      completeText,
      sessionPathResolver: (sessionId) => {
        const meta = sessionIndex.get(sessionId);
        if (!meta) throw new Error(`Session 不存在: ${sessionId}`);
        return meta.sessionPath;
      },
      agentsDir: paths.agents,
      publish: (env) => replayStore.publish(env),
      activationUpdater: new ActivationUpdater({
        database,
        factStore: new MemoryFactStore(database),
        recallStore: new MemoryRecallStore(database),
      }),
      assertSessionReadable: (sessionPath) => {
        const resolved = path.resolve(sessionPath);
        const root = path.resolve(paths.agents);
        if (resolved.startsWith(root + path.sep)) return;
        throw new Error("Session 路径不在受控目录内");
      },
    });
    const memoryAgentScheduler = new MemoryAgentScheduler({
      replayStore,
      sessionService,
      promptService,
      agentStore,
      journalStore: new MemoryJournalStore(database),
      batchStore: new MemoryBatchStore(database),
      summaryStore,
      schedulerStore: new SchedulerStateStore(database),
      settingsResolver: () => defaultMemoryAgentSettings(),
      resolver: memoryAgentResolver,
    });
    memoryAgentScheduler.start();
    let disposed = false;

    return {
      appOptions: {
        modelService,
        sessionService,
        preferencesStore,
        agentStore,
        folderPicker,
        promptService,
        replayStore,
        usageStore,
        wsRegistry,
        wsPromptService: promptService,
        wsReplayStore: replayStore,
        database,
        memoryFlushHook: (agentId) => memoryTicker?.requestFlush(agentId),
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        memoryTicker.stop();
        memoryAgentScheduler.stop();
        usageRecorder.dispose();
        promptService.dispose();
        sessionService.closeAll();
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
