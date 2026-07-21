import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";

export type ServerStatus = "starting" | "online" | "stopped";

export interface ServerRuntimeState {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly status: ServerStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
}

function writeAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
  }
}

export function writeRuntimeState(paths: RuntimePaths, state: ServerRuntimeState): void {
  writeAtomic(paths.serverState, state);
}

export function readRuntimeState(paths: RuntimePaths): ServerRuntimeState | undefined {
  if (!fs.existsSync(paths.serverState)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(paths.serverState, "utf8")) as ServerRuntimeState;
  } catch {
    return undefined;
  }
}

export function markServerStopped(paths: RuntimePaths): ServerRuntimeState | undefined {
  const current = readRuntimeState(paths);
  if (current === undefined) {
    return undefined;
  }
  const stopped = { ...current, status: "stopped" as const, updatedAt: new Date().toISOString() };
  writeRuntimeState(paths, stopped);
  return stopped;
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireServerLock(paths: RuntimePaths): void {
  fs.mkdirSync(path.dirname(paths.serverLock), { recursive: true });
  try {
    const handle = fs.openSync(paths.serverLock, "wx");
    fs.writeSync(handle, `${process.pid}\n`);
    fs.closeSync(handle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const state = readRuntimeState(paths);
    if (state !== undefined && isProcessRunning(state.pid)) {
      throw new Error(`Server 已在运行: PID ${state.pid}`);
    }
    fs.rmSync(paths.serverLock, { force: true });
    const handle = fs.openSync(paths.serverLock, "wx");
    fs.writeSync(handle, `${process.pid}\n`);
    fs.closeSync(handle);
  }
}

export function releaseServerLock(paths: RuntimePaths): void {
  fs.rmSync(paths.serverLock, { force: true });
}
