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
import { defaultObservabilityPreferences } from "../contracts/preferences.js";
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
import { ObservabilityContext } from "../observability/observability-context.js";
import { PluginFacade } from "../platform/plugin-facade.js";
import { instrument } from "../observability/instrument.js";
import { createBootId } from "../observability/trace-context.js";

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
      ? await buildProductionResources(options.paths, options.version)
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

    instrument.systemStarted({ durationMs: Date.now() - startedAt });

    let stopped = false;
    return {
      host: options.host,
      port: started.port,
      async stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        instrument.systemStopping();
        try {
          appOptions.wsRegistry?.closeAll();
          await closeServer(server!);
        } finally {
          try {
            instrument.systemStopped();
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
      // 崩溃前尽力落盘（buildProductionResources 已 init instrument）
      if (instrument.isEnabled()) {
        instrument.systemCrashed(error instanceof Error ? error : String(error));
        instrument.flush();
      }
      productionResources?.dispose();
    } finally {
      markServerStopped(options.paths);
      releaseServerLock(options.paths);
    }
    throw error;
  }
}

async function buildProductionResources(paths: RuntimePaths, version: string): Promise<ProductionResources> {
  let dbMigrationReport: { from: number; to: number } | undefined;
  const database = openMetadataDatabase(paths.database, (report) => {
    dbMigrationReport = report;
  });
  try {
    // 评审 P1-7：偏好必须先于 ObservabilityContext 读取——
    // 日志级别/文件大小/磁盘预算/保留期/spool 预算全部来自 observability 偏好
    const preferencesStore = new PreferencesStore(paths.preferences);
    const observabilityPrefs = preferencesStore.get().observability ?? defaultObservabilityPreferences();
    // ── Phase 11：可观测性上下文（migration 之后、业务资源之前）──
    const observability = new ObservabilityContext({
      database,
      producer: {
        component: "agent-server",
        processType: "server",
        processId: String(process.pid),
        bootId: createBootId(version),
        appVersion: version,
        hostPlatform: process.platform,
      },
      logsRoot: path.join(paths.logs, "runtime", "server"),
      spoolRoot: path.join(paths.logs, "emergency"),
      logger: {
        minLevel: observabilityPrefs.diagnosticLevel,
        fileSizeBytes: observabilityPrefs.diagnosticFileSizeBytes,
        diskBudgetBytes: observabilityPrefs.diagnosticDiskBudgetBytes,
        debugRetentionDays: observabilityPrefs.diagnosticRetentionDays.debug,
        mainRetentionDays: observabilityPrefs.diagnosticRetentionDays.main,
      },
      spoolBudgetBytes: observabilityPrefs.emergencySpoolBudgetBytes,
    });
    instrument.init(observability);
    const recovery = observability.startupRecovery();
    observability.logger.enforceRetention();
    instrument.systemStarting({ durationMs: 0 });
    if (recovery.interrupted > 0 || recovery.spool.imported > 0) {
      instrument.activity({
        eventName: "system.recovery.completed",
        status: "completed",
        operationId: `recovery-${observability.getProducer().bootId}`,
        actor: { kind: "system", id: "agent-server" },
        executor: { kind: "service", id: "agent-server" },
        payload: {
          summaryCode: "system_recovery_completed",
          attributes: {
            interrupted: recovery.interrupted,
            spoolImported: recovery.spool.imported,
            quarantined: recovery.spool.quarantined,
          },
        },
      });
    }
    instrument.storageDatabaseOpened();
    if (dbMigrationReport !== undefined) {
      instrument.storageMigrationCompleted(dbMigrationReport.from, dbMigrationReport.to);
    }
    const sessionIndex = new SessionIndex(database);
    // ── Phase 12：插件组合根门面（Registry/Sources/Grants/Runtime/Contributions/Dev）──
    const pluginFacade = new PluginFacade({
      database,
      paths,
      audit: observability.audit,
      hostVersion: version,
    });
    const providerStore = new ProviderStore(paths.providerSettings);
    // 评审 P0-1：凭据变更走 fail-closed 审计（observability 上下文已就绪）
    const modelService = await ModelService.create(paths, providerStore, observability.audit);
    // 记忆 ticker 在 sessionService 之后创建，archive 钩子用可变引用延迟接线
    let memoryTicker: MemoryTicker | undefined;
    const sessionService = new SessionService(
      paths,
      sessionIndex,
      (sessionId) => memoryTicker?.onSessionArchived(sessionId),
    );
    // preferencesStore 已在可观测性初始化前创建（评审 P1-7）
    const agentStore = new AgentStore(paths.agents);
    // 启动时迁移旧 Agent 数据（去 type、profile.json→base-color.json、补 innerSetting）
    // 幂等、可恢复、单 agent 失败不阻塞其他
    const migrationReport = agentStore.migrate();
    if (migrationReport.failed > 0) {
      for (const failure of migrationReport.failures) {
        instrument.agentMigrationFailed(failure.agentId, failure.error);
      }
    } else {
      instrument.agentMigrationCompleted("all");
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
    // 记忆设置生效链路：per-Agent 覆盖 → 全局默认 → 平台默认（P0-2：生产必须读真实设置）
    const resolveMemorySettings = (agentId: string) => {
      const global = preferencesStore.get().memory ?? defaultMemoryAgentSettings();
      try {
        const perAgent = agentStore.getSettings(agentId)?.memory;
        if (perAgent !== undefined) return perAgent;
      } catch { /* 读取失败用全局默认 */ }
      return global;
    };
    // 工具型 LLM：按记忆设置解析 Provider/模型（utilityProviderId/utilityModel），
    // 未配置时回退第一个有凭据的 Provider 及其第一个模型；
    // 无凭据/解析失败时抛错 → 各记忆组件走 degraded 路径（不阻塞对话）
    const completeText = async (agentId: string, req: { systemPrompt: string; prompt: string; maxTokens?: number }): Promise<string> => {
      const settings = resolveMemorySettings(agentId);
      let provider = modelService.listProviders().find((p) => p.credentialConfigured && p.providerId === settings.utilityProviderId);
      provider = provider ?? modelService.listProviders().find((p) => p.credentialConfigured);
      if (provider === undefined) throw new Error("无可用 Provider 凭据");
      let model = modelService.listModels().find((m) => m.providerId === provider.providerId && m.modelId === settings.utilityModel);
      model = model ?? modelService.listModels().find((m) => m.providerId === provider.providerId);
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
    // 编译/滚动摘要属 agent-agnostic 工具型调用：走全局记忆设置（resolveMemorySettings("") 回退全局/默认）
    const utilityCompleteText = (req: { systemPrompt: string; prompt: string; maxTokens?: number }): Promise<string> => completeText("", req);
    const compilePipeline = new MemoryCompilePipeline({
      summaryStore,
      dailyStateStore: new MemoryDailyStateStore(database),
      watermarkStore,
      completeText: utilityCompleteText,
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
      rollingSummary: new RollingSummaryService({ summaryStore, watermarkStore, completeText: utilityCompleteText }),
      eventIndexer: new EventIndexer({
        eventStore: new MemoryEventStore(database),
        watermarkStore,
      }),
      compilePipeline,
      agentsDir: paths.agents,
      settingsResolver: (agentId) => ({ turnsPerSummary: resolveMemorySettings(agentId).turnsPerSummary }),
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
        // 评审 P0（第三轮）：记忆审批/遗忘/强度与事实修改同事务严格审计
        audit: observability.audit,
        policy: new MemoryPolicy({
          factStore: new MemoryFactStore(database),
          recallStore: new MemoryRecallStore(database),
          journalStore: new MemoryJournalStore(database),
          batchStore: new MemoryBatchStore(database),
          eventStore: new MemoryEventStore(database),
          settingsResolver: resolveMemorySettings,
        }),
      }),
      settingsResolver: resolveMemorySettings,
      completeText: async (agentId, req) => completeText(agentId, req),
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
      assertSessionReadable: (sessionPath, agentId) => {
        const resolved = path.resolve(sessionPath);
        const root = path.resolve(path.join(paths.agents, agentId, "sessions"));
        if (resolved.startsWith(root + path.sep)) return;
        throw new Error("Session 路径不在当前 Agent 的会话目录内");
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
      settingsResolver: resolveMemorySettings,
      resolver: memoryAgentResolver,
    });
    memoryAgentScheduler.start();
    let disposed = false;

    return {
      appOptions: {
        pluginFacade,
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
        // 评审 P0-1：fail-closed 审计接入路由（沙箱策略/工作区/凭据）
        audit: observability.audit,
        memoryFlushHook: (agentId) => memoryTicker?.requestFlush(agentId),
        memoryAdmin: {
          resolver: memoryAgentResolver,
          application: memoryAgentResolver.application,
          preferencesStore,
          recallStore: new MemoryRecallStore(database),
          scheduler: memoryAgentScheduler,
          settingsResolver: resolveMemorySettings,
        },
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        memoryTicker.stop();
        memoryAgentScheduler.stop();
        usageRecorder.dispose();
        promptService.dispose();
        sessionService.closeAll();
        // Phase 11：日志 flush 必须在 DB 关闭之前（activity 已写完，logger 落盘）
        instrument.flush();
        database.close();
      },
    };
  } catch (error) {
    if (instrument.isEnabled()) {
      instrument.systemCrashed(error instanceof Error ? error : String(error));
      instrument.flush();
    }
    database.close();
    throw error;
  }
}
