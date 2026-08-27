import { serve, type ServerType } from "@hono/node-server";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import { PLATFORM_VERSION } from "../index.js";
import { ProcessController } from "./process-controller.js";
import { createSupervisorApp } from "./app.js";
import { SUPERVISOR_DEFAULT_PORT } from "./types.js";
import { openMetadataDatabase } from "../storage/database.js";
import { ObservabilityContext } from "../observability/observability-context.js";
import { instrument } from "../observability/instrument.js";
import { createBootId } from "../observability/trace-context.js";

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

  // Phase 11：supervisor 进程自己的可观测性上下文（与 agent server 共享 metadata DB，
  // WAL + busy_timeout 保证并发安全；事件按 processType 隔离）
  let observability: ObservabilityContext | undefined;
  let database: ReturnType<typeof openMetadataDatabase> | undefined;
  try {
    database = openMetadataDatabase(paths.database);
    observability = new ObservabilityContext({
      database,
      producer: {
        component: "supervisor",
        processType: "supervisor",
        processId: String(process.pid),
        bootId: createBootId(PLATFORM_VERSION),
        appVersion: PLATFORM_VERSION,
        hostPlatform: process.platform,
      },
      logsRoot: path.join(paths.logs, "runtime", "supervisor"),
      spoolRoot: path.join(paths.logs, "emergency"),
    });
    instrument.init(observability);
    observability.startupRecovery();
    observability.logger.enforceRetention();
  } catch (error) {
    // 可观测性初始化失败不阻塞 supervisor 主功能（退化为无埋点运行）
    instrument.warn("observability.init_failed", "supervisor 可观测性初始化失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

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
  instrument.supervisorServerStarted();

  // T11：`supervisor start` 语义 = 整个后端一次带起。HTTP 监听就绪后立即把 agent
  // server 期望态置为 running 并复用现有 spawn/看门狗路径拉起子进程，无需手动
  // POST /api/supervisor/start。不阻塞返回：启动失败由看门狗退避重试，supervisor
  // 始终存活；启动期间状态经 /api/supervisor/status 呈现为 starting → online。
  void controller.startAgentServer().catch(() => {
    // 失败路径已在 doStartAgentServer 中记录并交给看门狗排期重试，
    // 此处仅吞掉 rejection，避免 UnhandledPromiseRejection。
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
      instrument.supervisorServerStopped();
      instrument.flush();
      database?.close();
    },
  };
}
