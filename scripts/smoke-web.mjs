#!/usr/bin/env node
/**
 * Smoke test for the Supervisor + Web workflow.
 *
 * Starts a Supervisor as a child process, verifies the API endpoints,
 * then gracefully terminates the child and waits for exit before finishing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-smoke-web-"));

const env = {
  ...process.env,
  OPENCOLORFUL_HOME: tempHome,
};

let supervisorProcess;

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

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* dead */ }
      }
      resolve();
    }
  });
}

function waitChildExit(child, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function shutdown() {
  if (supervisorProcess && supervisorProcess.exitCode === null) {
    const pid = supervisorProcess.pid;
    try {
      // Supervisor 收到 SIGTERM 会先停 Agent Server 再退出
      supervisorProcess.kill("SIGTERM");
    } catch { /* already dead */ }
    await waitChildExit(supervisorProcess);
    if (supervisorProcess.exitCode === null && pid) {
      await killTree(pid);
      await waitChildExit(supervisorProcess, 3_000);
    }
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
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
    console.log("[1/7] 启动 Supervisor...");
    supervisorProcess = spawn(
      process.execPath,
      [...tsxArgs, "supervisor", "start", "--port", String(supervisorPort), "--agent-port", String(agentPort)],
      { cwd: projectRoot, env, stdio: "ignore", windowsHide: true },
    );

    // 2. 等待 Supervisor 就绪
    console.log("[2/7] 等待 Supervisor 就绪...");
    await healthCheck(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    console.log("  Supervisor 在线");

    // 3. 首页返回 Web 页面（web/dist 已构建）
    console.log("[3/7] 验证 Web 静态托管...");
    const indexResp = await fetch(`http://127.0.0.1:${supervisorPort}/`);
    if (!indexResp.ok) throw new Error(`Web 首页返回 ${indexResp.status}`);
    const html = await indexResp.text();
    if (!html.includes("root")) throw new Error("Web 首页缺少 root 挂载点");
    console.log("  Web 首页可访问");

    // 4. 启动 Agent Server 并验证代理
    console.log("[4/7] 启动 Agent Server...");
    await post(`http://127.0.0.1:${supervisorPort}/api/supervisor/start`);
    const status1 = await get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    if (status1.agentServer.status !== "online") throw new Error("Agent Server 未上线");
    console.log("  Agent Server 在线");

    // 5. 通过 Supervisor 代理访问 Agent API
    console.log("[5/7] 验证 API 代理...");
    const health = await get(`http://127.0.0.1:${supervisorPort}/api/health`);
    if (health.status !== "ok") throw new Error("代理健康检查失败");
    const sessions = await get(`http://127.0.0.1:${supervisorPort}/api/sessions`);
    if (!Array.isArray(sessions)) throw new Error("代理 Session 列表失败");
    console.log("  代理健康检查与 Session API 正常");

    // 6. Agent Server 地址发现
    console.log("[6/7] 验证地址发现...");
    const discovery = await get(`http://127.0.0.1:${supervisorPort}/api/supervisor/agent-server`);
    if (discovery.port !== agentPort) throw new Error("Agent 端口不匹配");
    console.log("  地址发现正确");

    // 7. 停止 Agent Server，Supervisor 仍在线且页面可访问
    console.log("[7/7] 停止 Agent Server...");
    await post(`http://127.0.0.1:${supervisorPort}/api/supervisor/stop`);
    const status2 = await get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    if (status2.agentServer.status !== "stopped") throw new Error("Agent Server 未停止");
    const indexResp2 = await fetch(`http://127.0.0.1:${supervisorPort}/`);
    if (!indexResp2.ok) throw new Error("Agent 停止后 Web 页面不可访问");
    console.log("  Agent Server 已停止，Supervisor 与 Web 仍在线");

    console.log("\n✅ Supervisor + Web 烟雾测试通过");
  } catch (error) {
    console.error("\n❌ 烟雾测试失败:", error.message);
    await shutdown();
    process.exitCode = 1;
    return;
  }

  await shutdown();
  // 自然退出，不调用 process.exit()，让句柄正常关闭
}

main().catch(async (error) => {
  console.error("\n❌ 烟雾测试异常:", error);
  await shutdown();
  process.exitCode = 1;
});
