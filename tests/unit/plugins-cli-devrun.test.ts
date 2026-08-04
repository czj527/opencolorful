import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPluginsCommand } from "../../src/cli/commands/plugins.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 CLI dev loop：devRunId 保存与自动传递
// - dev install 成功后把 devRunId 保存到 ~/.opencolorful/dev-runs.json；
// - reload/enable/disable/reset/uninstall/invoke-tool/run-scenario 在用户
//   未显式提供 --dev-run-id 时自动读取并传入 Server；
// - reload 生成新 devRunId 时同步更新保存值；uninstall/reset 后清除；
// - 无记录且未指定 → 清晰中文错误（请先 dev install 或指定 --dev-run-id）。
// ═══════════════════════════════════════════════════════════════

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

const INSTALLED_DEV_RUN_ID = "dev-run-11111111-aaaa-1111-1111-111111111111";
const RELOADED_DEV_RUN_ID = "dev-run-22222222-bbbb-2222-2222-222222222222";

function stubDevServer(records: FetchCall[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body !== undefined
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      records.push({ url, body });
      let payload: unknown;
      if (url.endsWith("/install")) {
        payload = {
          pluginId: "example.p",
          devRunId: INSTALLED_DEV_RUN_ID,
          status: "enabled",
          sourceDir: String(body.sourceDir),
          runtimeKind: "bundle",
          healthy: true,
          lastError: null,
          scenarios: [],
          surfaces: [],
        };
      } else if (url.endsWith("/reload")) {
        payload = {
          pluginId: "example.p",
          devRunId: RELOADED_DEV_RUN_ID,
          status: "enabled",
          sourceDir: String(body.sourceDir),
          runtimeKind: "bundle",
          healthy: true,
          lastError: null,
          scenarios: [],
          surfaces: [],
        };
      } else if (url.endsWith("/enable") || url.endsWith("/disable")) {
        payload = {
          pluginId: "example.p",
          devRunId: body.devRunId,
          status: "enabled",
          sourceDir: "/dev/src",
          runtimeKind: "bundle",
          healthy: true,
          lastError: null,
          scenarios: [],
          surfaces: [],
        };
      } else if (url.endsWith("/reset")) {
        payload = { status: "reset" };
      } else if (url.endsWith("/uninstall")) {
        payload = { status: "removed" };
      } else {
        payload = { ok: true, result: {} };
      }
      return new Response(JSON.stringify(payload), {
        status: url.endsWith("/install") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

describe("plugins dev：devRunId 保存与自动传递", () => {
  const temporaryDirectories: string[] = [];
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.OPENCOLORFUL_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cli-devrun-"));
    temporaryDirectories.push(dir);
    process.env.OPENCOLORFUL_HOME = dir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) {
      delete process.env.OPENCOLORFUL_HOME;
    } else {
      process.env.OPENCOLORFUL_HOME = originalHome;
    }
    for (const dir of temporaryDirectories.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  function statePath(): string {
    return path.join(process.env.OPENCOLORFUL_HOME!, "dev-runs.json");
  }

  function readDevRuns(): Record<string, string> {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) as { devRuns: Record<string, string> };
    return raw.devRuns;
  }

  it("dev install 成功后把 devRunId 保存到 ~/.opencolorful/dev-runs.json", async () => {
    const records: FetchCall[] = [];
    stubDevServer(records);
    await runPluginsCommand(["dev", "install", "C:\\work\\example-p", "--full-access"]);
    expect(fs.existsSync(statePath())).toBe(true);
    expect(readDevRuns()["example.p"]).toBe(INSTALLED_DEV_RUN_ID);
    expect(records[0]?.body).toMatchObject({ sourceDir: "C:\\work\\example-p", fullAccess: true });
  });

  it("reload 未指定 --dev-run-id 时自动读取保存值，且 reload 返回新 devRunId 后同步更新", async () => {
    const records: FetchCall[] = [];
    stubDevServer(records);
    await runPluginsCommand(["dev", "install", "C:\\work\\example-p"]);
    await runPluginsCommand(["dev", "reload", "example.p"]);
    const reloadCall = records.find((r) => r.url.endsWith("/reload"));
    expect(reloadCall?.body["devRunId"]).toBe(INSTALLED_DEV_RUN_ID);
    // reload 生成新 devRunId（旧运行上下文失效），CLI 侧同步覆盖
    expect(readDevRuns()["example.p"]).toBe(RELOADED_DEV_RUN_ID);
  });

  it("显式 --dev-run-id 覆盖已保存值", async () => {
    const records: FetchCall[] = [];
    stubDevServer(records);
    await runPluginsCommand(["dev", "install", "C:\\work\\example-p"]);
    await runPluginsCommand(["dev", "enable", "example.p", "--dev-run-id", "dev-run-manual"]);
    const enableCall = records.find((r) => r.url.endsWith("/enable"));
    expect(enableCall?.body["devRunId"]).toBe("dev-run-manual");
  });

  it("invoke-tool / run-scenario 自动携带保存的 devRunId", async () => {
    const records: FetchCall[] = [];
    stubDevServer(records);
    await runPluginsCommand(["dev", "install", "C:\\work\\example-p"]);
    await runPluginsCommand(["dev", "invoke-tool", "example.p", "greet", "--agent", "agent-1", "--arg", "name=world"]);
    await runPluginsCommand(["dev", "run-scenario", "example.p", "happy", "--agent", "agent-1"]);
    const invokeCall = records.find((r) => r.url.endsWith("/invoke-tool"));
    expect(invokeCall?.body["devRunId"]).toBe(INSTALLED_DEV_RUN_ID);
    expect(invokeCall?.body).toMatchObject({ agentId: "agent-1", toolName: "greet", args: { name: "world" } });
    const scenarioCall = records.find((r) => r.url.endsWith("/run-scenario"));
    expect(scenarioCall?.body["devRunId"]).toBe(INSTALLED_DEV_RUN_ID);
    expect(scenarioCall?.body).toMatchObject({ scenarioName: "happy", agentId: "agent-1" });
  });

  it("uninstall / reset 成功后清除已保存的 devRunId", async () => {
    const records: FetchCall[] = [];
    stubDevServer(records);
    await runPluginsCommand(["dev", "install", "C:\\work\\example-p"]);
    await runPluginsCommand(["dev", "uninstall", "example.p"]);
    expect(readDevRuns()["example.p"]).toBeUndefined();
    await runPluginsCommand(["dev", "install", "C:\\work\\example-p"]);
    await runPluginsCommand(["dev", "reset", "example.p"]);
    expect(readDevRuns()["example.p"]).toBeUndefined();
  });

  it("无已保存 devRunId 且未指定 --dev-run-id 时给出清晰中文错误（不发请求）", async () => {
    const records: FetchCall[] = [];
    stubDevServer(records);
    await expect(runPluginsCommand(["dev", "enable", "example.p"])).rejects.toThrow(
      /请先.*dev install.*--dev-run-id/,
    );
    expect(records).toHaveLength(0);
  });
});
