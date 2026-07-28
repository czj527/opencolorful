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
    const sessionService = new SessionService(paths, sessionIndex);
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
      },
      dispose() {
        if (disposed) return;
        disposed = true;
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
