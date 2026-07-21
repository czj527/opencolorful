import { runServerCommand } from "./server-command.js";

async function main(): Promise<void> {
  const [scope, ...args] = process.argv.slice(2);
  if (scope !== "server") {
    throw new Error("用法: agent server <start|stop|status|logs> [--foreground]");
  }
  await runServerCommand(args);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
