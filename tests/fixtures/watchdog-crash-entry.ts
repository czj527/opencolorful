import fs from "node:fs";
import path from "node:path";

import { runServerCommand } from "../../src/cli/server-command.js";

const home = process.env.OPENCOLORFUL_HOME ?? "";
const triggerFile = path.join(home, "crash-trigger");

if (fs.existsSync(triggerFile)) {
  console.error("watchdog crash entry triggered");
  process.exit(1);
}

// 正常模式下直接调用 server 命令，跳过 process.argv 中的 "server" 作用词
const args = process.argv.slice(3);
await runServerCommand(args);
