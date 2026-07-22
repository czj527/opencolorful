import { serve, type ServerType } from "@hono/node-server";

import type { RuntimePaths } from "../config/paths.js";
import { ProcessController } from "./process-controller.js";
import { createSupervisorApp } from "./app.js";
import { SUPERVISOR_DEFAULT_PORT } from "./types.js";

export interface StartSupervisorOptions {
  readonly paths: RuntimePaths;
  readonly agentServerPort?: number;
  readonly supervisorPort?: number;
  readonly entryScript?: string;
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

export async function startSupervisor(options: StartSupervisorOptions): Promise<RunningSupervisor> {
  const supervisorPort = options.supervisorPort ?? SUPERVISOR_DEFAULT_PORT;
  const agentServerPort = options.agentServerPort ?? 4310;
  const { paths } = options;

  const controller = new ProcessController({
    paths,
    agentServerPort,
    supervisorPort,
    ...(options.entryScript !== undefined ? { entryScript: options.entryScript } : {}),
  });
  const app = createSupervisorApp({ controller, supervisorPort, agentServerPort });

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
