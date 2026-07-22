import { getRuntimePaths } from "../config/paths.js";
import { startSupervisor } from "../supervisor/start.js";
import { SUPERVISOR_DEFAULT_PORT } from "../supervisor/types.js";

export async function runSupervisorCommand(args: readonly string[]): Promise<void> {
  const command = args[0] ?? "start";
  const paths = getRuntimePaths();

  if (command === "start") {
    const port = parsePortArg(args) ?? SUPERVISOR_DEFAULT_PORT;
    const agentPort = parseAgentPortArg(args) ?? 4310;
    const supervisor = await startSupervisor({
      paths,
      supervisorPort: port,
      agentServerPort: agentPort,
    });
    console.log(`person-agent supervisor online: http://127.0.0.1:${supervisor.port}`);
    console.log(`agent server port: ${supervisor.agentServerPort}`);
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        void supervisor.stop().finally(resolve);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return;
  }

  throw new Error(`未知 supervisor 命令: ${command}。用法: agent supervisor start [--port N] [--agent-port N]`);
}

function parsePortArg(args: readonly string[]): number | undefined {
  const index = args.indexOf("--port");
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("--port 必须是 1 到 65535 之间的整数");
  }
  return value;
}

function parseAgentPortArg(args: readonly string[]): number | undefined {
  const index = args.indexOf("--agent-port");
  if (index === -1 || index + 1 >= args.length) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("--agent-port 必须是 1 到 65535 之间的整数");
  }
  return value;
}
