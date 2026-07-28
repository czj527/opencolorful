import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { createServerApp } from "../../src/server/app.js";
import { startForegroundServer } from "../../src/server/start.js";
import { readRuntimeState } from "../../src/server/runtime-state.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("server health", () => {
  it("returns a stable health response without starting a listener", async () => {
    const { app } = createServerApp({ version: PLATFORM_VERSION, pid: 1234, startedAt: Date.now() });
    const response = await app.request("http://127.0.0.1/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      version: PLATFORM_VERSION,
      pid: 1234,
    });
  });

  it("starts on an ephemeral loopback port and updates runtime state", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-server-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
    const server = await startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
    });

    try {
      expect(server.port).toBeGreaterThan(0);
      expect(readRuntimeState(paths)).toMatchObject({
        status: "online",
        pid: process.pid,
        port: server.port,
      });
      const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "ok" });
    } finally {
      await server.stop();
    }

    expect(readRuntimeState(paths)).toMatchObject({ status: "stopped" });
  });

  it("releases runtime state and lock when production service construction fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-server-fail-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
    fs.mkdirSync(path.dirname(paths.providerSettings), { recursive: true });
    fs.writeFileSync(paths.providerSettings, "{not-json", "utf8");

    await expect(startForegroundServer({
      host: "127.0.0.1",
      port: 0,
      paths,
      version: PLATFORM_VERSION,
    })).rejects.toBeInstanceOf(Error);

    expect(readRuntimeState(paths)).toMatchObject({ status: "stopped" });
    expect(fs.existsSync(paths.serverLock)).toBe(false);
  });
});
