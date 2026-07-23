import { serve, type ServerType } from "@hono/node-server";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import { ProcessController } from "./process-controller.js";
import { createSupervisorApp } from "./app.js";
import { SUPERVISOR_DEFAULT_PORT } from "./types.js";

export interface StartSupervisorOptions {
  readonly paths: RuntimePaths;
  readonly agentServerPort?: number;
  readonly supervisorPort?: number;
  readonly entryScript?: string;
  readonly webDistDir?: string;
}

export interface RunningSupervisor {
  readonly port: number;
  readonly agentServerPort: number;
  readonly controller: ProcessController;
  stop(): Promise<void>;
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function resolveWebDistDir(): string | undefined {
  // 生产构建：web/dist 相对于项目根目录
  const candidates = [
    path.resolve(process.cwd(), "web", "dist"),
    path.resolve(import.meta.dirname, "../../web/dist"),
    path.resolve(import.meta.dirname, "../../../web/dist"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return undefined;
}

export async function startSupervisor(options: StartSupervisorOptions): Promise<RunningSupervisor> {
  const supervisorPort = options.supervisorPort ?? SUPERVISOR_DEFAULT_PORT;
  const agentServerPort = options.agentServerPort ?? 4310;
  const { paths } = options;
  const webDistDir = options.webDistDir ?? resolveWebDistDir();

  const controller = new ProcessController({
    paths,
    agentServerPort,
    supervisorPort,
    ...(options.entryScript !== undefined ? { entryScript: options.entryScript } : {}),
  });

  const { app, nodeWebSocket } = createSupervisorApp({
    controller,
    supervisorPort,
    agentServerPort,
    ...(webDistDir !== undefined ? { webDistDir } : {}),
  });

  const server = await new Promise<ServerType>((resolve, reject) => {
    let settled = false;
    const s = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: supervisorPort },
      () => {
        settled = true;
        resolve(s);
      },
    );
    s.once("error", (error: Error) => {
      if (!settled) reject(error);
    });
  });

  nodeWebSocket.injectWebSocket(server);

  let stopped = false;
  return {
    port: supervisorPort,
    agentServerPort,
    controller,
    async stop() {
      if (stopped) return;
      stopped = true;
      await controller.stopAgentServer().catch(() => {});
      await closeServer(server);
    },
  };
}
