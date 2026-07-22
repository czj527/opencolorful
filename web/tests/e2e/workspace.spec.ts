import { test, expect } from "@playwright/test";
import { startSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../../src/cli/main.ts");

let tempHome: string;
let supervisor: Awaited<ReturnType<typeof startSupervisor>> | null = null;
let supervisorPort: number;
let agentPort: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-e2e-"));
  const paths = getRuntimePaths({ PERSON_AGENT_HOME: tempHome });
  supervisorPort = await freePort();
  agentPort = await freePort();

  supervisor = await startSupervisor({
    paths,
    supervisorPort,
    agentServerPort: agentPort,
    entryScript: CLI_ENTRY,
  });
});

test.afterAll(async () => {
  if (supervisor) {
    await supervisor.stop().catch(() => {});
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test.describe("workspace", () => {
  test("supervisor API is accessible", async ({ page }) => {
    const response = await page.request.get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.supervisor.port).toBe(supervisorPort);
  });

  test("agent server start and stop via API", async ({ page }) => {
    // Start
    const startResponse = await page.request.post(`http://127.0.0.1:${supervisorPort}/api/supervisor/start`);
    expect(startResponse.ok()).toBe(true);

    // Verify online
    const statusResponse = await page.request.get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    const status = await statusResponse.json();
    expect(status.agentServer.status).toBe("online");

    // Stop
    const stopResponse = await page.request.post(`http://127.0.0.1:${supervisorPort}/api/supervisor/stop`);
    expect(stopResponse.ok()).toBe(true);

    // Verify stopped
    const status2 = await (await page.request.get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`)).json();
    expect(status2.agentServer.status).toBe("stopped");
  });

  test("agent server discovery endpoint", async ({ page }) => {
    const response = await page.request.get(`http://127.0.0.1:${supervisorPort}/api/supervisor/agent-server`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.port).toBe(agentPort);
  });

  test("logs endpoint returns data", async ({ page }) => {
    const response = await page.request.get(`http://127.0.0.1:${supervisorPort}/api/supervisor/logs`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toHaveProperty("logs");
    expect(body).toHaveProperty("truncated");
  });

  test("supervisor survives agent server stop", async ({ page }) => {
    // Start
    await page.request.post(`http://127.0.0.1:${supervisorPort}/api/supervisor/start`);
    // Stop
    await page.request.post(`http://127.0.0.1:${supervisorPort}/api/supervisor/stop`);
    // Supervisor should still respond
    const response = await page.request.get(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
    expect(response.ok()).toBe(true);
  });
});
