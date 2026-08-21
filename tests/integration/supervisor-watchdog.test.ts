import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { ProcessController } from "../../src/supervisor/process-controller.js";
import { createSupervisorApp } from "../../src/supervisor/app.js";
import { isProcessRunning } from "../../src/server/runtime-state.js";
import type { SupervisorStatusResponse } from "../../src/supervisor/types.js";

const temporaryDirectories: string[] = [];
const controllers: ProcessController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.stopAgentServer().catch(() => {});
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    } catch {
      console.warn(`清理临时目录失败（可手动删除）: ${directory}`);
    }
  }
});

function makeTempHome(prefix = "opencolorful-watchdog-"): { home: string; paths: ReturnType<typeof getRuntimePaths> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(home);
  return { home, paths: getRuntimePaths({ OPENCOLORFUL_HOME: home }) };
}

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../src/cli/main.ts");
const CRASH_ENTRY = path.resolve(import.meta.dirname, "../../tests/fixtures/watchdog-crash-entry.ts");

async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("无法获取端口"));
      }
      server.close();
    });
    server.on("error", reject);
  });
}

async function waitForOnline(
  controller: ProcessController,
  timeoutMs = 10_000,
): Promise<{ pid: number; status: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await controller.getAgentServerStatus();
    const pid = controller.agentServerPid;
    if (status === "online" && pid !== null) {
      return { pid, status };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const finalStatus = await controller.getAgentServerStatus();
  const finalPid = controller.agentServerPid;
  throw new Error(`等待 online 超时: status=${finalStatus}, pid=${finalPid}`);
}

async function waitForStatus(
  controller: ProcessController,
  expected: "stopped" | "error",
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await controller.getAgentServerStatus();
    if (status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 ${expected} 超时: status=${await controller.getAgentServerStatus()}`);
}

function createController(
  home: string,
  paths: ReturnType<typeof getRuntimePaths>,
  agentPort: number,
  options: {
    entryScript?: string;
    autoRestartEnabled?: boolean;
    autoRestartBaseDelayMs?: number;
    autoRestartStabilityMs?: number;
    autoRestartMaxFailures?: number;
    watchdogIntervalMs?: number;
  } = {},
): ProcessController {
  const controller = new ProcessController({
    paths,
    agentServerPort: agentPort,
    supervisorPort: 0,
    entryScript: options.entryScript ?? CLI_ENTRY,
    autoRestartEnabled: options.autoRestartEnabled ?? true,
    autoRestartBaseDelayMs: options.autoRestartBaseDelayMs ?? 100,
    autoRestartMaxDelayMs: 30_000,
    autoRestartStabilityMs: options.autoRestartStabilityMs ?? 200,
    autoRestartMaxFailures: options.autoRestartMaxFailures ?? 3,
    watchdogIntervalMs: options.watchdogIntervalMs ?? 50,
  });
  controllers.push(controller);
  return controller;
}

describe("supervisor watchdog", () => {
  it("auto-restarts after unexpected exit with backoff", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = createController(paths.home, paths, agentPort, {
      autoRestartBaseDelayMs: 200,
      autoRestartStabilityMs: 300,
    });

    const first = await controller.startAgentServer();
    expect(first.pid).toBeGreaterThan(0);
    expect(isProcessRunning(first.pid)).toBe(true);

    // 使用 SIGTERM 让子进程优雅关闭、立即释放端口，避免端口未释放导致重试失败
    process.kill(first.pid, "SIGTERM");
    const second = await waitForOnline(controller, 10_000);
    expect(second.pid).not.toBe(first.pid);
    expect(isProcessRunning(second.pid)).toBe(true);

    // 自动拉起成功后，看门狗计数应被稳定窗口归零
    await new Promise((resolve) => setTimeout(resolve, 500));
    const watchdog = controller.getWatchdogStatus();
    expect(watchdog.consecutiveFailures).toBe(0);
    expect(watchdog.nextRetryAt).toBeNull();
  }, 30_000);

  it("does not auto-restart after manual stop", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = createController(paths.home, paths, agentPort, {
      autoRestartBaseDelayMs: 300,
      autoRestartStabilityMs: 300,
    });

    const { pid } = await controller.startAgentServer();
    await controller.stopAgentServer();
    expect(isProcessRunning(pid)).toBe(false);

    // 等待 2 个退避周期，确认没有自动拉起
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(controller.agentServerPid).toBeNull();
    expect(await controller.getAgentServerStatus()).toBe("stopped");
    const watchdog = controller.getWatchdogStatus();
    expect(watchdog.consecutiveFailures).toBe(0);
    expect(watchdog.nextRetryAt).toBeNull();
  }, 30_000);

  it("gives up after max consecutive failures when entry keeps crashing", async () => {
    const { home, paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = createController(paths.home, paths, agentPort, {
      entryScript: CRASH_ENTRY,
      autoRestartBaseDelayMs: 100,
      autoRestartMaxFailures: 3,
      autoRestartStabilityMs: 200,
    });

    // 先正常启动（触发文件不存在）
    const { pid } = await controller.startAgentServer();
    expect(isProcessRunning(pid)).toBe(true);

    // 写入触发文件，后续重启会立即退出
    fs.writeFileSync(path.join(home, "crash-trigger"), "crash", "utf8");

    process.kill(pid, "SIGKILL");

    // 等待看门狗 retries 耗尽（状态在 error/starting 之间抖动，直接轮询计数器）
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const watchdog = controller.getWatchdogStatus();
      if (watchdog.consecutiveFailures > 3 && watchdog.nextRetryAt === null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const watchdog = controller.getWatchdogStatus();
    expect(watchdog.consecutiveFailures).toBeGreaterThan(3);
    expect(watchdog.nextRetryAt).toBeNull();
    expect(controller.agentServerPid).toBeNull();
    expect(await controller.getAgentServerStatus()).toBe("error");
  }, 30_000);

  it("resets consecutive failures after stability window", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = createController(paths.home, paths, agentPort, {
      autoRestartBaseDelayMs: 200,
      autoRestartStabilityMs: 300,
    });

    const first = await controller.startAgentServer();
    process.kill(first.pid, "SIGTERM");

    // 等待自动重试成功；连续失败计数应大于 0（Windows 端口释放时机可能导致 1 次额外失败）
    const second = await waitForOnline(controller, 10_000);
    expect(second.pid).not.toBe(first.pid);
    const failuresBeforeReset = controller.getWatchdogStatus().consecutiveFailures;
    expect(failuresBeforeReset).toBeGreaterThan(0);

    // 等待稳定窗口过期，使计数归零
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(controller.getWatchdogStatus().consecutiveFailures).toBe(0);

    process.kill(second.pid, "SIGTERM");
    // 稳定窗口后再次失败，计数重新从 0 开始累加（仍大于 0）
    await waitForOnline(controller, 10_000);

    const watchdog = controller.getWatchdogStatus();
    expect(watchdog.consecutiveFailures).toBeGreaterThan(0);
    // 若未重置，第二次事件会在 failuresBeforeReset 基础上继续累加，因此应小于该值加 1
    expect(watchdog.consecutiveFailures).toBeLessThanOrEqual(failuresBeforeReset + 1);
  }, 30_000);

  it("exposes watchdog fields on status endpoint", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = createController(paths.home, paths, agentPort, {
      autoRestartBaseDelayMs: 200,
      autoRestartStabilityMs: 300,
    });
    const { app } = createSupervisorApp({ controller, supervisorPort: 0, agentServerPort: agentPort });

    await controller.startAgentServer();

    const onlineResponse = await app.request("http://127.0.0.1/api/supervisor/status");
    expect(onlineResponse.status).toBe(200);
    const onlineBody = (await onlineResponse.json()) as SupervisorStatusResponse;
    expect(onlineBody.agentServer.watchdog).toBeDefined();
    expect(onlineBody.agentServer.watchdog?.consecutiveFailures).toBe(0);
    expect(onlineBody.agentServer.watchdog?.nextRetryAt).toBeNull();

    const { pid } = await controller.startAgentServer();
    process.kill(pid, "SIGTERM");

    // 等待 status 进入 error 并出现 nextRetryAt
    const deadline = Date.now() + 5_000;
    let errorBody: SupervisorStatusResponse | undefined;
    while (Date.now() < deadline) {
      const response = await app.request("http://127.0.0.1/api/supervisor/status");
      const body = (await response.json()) as SupervisorStatusResponse;
      if (body.agentServer.status === "error" && body.agentServer.watchdog?.nextRetryAt !== null) {
        errorBody = body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(errorBody).toBeDefined();
    expect(errorBody?.agentServer.status).toBe("error");
    expect(errorBody?.agentServer.watchdog?.consecutiveFailures).toBeGreaterThan(0);
    expect(errorBody?.agentServer.watchdog?.nextRetryAt).not.toBeNull();
  }, 30_000);

  it("adopts desired running state across supervisor restart and restarts after adopted process dies", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();

    // controller A 启动 server，并禁用自动重启以避免与 B 竞态
    const controllerA = createController(paths.home, paths, agentPort, {
      autoRestartEnabled: false,
      autoRestartBaseDelayMs: 200,
      autoRestartStabilityMs: 300,
    });
    const { pid: firstPid } = await controllerA.startAgentServer();
    expect(isProcessRunning(firstPid)).toBe(true);

    // 模拟 supervisor 重启：用同 paths 新建 controller B，不调用 start
    const controllerB = createController(paths.home, paths, agentPort, {
      autoRestartBaseDelayMs: 100,
      autoRestartStabilityMs: 200,
      watchdogIntervalMs: 80,
    });
    expect(controllerB.agentServerPid).toBe(firstPid);
    expect(await controllerB.getAgentServerStatus()).toBe("online");

    // 外部杀掉被收养的 server 进程
    process.kill(firstPid, "SIGTERM");

    // 等待 B 的看门狗慢路径轮询发现死亡并自动拉起
    const deadline = Date.now() + 10_000;
    let newPid: number | null = null;
    while (Date.now() < deadline) {
      const status = await controllerB.getAgentServerStatus();
      const pid = controllerB.agentServerPid;
      if (status === "online" && pid !== null && pid !== firstPid) {
        newPid = pid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(newPid).not.toBeNull();
    expect(isProcessRunning(newPid!)).toBe(true);
    expect(newPid).not.toBe(firstPid);
  }, 30_000);
});
