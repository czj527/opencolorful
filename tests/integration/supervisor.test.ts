import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { ProcessController } from "../../src/supervisor/process-controller.js";
import { createSupervisorApp } from "../../src/supervisor/app.js";
import { startSupervisor } from "../../src/supervisor/start.js";
import { isProcessRunning } from "../../src/server/runtime-state.js";
import type { SupervisorStatusResponse } from "../../src/supervisor/types.js";

const temporaryDirectories: string[] = [];
const fakeServers: http.Server[] = [];
let supervisorInstance: Awaited<ReturnType<typeof startSupervisor>> | null = null;

afterEach(async () => {
  if (supervisorInstance) {
    await supervisorInstance.stop().catch(() => {});
    supervisorInstance = null;
  }
  for (const server of fakeServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    // Windows 上子进程文件句柄（SQLite WAL、日志、Defender 扫描）释放有延迟，
    // 使用较长重试窗口清理；失败只告警不阻塞其他目录
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    } catch {
      console.warn(`清理临时目录失败（可手动删除）: ${directory}`);
    }
  }
});

function makeTempHome(prefix = "opencolorful-supervisor-"): { home: string; paths: ReturnType<typeof getRuntimePaths> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(home);
  return { home, paths: getRuntimePaths({ OPENCOLORFUL_HOME: home }) };
}

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../src/cli/main.ts");

/** T11：轮询 supervisor status 直到 agent server online（自动拉起后无需手动 POST）。 */
async function waitForAgentOnline(supervisorPort: number, timeoutMs = 20_000): Promise<SupervisorStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  let body: SupervisorStatusResponse | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    body = (await response.json()) as SupervisorStatusResponse;
    if (body.agentServer.status === "online") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待 agent server online 超时: ${body?.agentServer.status ?? "无响应"}`);
}

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

describe("supervisor", () => {
  it("returns stopped status when no agent server is running", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });
    const { app } = createSupervisorApp({ controller, supervisorPort: 0, agentServerPort: agentPort });

    const response = await app.request("http://127.0.0.1/api/supervisor/status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as SupervisorStatusResponse;
    expect(body.agentServer.status).toBe("stopped");
    expect(body.agentServer.pid).toBeNull();
    expect(body.supervisor.pid).toBe(process.pid);
  });

  it("starts agent server and reports online status", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    const { pid } = await controller.startAgentServer();
    expect(pid).toBeGreaterThan(0);
    expect(isProcessRunning(pid)).toBe(true);

    const status = await controller.getAgentServerStatus();
    expect(status).toBe("online");

    // Verify health endpoint is reachable
    const health = await fetch(`http://127.0.0.1:${agentPort}/api/health`);
    expect(health.status).toBe(200);

    await controller.stopAgentServer();
    expect(isProcessRunning(pid)).toBe(false);
  }, 30_000);

  it("duplicate start returns same PID without spawning a second process", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    const first = await controller.startAgentServer();
    const second = await controller.startAgentServer();
    expect(second.pid).toBe(first.pid);

    await controller.stopAgentServer();
  }, 30_000);

  it("stops an active agent server", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    const { pid } = await controller.startAgentServer();
    expect(isProcessRunning(pid)).toBe(true);

    await controller.stopAgentServer();
    expect(isProcessRunning(pid)).toBe(false);

    const status = await controller.getAgentServerStatus();
    expect(status).toBe("stopped");
  }, 30_000);

  it("restarts the agent server with a new PID", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    const first = await controller.startAgentServer();
    const second = await controller.restartAgentServer();
    expect(second.pid).not.toBe(first.pid);
    expect(isProcessRunning(second.pid)).toBe(true);

    await controller.stopAgentServer();
  }, 30_000);

  it("returns logs endpoint with agent server output", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });
    const { app } = createSupervisorApp({ controller, supervisorPort: 0, agentServerPort: agentPort });

    // No log file yet
    const empty = await app.request("http://127.0.0.1/api/supervisor/logs");
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { logs: string; truncated: boolean; status: string };
    expect(emptyBody.logs).toBe("");
    expect(emptyBody.status).toBe("stopped");

    // Start server to generate logs
    await controller.startAgentServer();
    const logsResponse = await app.request("http://127.0.0.1/api/supervisor/logs");
    expect(logsResponse.status).toBe(200);

    await controller.stopAgentServer();
  }, 30_000);

  it("supervisor stays up when agent server is stopped", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const supervisorPort = await findFreePort();

    supervisorInstance = await startSupervisor({
      paths,
      supervisorPort,
      agentServerPort: agentPort,
      entryScript: CLI_ENTRY,
    });

    // T11 起 startSupervisor 自动拉起 agent server（原断言"启动后即为 stopped"已是被
    // 修复的行为）：先确认自动拉起完成，再验证 stop 后 supervisor 仍存活。
    await waitForAgentOnline(supervisorPort);

    // Stop agent server
    const stopResponse = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/stop`, {
      method: "POST",
    });
    expect(stopResponse.status).toBe(200);

    // Supervisor should still be running
    const statusResponse = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    const body = (await statusResponse.json()) as SupervisorStatusResponse;
    expect(body.agentServer.status).toBe("stopped");
    expect(body.supervisor.port).toBe(supervisorPort);
  }, 60_000);

  it("stop and restart via API work correctly", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const supervisorPort = await findFreePort();

    supervisorInstance = await startSupervisor({
      paths,
      supervisorPort,
      agentServerPort: agentPort,
      entryScript: CLI_ENTRY,
    });

    // Start
    let response = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/start`, {
      method: "POST",
    });
    expect(response.status).toBe(201);
    const startBody = (await response.json()) as { status: string; pid: number; port: number };
    const firstPid = startBody.pid;

    // Restart
    response = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/restart`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const restartBody = (await response.json()) as { status: string; pid: number; port: number };
    expect(restartBody.pid).not.toBe(firstPid);

    // Stop
    response = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/stop`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
  }, 60_000);

  it("auto-starts agent server on supervisor start without manual POST", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const supervisorPort = await findFreePort();

    supervisorInstance = await startSupervisor({
      paths,
      supervisorPort,
      agentServerPort: agentPort,
      entryScript: CLI_ENTRY,
    });

    // T11：不得依赖手动 POST /api/supervisor/start；轮询 status 直到自动拉起完成
    const body = await waitForAgentOnline(supervisorPort);
    expect(body.agentServer.status).toBe("online");
    expect(body.agentServer.pid).not.toBeNull();
    expect(body.supervisor.port).toBe(supervisorPort);
    expect(body.supervisor.pid).toBe(process.pid);
  }, 60_000);

  it("duplicate POST /api/supervisor/start is idempotent after auto-start", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const supervisorPort = await findFreePort();

    supervisorInstance = await startSupervisor({
      paths,
      supervisorPort,
      agentServerPort: agentPort,
      entryScript: CLI_ENTRY,
    });

    await waitForAgentOnline(supervisorPort);

    const first = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/start`, { method: "POST" });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { status: string; pid: number };

    const second = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/start`, { method: "POST" });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { status: string; pid: number };
    expect(secondBody.pid).toBe(firstBody.pid);
  }, 60_000);

  it("does not resurrect agent server after explicit stop even with a scheduled retry", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const supervisorPort = await findFreePort();

    supervisorInstance = await startSupervisor({
      paths,
      supervisorPort,
      agentServerPort: agentPort,
      entryScript: CLI_ENTRY,
    });
    const started = await waitForAgentOnline(supervisorPort);
    const pid = started.agentServer.pid;
    if (pid === null) {
      throw new Error("agent server pid 缺失");
    }

    // 外部强杀模拟意外崩溃 → 看门狗应排期自动重启（nextRetryAt 非空）
    process.kill(pid, "SIGKILL");
    const retryDeadline = Date.now() + 15_000;
    while (Date.now() < retryDeadline) {
      const response = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
      const current = (await response.json()) as SupervisorStatusResponse;
      if (current.agentServer.watchdog?.nextRetryAt !== null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 显式 stop：应取消已排期的重试并把期望态置为 stopped
    const stopResponse = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/stop`, { method: "POST" });
    expect(stopResponse.status).toBe(200);

    const afterStopResponse = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    const afterStop = (await afterStopResponse.json()) as SupervisorStatusResponse;
    expect(afterStop.agentServer.status).toBe("stopped");
    expect(afterStop.agentServer.pid).toBeNull();
    expect(afterStop.agentServer.watchdog?.nextRetryAt).toBeNull();
    // 崩溃确实被计数过（>0 而非 0），证明这不是"从未崩溃"的空转断言
    expect(afterStop.agentServer.watchdog?.consecutiveFailures).toBeGreaterThan(0);

    // 等待超过已排期重试的退避窗口（默认基线 1s），确认没有复活
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const laterResponse = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    const later = (await laterResponse.json()) as SupervisorStatusResponse;
    expect(later.agentServer.status).toBe("stopped");
    expect(later.agentServer.pid).toBeNull();
    expect(later.agentServer.watchdog?.nextRetryAt).toBeNull();
  }, 60_000);

  it("returns 404 for unknown non-API routes", async () => {
    const { paths } = makeTempHome();
    const controller = new ProcessController({
      paths,
      agentServerPort: 0,
      supervisorPort: 0,
    });
    const { app } = createSupervisorApp({ controller, supervisorPort: 0, agentServerPort: 0 });

    // 非 API 路径且未托管 Web → 404
    const response = await app.request("http://127.0.0.1/nonexistent-page");
    expect(response.status).toBe(404);

    // Agent 未启动时未知 API 路径被代理并返回 502
    const apiResponse = await app.request("http://127.0.0.1/api/unknown");
    expect(apiResponse.status).toBe(502);
  });

  it("writes supervisor state file with both process PIDs", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    await controller.startAgentServer();

    const statePath = path.join(paths.runtime, "supervisor.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(state.supervisorPid).toBe(process.pid);
    expect(state.agentServerPid).toBeGreaterThan(0);
    expect(state.agentServerStatus).toBe("online");
    expect(state.agentServerPort).toBe(agentPort);

    await controller.stopAgentServer();
  }, 30_000);

  it("serves web static assets when webDistDir is provided", async () => {
    const { paths } = makeTempHome();
    const webDist = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-webdist-"));
    temporaryDirectories.push(webDist);
    fs.writeFileSync(path.join(webDist, "index.html"), "<html><body>opencolorful web</body></html>", "utf8");
    fs.mkdirSync(path.join(webDist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(webDist, "assets", "app.js"), "console.log('app')", "utf8");

    const agentPort = await findFreePort();
    const controller = new ProcessController({ paths, agentServerPort: agentPort, supervisorPort: 0 });
    const { app } = createSupervisorApp({
      controller,
      supervisorPort: 0,
      agentServerPort: agentPort,
      webDistDir: webDist,
    });

    const indexResponse = await app.request("http://127.0.0.1/");
    expect(indexResponse.status).toBe(200);
    const html = await indexResponse.text();
    expect(html).toContain("opencolorful web");

    // SPA fallback：非 API 路径也返回 index.html
    const spaResponse = await app.request("http://127.0.0.1/sessions/abc");
    expect(spaResponse.status).toBe(200);
    expect(await spaResponse.text()).toContain("opencolorful web");
  });

  it("proxies agent API requests through supervisor and returns 502 when agent is down", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });
    const { app } = createSupervisorApp({ controller, supervisorPort: 0, agentServerPort: agentPort });

    // Agent 未启动时代理返回 502
    const downResponse = await app.request("http://127.0.0.1/api/health");
    expect(downResponse.status).toBe(502);
    const downBody = (await downResponse.json()) as { code: string };
    expect(downBody.code).toBe("AGENT_UNREACHABLE");

    // 启动 Agent 后代理转发成功
    await controller.startAgentServer();
    const upResponse = await app.request("http://127.0.0.1/api/health");
    expect(upResponse.status).toBe(200);
    const upBody = (await upResponse.json()) as { status: string };
    expect(upBody.status).toBe("ok");

    // Session API 也通过代理
    const sessionsResponse = await app.request("http://127.0.0.1/api/sessions");
    expect(sessionsResponse.status).toBe(200);

    await controller.stopAgentServer();
  }, 30_000);

  it("sanitizes API keys in supervisor logs endpoint", async () => {
    const { paths } = makeTempHome();
    fs.mkdirSync(path.dirname(paths.serverLog), { recursive: true });
    fs.writeFileSync(
      paths.serverLog,
      "provider configured with key sk-abc123def456ghi789 and Authorization: Bearer sk-secret-token-12345\n",
      "utf8",
    );

    const controller = new ProcessController({ paths, agentServerPort: 0, supervisorPort: 0 });
    const { app } = createSupervisorApp({ controller, supervisorPort: 0, agentServerPort: 0 });

    const response = await app.request("http://127.0.0.1/api/supervisor/logs");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { logs: string };
    expect(body.logs).not.toContain("sk-abc123def456ghi789");
    expect(body.logs).not.toContain("sk-secret-token-12345");
    expect(body.logs).toContain("sk-***");
  });

  it("rejects start when port is occupied by a fake health service", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();

    // 伪造健康服务：占用 Agent 端口并返回不属于子进程的 PID
    const fake = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0", pid: 999999, uptimeSeconds: 1 }));
      } else {
        res.writeHead(404).end();
      }
    });
    fakeServers.push(fake);
    await new Promise<void>((resolve) => fake.listen(agentPort, "127.0.0.1", () => resolve()));

    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    // PID 不匹配 → 不得误报成功；子进程最终也会因 EADDRINUSE 退出
    await expect(controller.startAgentServer()).rejects.toThrow();
    // 失败后 child 与状态必须清理干净
    expect(controller.agentServerPid).toBeNull();
    expect(controller.agentServerRunning).toBe(false);
  }, 30_000);

  it("serializes concurrent start calls", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    const [first, second] = await Promise.all([
      controller.startAgentServer(),
      controller.startAgentServer(),
    ]);
    expect(second.pid).toBe(first.pid);

    await controller.stopAgentServer();
  }, 30_000);

  it("clears child reference and state when the agent process exits unexpectedly", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
      entryScript: CLI_ENTRY,
    });

    const { pid } = await controller.startAgentServer();
    expect(controller.agentServerPid).toBe(pid);

    // 模拟异常退出：强杀子进程
    process.kill(pid, "SIGKILL");
    const deadline = Date.now() + 5_000;
    while (controller.agentServerPid !== null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(controller.agentServerPid).toBeNull();
    expect(controller.agentServerRunning).toBe(false);
  }, 30_000);

  it("does not report online when a reused PID serves a foreign health response", async () => {
    const { paths } = makeTempHome();
    const fakeServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", pid: process.pid + 1 }));
    });
    fakeServers.push(fakeServer);
    await new Promise<void>((resolve) => fakeServer.listen(0, "127.0.0.1", () => resolve()));
    const address = fakeServer.address();
    if (address === null || typeof address === "string") throw new Error("无法获取伪造服务端口");

    fs.mkdirSync(paths.runtime, { recursive: true });
    fs.writeFileSync(
      path.join(paths.runtime, "supervisor.json"),
      JSON.stringify({
        supervisorPid: process.pid,
        supervisorPort: 0,
        supervisorStartedAt: new Date().toISOString(),
        agentServerPid: process.pid,
        agentServerPort: address.port,
        agentServerStatus: "online",
        agentServerStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const controller = new ProcessController({
      paths,
      agentServerPort: address.port,
      supervisorPort: 0,
    });

    await expect(controller.getAgentServerStatus()).resolves.toBe("error");
  });

  it("reports degraded when a live agent temporarily cannot answer health checks", async () => {
    const { paths } = makeTempHome();
    const agentPort = await findFreePort();
    fs.mkdirSync(paths.runtime, { recursive: true });
    fs.writeFileSync(
      path.join(paths.runtime, "supervisor.json"),
      JSON.stringify({
        supervisorPid: process.pid,
        supervisorPort: 0,
        supervisorStartedAt: new Date().toISOString(),
        agentServerPid: process.pid,
        agentServerPort: agentPort,
        agentServerStatus: "online",
        agentServerStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const controller = new ProcessController({
      paths,
      agentServerPort: agentPort,
      supervisorPort: 0,
    });

    await expect(controller.getAgentServerStatus()).resolves.toBe("degraded");
  });
});
