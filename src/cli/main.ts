import { runChatCommand } from "./chat-command.js";
import { runPluginsCommand } from "./commands/plugins.js";
import { runServerCommand } from "./server-command.js";
import { runSupervisorCommand } from "./supervisor-command.js";

async function main(): Promise<void> {
  const [scope, ...args] = process.argv.slice(2);
  if (scope === "server") {
    await runServerCommand(args);
    return;
  }
  if (scope === "supervisor") {
    await runSupervisorCommand(args);
    return;
  }
  if (scope === "chat") {
    await runChatCommand(args);
    return;
  }
  if (scope === "plugins") {
    await runPluginsCommand(args);
    return;
  }
  throw new Error("用法: agent <server|supervisor|chat|plugins> [...args]");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
