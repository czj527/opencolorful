import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { PLATFORM_VERSION } from "../index.js";
import { getRuntimePaths } from "../config/paths.js";
import { loadEnvironment } from "../config/environment.js";
import { startForegroundServer } from "../server/start.js";
import {
  isProcessRunning,
  markServerStopped,
  readRuntimeState,
} from "../server/runtime-state.js";

export async function runServerCommand(args: readonly string[]): Promise<void> {
  const environment = loadEnvironment();
  const paths = getRuntimePaths();
  const command = args[0] ?? "status";

  if (command === "start") {
    if (args.includes("--foreground")) {
      await runForeground(environment.host, environment.port, paths);
      return;
    }
    startDetachedProcess(paths);
    return;
  }
  if (command === "stop") {
    stopServer(paths);
    return;
  }
  if (command === "status") {
    reportStatus(paths);
    return;
  }
  if (command === "logs") {
    reportLogs(paths);
    return;
  }
  throw new Error(`未知 server 命令: ${command}`);
}

async function runForeground(
  host: string,
  port: number,
  paths: ReturnType<typeof getRuntimePaths>,
): Promise<void> {
  const server = await startForegroundServer({ host, port, paths, version: PLATFORM_VERSION });
  console.log(`person-agent server online: http://${host}:${server.port}`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.stop().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function startDetachedProcess(paths: ReturnType<typeof getRuntimePaths>): void {
  const current = readRuntimeState(paths);
  if (current !== undefined && current.status === "online" && isProcessRunning(current.pid)) {
    console.log(`person-agent server already online: PID ${current.pid}, port ${current.port}`);
    return;
  }

  fs.mkdirSync(path.dirname(paths.serverLog), { recursive: true });
  const logHandle = fs.openSync(paths.serverLog, "a");
  const entry = path.resolve(process.argv[1] ?? "");
  const childArgs = entry.endsWith(".ts")
    ? ["--import", "tsx", entry, "server", "start", "--foreground"]
    : [entry, "server", "start", "--foreground"];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logHandle, logHandle],
    env: { ...process.env, PERSON_AGENT_DAEMON: "1" },
  });
  child.unref();
  fs.closeSync(logHandle);
  console.log(`person-agent server starting: PID ${child.pid ?? "unknown"}`);
}

function stopServer(paths: ReturnType<typeof getRuntimePaths>): void {
  const state = readRuntimeState(paths);
  if (state === undefined || !isProcessRunning(state.pid)) {
    markServerStopped(paths);
    console.log("person-agent server stopped");
    return;
  }
  process.kill(state.pid, "SIGTERM");
  console.log(`person-agent server stopping: PID ${state.pid}`);
}

function reportStatus(paths: ReturnType<typeof getRuntimePaths>): void {
  const state = readRuntimeState(paths);
  if (state === undefined || !isProcessRunning(state.pid)) {
    markServerStopped(paths);
    console.log("person-agent server stopped");
    return;
  }
  console.log(
    `person-agent server ${state.status}: PID ${state.pid}, http://${state.host}:${state.port}`,
  );
}

function reportLogs(paths: ReturnType<typeof getRuntimePaths>): void {
  if (!fs.existsSync(paths.serverLog)) {
    console.log("暂无 server 日志");
    return;
  }
  process.stdout.write(fs.readFileSync(paths.serverLog, "utf8"));
}
