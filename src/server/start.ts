import { serve, type ServerType } from "@hono/node-server";

import type { RuntimePaths } from "../config/paths.js";
import { createServerApp } from "./app.js";
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

  try {
    const app = createServerApp({ version: options.version, pid: process.pid, startedAt });
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
      },
    };
  } catch (error) {
    markServerStopped(options.paths);
    releaseServerLock(options.paths);
    throw error;
  }
}
