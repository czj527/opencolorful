#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const env = {
  ...process.env,
  PERSON_AGENT_HOME: path.join(projectRoot, ".person-agent", "smoke"),
};

let serverPid;

function cleanup() {
  if (serverPid) {
    try { process.kill(serverPid, "SIGTERM"); } catch {}
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

async function healthCheck(url, maxRetries = 15, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 200) return await resp.json();
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Server 在 ${(maxRetries * delayMs) / 1000}s 内未就绪`);
}

async function main() {
  console.log("=== person-Agent 基础烟雾测试 ===\n");

  const cliEntry = path.resolve(projectRoot, "src/cli/main.ts");
  const tsxArgs = ["--import", "tsx", cliEntry];

  try {
    // 1. 启动 Server（后台）
    console.log("[1/3] 启动 Server...");
    spawn(process.execPath, [...tsxArgs, "server", "start"], {
      cwd: projectRoot, env, stdio: "ignore",
      detached: true, windowsHide: true,
    }).unref();

    // 2. 等待健康检查并就绪
    console.log("[2/3] 等待 Server 就绪...");
    const health = await healthCheck("http://127.0.0.1:4310/api/health");
    console.log(`  状态: ${health.status}, 版本: ${health.version}, PID: ${health.pid}`);
    serverPid = health.pid;

    // 3. 停止 Server
    console.log("[3/3] 停止 Server...");
    const stopResult = spawn(process.execPath, [...tsxArgs, "server", "stop"], {
      cwd: projectRoot, env, stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      stopResult.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`stop 退出码: ${code}`));
      });
    });

    console.log("\n✅ 基础烟雾测试通过");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ 烟雾测试失败:", error.message);
    cleanup();
    process.exit(1);
  }
}

main();
