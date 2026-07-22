#!/usr/bin/env node
/**
 * Smoke test for the Supervisor + Web workflow.
 *
 * Starts a Supervisor as a child process, verifies the API endpoints,
 * and cleans up on exit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-smoke-web-"));

const env = {
  ...process.env,
  PERSON_AGENT_HOME: tempHome,
};

let supervisorProcess;

function cleanup() {
  if (supervisorProcess?.pid) {
    try { process.kill(supervisorProcess.pid, "SIGTERM"); } catch {}
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function healthCheck(url, maxRetries = 20, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 200) return await resp.json();
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`在 ${(maxRetries * delayMs) / 1000}s 内未就绪: ${url}`);
}

async function post(url) {
  const resp = await fetch(url, { method: "POST" });
  if (!resp.ok) throw new Error(`POST ${url} 返回 ${resp.status}`);
  return resp.json();
}

async function get(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GET ${url} 返回 ${resp.status}`);
  return resp.json();
}

async function main() {
  console.log("=== Supervisor + Web 烟雾测试 ===\n");

  const supervisorPort = await freePort();
  const agentPort = await freePort();
  console.log(`Supervisor 端口: ${supervisorPort}, Agent 端口: ${agentPort}`);

  const cliEntry = path.resolve(projectRoot, "src/cli/main.ts");
  const tsxArgs = ["--import", "tsx", cliEntry];

  try {
    // 1. 启动 Supervisor（后台）
    console.log("[1/6] 启动 Supervisor...");
    supervisorProcess = spawn(
      process.execPath,
      [...tsxArgs, "supervisor", "start", "--port", String(supervisorPort), "--agent-port", String(agentPort)],
      { cwd: projectRoot, env, stdio: "ignore", windowsHide: true },
    );

    // 2. 等待 Supervisor 就绪
    console.log("[2/6] 等待 Supervisor 就绪...");
    await healthCheck(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    console.log("  Supervisor 在线");

    // 3. 启动 Agent Server
    console.log("[3/6] 启动 Agent Server...");
    await post(`http://127.0.0.1:${supervisorPort}/api/supervisor/start`);
    const status1 = await get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    if (status1.agentServer.status !== "online") throw new Error("Agent Server 未上线");
    console.log("  Agent Server 在线");

    // 4. Agent Server 健康检查
    console.log("[4/6] Agent Server 健康检查...");
    const health = await get(`http://127.0.0.1:${agentPort}/api/health`);
    if (health.status !== "ok") throw new Error("Agent Server 健康检查失败");
    console.log("  Agent Server 健康");

    // 5. Agent Server 地址发现
    console.log("[5/6] Agent Server 地址发现...");
    const discovery = await get(`http://127.0.0.1:${supervisorPort}/api/supervisor/agent-server`);
    if (discovery.port !== agentPort) throw new Error("Agent 端口不匹配");
    console.log("  地址发现正确");

    // 6. 停止 Agent Server，Supervisor 仍在线
    console.log("[6/6] 停止 Agent Server...");
    await post(`http://127.0.0.1:${supervisorPort}/api/supervisor/stop`);
    const status2 = await get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    if (status2.agentServer.status !== "stopped") throw new Error("Agent Server 未停止");
    console.log("  Agent Server 已停止，Supervisor 仍在线");

    console.log("\n✅ Supervisor + Web 烟雾测试通过");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ 烟雾测试失败:", error.message);
    cleanup();
    process.exit(1);
  }
}

main();
