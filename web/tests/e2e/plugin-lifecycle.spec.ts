import { test, expect } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// ═══════════════════════════════════════════════════════════════
// Phase 12 P0 验收：插件生命周期真实 E2E（Supervisor + 真实 Agent Server + Web）
//
// 覆盖验收要求的端到端闭环：
//   dev install（Showcase 目录）→ enable（运行时启动）→ invoke-tool echo（工具执行）
//   → reload（热重载）→ disable → uninstall；
//   正式路径：local 来源 inspect/install（带授权）→ enable → Agent 绑定 → 详情富字段 → 卸载。
// 说明：工具进入主会话（Agent turn）需真实模型，e2e 用 dev invoke-tool 等价验证
// ToolService.invoke → RuntimeHost.invoke → worker 的完整执行链。
// ═══════════════════════════════════════════════════════════════

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../../src/cli/main.ts");
const WEB_DIST = path.resolve(import.meta.dirname, "../../dist");
const SHOWCASE_DIR = path.resolve(import.meta.dirname, "../../../examples/plugins/sdk-showcase");

let tempHome: string;
let supervisor: RunningSupervisor | null = null;
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

async function api(pathname: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  // P0-1 信任边界：直连 Supervisor 的 Node 侧调用须携带服务令牌（写请求校验）
  const headers: Record<string, string> = {};
  if (supervisor !== null) headers["x-oc-token"] = supervisor.token;
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${supervisorPort}${pathname}`, {
    method: init?.method ?? "GET",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return response;
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-plugin-lifecycle-"));
  fs.mkdirSync(path.join(tempHome, "workspace"), { recursive: true });

  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: tempHome });
  supervisorPort = await freePort();
  agentPort = await freePort();

  supervisor = await startSupervisor({
    paths,
    supervisorPort,
    agentServerPort: agentPort,
    entryScript: CLI_ENTRY,
    webDistDir: WEB_DIST,
  });
  // 真实 Agent Server（含 Phase 12 插件路由）需显式启动并等待就绪
  await supervisor.controller.startAgentServer();
});

test.afterAll(async () => {
  if (supervisor) {
    await supervisor.stop().catch(() => {});
  }
  const cleanupDeadline = Date.now() + 15_000;
  while (Date.now() < cleanupDeadline) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(`临时 E2E 目录仍被系统占用，稍后可清理：${tempHome}`);
});

test.describe("Phase 12 插件生命周期真实 E2E", () => {
  test("dev loop：install → enable → invoke-tool echo → reload → disable → uninstall", async () => {
    // dev install（Showcase 目录，node-process）
    const install = await api("/api/plugins/dev/install", {
      method: "POST",
      body: { sourceDir: SHOWCASE_DIR, fullAccess: true },
    });
    expect(install.status).toBe(201);
    const installed = await install.json() as { pluginId: string; devRunId: string; status: string };
    expect(installed.pluginId).toBe("example.sdk-showcase");
    expect(installed.devRunId).toBeTruthy();
    expect(installed.status).toBe("enabled");

    // enable（dev 槽已启用）→ 运行时应已启动
    const enabled = await api(`/api/plugins/dev/example.sdk-showcase/enable`, {
      method: "POST",
      body: { devRunId: installed.devRunId },
    });
    expect(enabled.status).toBe(200);

    // 工具调用需 Agent 绑定（权限模型：binding 层）
    const bound = await api("/api/agents/agent-e2e/plugins/example.sdk-showcase", {
      method: "PUT",
      body: { contributions: ["echo"] },
    });
    expect(bound.status).toBe(200);

    // invoke-tool echo：完整执行链（ToolService → RuntimeHost → Node worker）
    const invoked = await api(`/api/plugins/dev/example.sdk-showcase/invoke-tool`, {
      method: "POST",
      body: { devRunId: installed.devRunId, agentId: "agent-e2e", toolName: "echo", args: { text: "hello-plugin" } },
    });
    expect(invoked.status).toBe(200);
    const result = await invoked.json() as { ok: boolean; result?: { echoed?: string }; message?: string };
    expect(result.ok).toBe(true);
    expect(result.result?.echoed).toBe("hello-plugin");

    // reload（热重载）：新 devRunId
    const reloaded = await api(`/api/plugins/dev/example.sdk-showcase/reload`, {
      method: "POST",
      body: { devRunId: installed.devRunId },
    });
    expect(reloaded.status).toBe(200);
    const reloadState = await reloaded.json() as { devRunId?: string; status?: string };
    expect(reloadState.devRunId).toBeTruthy();
    expect(reloadState.devRunId).not.toBe(installed.devRunId);

    // 热重载后工具仍可调用（新 devRunId）
    const invokedAfter = await api(`/api/plugins/dev/example.sdk-showcase/invoke-tool`, {
      method: "POST",
      body: { devRunId: reloadState.devRunId, agentId: "agent-e2e", toolName: "echo", args: { text: "after-reload" } },
    });
    const afterResult = await invokedAfter.json() as { ok: boolean; result?: { echoed?: string } };
    expect(afterResult.ok).toBe(true);
    expect(afterResult.result?.echoed).toBe("after-reload");

    // disable → uninstall
    const disabled = await api(`/api/plugins/dev/example.sdk-showcase/disable`, {
      method: "POST",
      body: { devRunId: reloadState.devRunId },
    });
    expect(disabled.status).toBe(200);
    const uninstalled = await api(`/api/plugins/dev/example.sdk-showcase/uninstall`, {
      method: "POST",
      body: { devRunId: reloadState.devRunId },
    });
    expect(uninstalled.status).toBe(200);
  });

  test("正式路径：inspect → install（授权）→ enable → Agent 绑定 → 详情富字段 → 卸载", async () => {
    // local 来源：直接指向仓库内 Showcase 目录（node_modules 可达，worker 可解析 SDK 依赖；
    // local 安装的依赖链接按源码目录向上查找 node_modules）
    const sourceRef = { sourceType: "local", ref: SHOWCASE_DIR };

    // inspect
    const inspected = await api("/api/plugins/inspect", {
      method: "POST",
      body: { sourceRef },
    });
    expect(inspected.status).toBe(200);
    const inspection = await inspected.json() as { pluginId: string; compatibility: { supported: boolean } };
    expect(inspection.pluginId).toBe("example.sdk-showcase");
    expect(inspection.compatibility.supported).toBe(true);

    // install（授权：tool.register 已在 Manifest 声明）
    const installed = await api("/api/plugins/install", {
      method: "POST",
      body: {
        sourceRef,
        grants: [{ pluginId: "example.sdk-showcase", capability: "tool.register", decision: "allowed", reason: "E2E 授权" }],
      },
    });
    expect(installed.status).toBe(201);

    // enable：运行时启动（node-process worker）
    const enabled = await api("/api/plugins/example.sdk-showcase/enable", { method: "POST" });
    expect(enabled.status).toBe(200);

    // Agent 绑定
    const bound = await api("/api/agents/agent-e2e/plugins/example.sdk-showcase", {
      method: "PUT",
      body: { contributions: ["echo"] },
    });
    expect(bound.status).toBe(200);
    const bindings = await api("/api/agents/agent-e2e/plugins");
    expect(bindings.status).toBe(200);
    const bindingList = await bindings.json() as Array<{ pluginId: string; enabled: boolean }>;
    expect(bindingList.some((b) => b.pluginId === "example.sdk-showcase" && b.enabled)).toBe(true);

    // 详情富字段（P1 契约）：name/grants/runtime/rollbackAvailable/surfaces
    const detail = await api("/api/plugins/example.sdk-showcase");
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      name?: string;
      enabled?: boolean;
      grants?: unknown[];
      surfaces?: unknown[];
      runtime?: { status?: string; health?: boolean };
      rollbackAvailable?: boolean;
    };
    expect(detailBody.name).toBe("SDK Showcase");
    expect(detailBody.enabled).toBe(true);
    expect(Array.isArray(detailBody.grants)).toBe(true);
    expect(Array.isArray(detailBody.surfaces)).toBe(true);
    expect(detailBody.runtime?.health).toBe(true);

    // 资产路由（Surface 静态资源）
    const asset = await fetch(`http://127.0.0.1:${supervisorPort}/api/plugins/example.sdk-showcase/assets/ui/chat.html`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("Chat Surface");

    // 卸载
    const uninstalled = await api("/api/plugins/example.sdk-showcase", { method: "DELETE" });
    expect(uninstalled.status).toBe(200);
    const afterList = await api("/api/plugins");
    const listBody = await afterList.json() as Array<{ pluginId: string }>;
    expect(listBody.some((p) => p.pluginId === "example.sdk-showcase")).toBe(false);
  });
});
