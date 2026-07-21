#!/usr/bin/env node

import { spawn } from "node:child_process";
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

let serverProcess;

function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    try {
      process.kill(-serverProcess.pid, "SIGTERM");
    } catch {
      // 进程可能已退出
    }
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("SIGTERM", () => { cleanup(); process.exit(1); });

async function healthCheck(url, maxRetries = 10, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 200) return await resp.json();
    } catch {
      // 继续重试
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Server 在 ${maxRetries * delayMs / 1000}s 内未就绪`);
}

async function main() {
  console.log("=== person-Agent 基础烟雾测试 ===\n");

  const cliEntry = path.resolve(projectRoot, "src/cli/main.ts");
  const tsxArgs = ["--import", "tsx", cliEntry];

  try {
    // 1. 启动 Server（后台）
    console.log("[1/4] 启动 Server...");
    serverProcess = spawn(process.execPath, [...tsxArgs, "server", "start"], {
      cwd: projectRoot,
      env,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });

    // 2. 等待健康检查就绪（最多重试 5 秒）
    console.log("[2/4] 等待 Server 就绪...");
    const health = await healthCheck("http://127.0.0.1:4310/api/health");
    console.log(`  状态: ${health.status}, 版本: ${health.version}`);

    // 3. 列出 Sessions（调用 API）
    console.log("[3/4] 列出 Sessions...");
    const sessionsResp = await fetch("http://127.0.0.1:4310/api/sessions");
    const sessions = await sessionsResp.json();
    console.log(`  共 ${Array.isArray(sessions) ? sessions.length : 0} 个 Session`);

    // 4. 停止 Server
    console.log("[4/4] 停止 Server...");
    const stopProc = spawn(process.execPath, [...tsxArgs, "server", "stop"], {
      cwd: projectRoot,
      env,
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      stopProc.on("close", (code) => {
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
