import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));

function spawnNpm(args, options) {
  if (process.platform === "win32") {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args], options);
  }
  return spawn("npm", args, options);
}

const renderer = spawnNpm(["run", "dev:renderer"], {
  cwd,
  stdio: "inherit",
});

async function waitForRenderer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:5174");
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Desktop renderer did not start on port 5174.");
}

await waitForRenderer();

const desktop = spawnNpm(["exec", "electron", "--", "electron/main.cjs"], {
  cwd,
  stdio: "inherit",
  env: {
    ...process.env,
    DESKTOP_DEV_URL: "http://127.0.0.1:5174",
  },
});

function shutdown(code = 0) {
  if (!renderer.killed) renderer.kill();
  if (!desktop.killed) desktop.kill();
  process.exit(code);
}

renderer.on("exit", (code) => {
  if (code !== null && code !== 0) shutdown(code);
});
desktop.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
