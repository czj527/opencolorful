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

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env,
      stdio: "inherit",
      ...options,
    });
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`Exit code: ${code}`));
    });
  });
}

async function main() {
  console.log("=== person-Agent 基础烟雾测试 ===\n");

  const cliEntry = path.resolve(projectRoot, "src/cli/main.ts");
  const tsxArgs = ["--import", "tsx", cliEntry];

  try {
    // 1. 启动 Server
    console.log("[1/4] 启动 Server...");
    const startProc = spawn(process.execPath, [...tsxArgs, "server", "start"], {
      cwd: projectRoot,
      env,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    startProc.unref();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 2. 状态检查
    console.log("[2/4] Server 状态...");
    await run([...tsxArgs, "server", "status"]);

    // 3. 健康检查
    console.log("[3/4] 健康检查...");
    const healthResponse = await fetch("http://127.0.0.1:4310/api/health");
    const health = (await healthResponse.json());
    if (health.status !== "ok") {
      throw new Error(`Server 健康检查失败: ${JSON.stringify(health)}`);
    }
    console.log(`  状态: ${health.status}, 版本: ${health.version}`);

    // 4. 停止 Server
    console.log("[4/4] 停止 Server...");
    await run([...tsxArgs, "server", "stop"]);

    console.log("\n✅ 基础烟雾测试通过");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ 烟雾测试失败:", error.message);
    process.exit(1);
  }
}

main();
