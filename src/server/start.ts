import { serve, type ServerType } from "@hono/node-server";

import type { RuntimePaths } from "../config/paths.js";
import { ProviderStore } from "../config/provider-store.js";
import { EventReplayStore } from "../runtime/event-replay-store.js";
import { ModelService } from "../runtime/model-service.js";
import { PromptService } from "../runtime/prompt-service.js";
import { SessionService } from "../runtime/session-service.js";
import { openMetadataDatabase } from "../storage/database.js";
import { SessionIndex } from "../storage/session-index.js";
import { createServerApp, type ServerAppOptions } from "./app.js";
import {
  acquireServerLock,
  markServerStopped,
  releaseServerLock,
  writeRuntimeState,
} from "./runtime-state.js";

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
  writeRuntimeState(options.paths, {
    pid: process.pid,
    host: options.host,
    port: options.port,
    version: options.version,
    status: "starting",
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const appOptions = options.appOptions ?? await buildProductionAppOptions(options.paths);
  const productionDatabase = options.appOptions ? undefined : (appOptions as Awaited<ReturnType<typeof buildProductionAppOptions>>).database;

  try {
    const { app, nodeWebSocket } = createServerApp({
      version: options.version,
      pid: process.pid,
      startedAt,
      ...appOptions,
    });
    const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
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

    nodeWebSocket.injectWebSocket(server);

    writeRuntimeState(options.paths, {
      pid: process.pid,
      host: options.host,
      port,
      version: options.version,
      status: "online",
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let stopped = false;
    return {
      host: options.host,
      port,
      async stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        await closeServer(server);
        markServerStopped(options.paths);
        releaseServerLock(options.paths);
        if (productionDatabase) {
          productionDatabase.close();
        }
      },
    };
  } catch (error) {
    markServerStopped(options.paths);
    releaseServerLock(options.paths);
    throw error;
  }
}

async function buildProductionAppOptions(
  paths: RuntimePaths,
): Promise<
  Omit<ServerAppOptions, "version" | "pid" | "startedAt"> & {
    database: ReturnType<typeof openMetadataDatabase>;
  }
> {
  const database = openMetadataDatabase(paths.database);
  const sessionIndex = new SessionIndex(database);
  const providerStore = new ProviderStore(paths.providerSettings);
  const modelService = await ModelService.create(paths, providerStore);
  const sessionService = new SessionService(paths, sessionIndex);
  const promptService = new PromptService();
  const replayStore = new EventReplayStore();

  return {
    modelService,
    sessionService,
    promptService,
    replayStore,
    database,
  };
}
