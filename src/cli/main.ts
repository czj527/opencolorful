import { runChatCommand } from "./chat-command.js";
import { runServerCommand } from "./server-command.js";

async function main(): Promise<void> {
  const [scope, ...args] = process.argv.slice(2);
  if (scope === "server") {
    await runServerCommand(args);
    return;
  }
  if (scope === "chat") {
    await runChatCommand(args);
    return;
  }
  throw new Error("用法: agent <server|chat> [...args]");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
