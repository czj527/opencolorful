import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { PLATFORM_VERSION } from "../../src/index.js";
import { getRuntimePaths } from "../../src/config/paths.js";
import { ClientRegistry } from "../../src/server/ws/client-registry.js";
import { AuditRecorder } from "../../src/observability/audit-recorder.js";
import { EventReplayStore } from "../../src/runtime/event-replay-store.js";
import { PromptService } from "../../src/runtime/prompt-service.js";
import { SessionIndex } from "../../src/storage/session-index.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { startForegroundServer, type RunningServer } from "../../src/server/start.js";
import { startSupervisor, type RunningSupervisor } from "../../src/supervisor/start.js";
import type { SupervisorStatusResponse } from "../../src/supervisor/types.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { serverTokenFilePath } from "../../src/server/trust-boundary.js";

/**
 * P0-1 本机 HTTP/WS 信任边界负例/正例套件（L4 集成层）。
 *
 * 全部走真实监听端口（随机）+ 隔离 OPENCOLORFUL_HOME 临时目录，直接用原生
 * fetch / node:http / WebSocket 构造攻击者与受信客户端请求，不经任何测试
 * harness 注入；伪造 Host 用 node:http（fetch 会按规范丢弃自定义 Host 头）。
 */

const temporaryDirectories: string[] = [];
const runningServers: RunningServer[] = [];
const disposableResources: Array<{ dispose(): void }> = [];

afterEach(async () => {
  for (const server of runningServers.splice(0)) {
    await server.stop().catch(() => {});
  }
  for (const resource of disposableResources.splice(0)) {
    resource.dispose();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

interface ServerFixture {
  server: RunningServer;
  baseUrl: string;
}

async function startIsolatedServer(): Promise<ServerFixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-trust-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  const database = openMetadataDatabase(paths.database);
  const sessionService = new SessionService(paths, new SessionIndex(database));
  const promptService = new PromptService();
  const audit = new AuditRecorder({
    database,
    producer: {
      component: "agent-server",
      processType: "server",
      processId: String(process.pid),
      bootId: "trust-boundary-test",
      appVersion: PLATFORM_VERSION,
      hostPlatform: process.platform,
    },
  });
  const replayStore = new EventReplayStore();
  const server = await startForegroundServer({
    host: "127.0.0.1",
    port: 0,
    paths,
    version: PLATFORM_VERSION,
    appOptions: {
      sessionService,
      promptService,
      replayStore,
      audit,
      wsRegistry: new ClientRegistry(),
      wsPromptService: promptService,
      wsReplayStore: replayStore,
    },
  });
  runningServers.push(server);
  // 资源释放顺序：Server → 业务资源（DB 句柄不关，Windows 下临时目录删不掉）
  disposableResources.push({
    dispose() {
      promptService.dispose();
      sessionService.closeAll();
      database.close();
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

function post(baseUrl: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/api/sessions`, { method: "POST", headers, body });
}

const VALID_BODY = JSON.stringify({ title: "边界测试", cwd: process.cwd() });

/** node:http 原始请求：可任意伪造 Host 头（undici fetch 会丢弃自定义 Host） */
function rawRequest(
  port: number,
  options: { method: string; path: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number | undefined }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.headers },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

describe("trust boundary：HTTP 负例", () => {
  it("跨站简单请求（恶意 Origin + text/plain + 无令牌）→ 403，不回显请求内容", async () => {
    const { baseUrl } = await startIsolatedServer();
    const response = await post(baseUrl, VALID_BODY, {
      "content-type": "text/plain",
      "origin": "https://evil.example",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("FORBIDDEN");
    expect(body.message).not.toContain("边界测试");
  });

  it("伪造 Host → 403（读/写一致，DNS-rebinding 防御）", async () => {
    const { server } = await startIsolatedServer();
    const forgedWrite = await rawRequest(server.port, {
      method: "POST",
      path: "/api/sessions",
      headers: {
        "host": "evil.example",
        "content-type": "application/json",
        "authorization": `Bearer ${server.token}`,
      },
      body: VALID_BODY,
    });
    expect(forgedWrite.status).toBe(403);

    const forgedRead = await rawRequest(server.port, {
      method: "GET",
      path: "/api/health",
      headers: { host: "evil.example" },
    });
    expect(forgedRead.status).toBe(403);
  });

  it("Host 头缺失（HTTP/1.0 原始请求）→ 403", async () => {
    const { server } = await startIsolatedServer();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const client = net.connect({ host: "127.0.0.1", port: server.port }, () => {
        // HTTP/1.0 允许省略 Host 头：直接写原始报文
        client.write("GET /api/health HTTP/1.0\r\n\r\n");
      });
      let data = "";
      client.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      client.on("error", reject);
      client.on("close", () => {
        resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? NaN) || undefined);
      });
    });
    expect(status).toBe(403);
  });

  it("写请求缺令牌 → 403；错令牌 → 403", async () => {
    const { baseUrl } = await startIsolatedServer();
    const missing = await post(baseUrl, VALID_BODY, { "content-type": "application/json" });
    expect(missing.status).toBe(403);

    const wrong = await post(baseUrl, VALID_BODY, {
      "content-type": "application/json",
      "authorization": `Bearer ${"ab".repeat(32)}`,
    });
    expect(wrong.status).toBe(403);
  });

  it("text/plain 请求体（即使带有效令牌）→ 415", async () => {
    const { server, baseUrl } = await startIsolatedServer();
    const response = await post(baseUrl, VALID_BODY, {
      "content-type": "text/plain",
      "authorization": `Bearer ${server.token}`,
    });
    expect(response.status).toBe(415);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("X-OC-Token 是合法令牌通道", async () => {
    const { server, baseUrl } = await startIsolatedServer();
    const response = await post(baseUrl, VALID_BODY, {
      "content-type": "application/json",
      "x-oc-token": server.token,
    });
    expect(response.status).toBe(201);
  });
});

describe("trust boundary：WS 握手", () => {
  function handshake(
    url: string,
    options?: { origin?: string },
  ): Promise<{ opened: boolean; status?: number | undefined }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, options !== undefined ? { origin: options.origin } : undefined);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve({ opened: false });
      }, 3_000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve({ opened: true });
      });
      ws.on("error", (error: Error) => {
        clearTimeout(timer);
        // ws 客户端错误形如 "Unexpected server response: 403"
        const status = /(\d{3})/.exec(error.message)?.[1];
        resolve({ opened: false, status: status !== undefined ? Number(status) : undefined });
      });
    });
  }

  it("恶意 Origin 的 WS 握手 → 拒绝（403）", async () => {
    const { server } = await startIsolatedServer();
    const evil = await handshake(`ws://127.0.0.1:${server.port}/ws`, { origin: "https://evil.example" });
    expect(evil.opened).toBe(false);
    expect(evil.status).toBe(403);
  });

  it("无 Origin 且无令牌的 WS 握手 → 拒绝（403）", async () => {
    const { server } = await startIsolatedServer();
    const anonymous = await handshake(`ws://127.0.0.1:${server.port}/ws`);
    expect(anonymous.opened).toBe(false);
    expect(anonymous.status).toBe(403);
  });

  it("带合法 ?token= 的 WS 握手 → 建连", async () => {
    const { server } = await startIsolatedServer();
    const result = await handshake(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`);
    expect(result.opened).toBe(true);
  });

  it("本机 Origin 的 WS 握手（无令牌）→ 建连", async () => {
    const { server } = await startIsolatedServer();
    const result = await handshake(`ws://127.0.0.1:${server.port}/ws`, {
      origin: `http://127.0.0.1:${server.port}`,
    });
    expect(result.opened).toBe(true);
  });
});

describe("trust boundary：正例（受信客户端）", () => {
  it("本机 Origin + 令牌写请求 → 201", async () => {
    const { server, baseUrl } = await startIsolatedServer();
    const response = await post(baseUrl, VALID_BODY, {
      "content-type": "application/json",
      "authorization": `Bearer ${server.token}`,
      "origin": `http://127.0.0.1:${server.port}`,
    });
    expect(response.status).toBe(201);
  });

  it("无 Origin（curl 式）+ 令牌写请求 → 201", async () => {
    const { server, baseUrl } = await startIsolatedServer();
    const response = await post(baseUrl, VALID_BODY, {
      "content-type": "application/json",
      "authorization": `Bearer ${server.token}`,
    });
    expect(response.status).toBe(201);
  });

  it("GET 无令牌本机读请求 → 200（读请求只受 Host 约束）", async () => {
    const { baseUrl } = await startIsolatedServer();
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
  });

  it("带令牌的恶意 Origin 写请求 → 放行（令牌优先）", async () => {
    const { server, baseUrl } = await startIsolatedServer();
    const response = await post(baseUrl, VALID_BODY, {
      "content-type": "application/json",
      "authorization": `Bearer ${server.token}`,
      "origin": "https://evil.example",
    });
    expect(response.status).toBe(201);
  });

  it("Content-Type 容忍 charset 后缀", async () => {
    const { server, baseUrl } = await startIsolatedServer();
    const response = await post(baseUrl, VALID_BODY, {
      "content-type": "application/json; charset=utf-8",
      "authorization": `Bearer ${server.token}`,
    });
    expect(response.status).toBe(201);
  });
});

describe("trust boundary：令牌解析与持久化", () => {
  it("启动生成令牌并落盘（0600），重启复用同一令牌", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-trust-persist-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });

    const first = await startForegroundServer({ host: "127.0.0.1", port: 0, paths, version: PLATFORM_VERSION });
    runningServers.push(first);
    const tokenPath = serverTokenFilePath(paths.runtime);
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(fs.readFileSync(tokenPath, "utf8").trim()).toBe(first.token);
    // 0600：属主之外不可读（POSIX；Windows 文件权限模型不同，跳过）
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenPath).mode & 0o077).toBe(0);
    }

    const second = await (async () => {
      // 同一 home 的服务锁互斥：先停第一个实例再验证重启复用同一令牌
      await first.stop();
      return startForegroundServer({ host: "127.0.0.1", port: 0, paths, version: PLATFORM_VERSION });
    })();
    runningServers.push(second);
    expect(second.token).toBe(first.token);
  });

  it("env OPENCOLORFUL_SERVER_TOKEN 优先于令牌文件", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-trust-env-"));
    temporaryDirectories.push(directory);
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
    fs.mkdirSync(paths.runtime, { recursive: true });
    fs.writeFileSync(serverTokenFilePath(paths.runtime), "file-token", "utf8");

    process.env.OPENCOLORFUL_SERVER_TOKEN = "env-token-value";
    try {
      const server = await startForegroundServer({
        host: "127.0.0.1",
        port: 0,
        paths,
        version: PLATFORM_VERSION,
      });
      runningServers.push(server);
      expect(server.token).toBe("env-token-value");
      // 令牌文件不被 env 方案覆写
      expect(fs.readFileSync(serverTokenFilePath(paths.runtime), "utf8").trim()).toBe("file-token");
      const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer env-token-value",
        },
        body: VALID_BODY,
      });
      expect(response.status).toBe(201);
    } finally {
      delete process.env.OPENCOLORFUL_SERVER_TOKEN;
    }
  });
});

describe("trust boundary：supervisor origin-guard 模式（写请求）", () => {
  // 真实 Supervisor（随机端口 + 隔离 home，拉起真实 Agent Server 子进程），
  // 逐条验证 origin-guard 写请求语义——尤其"本机 Origin 无令牌放行"这条
  // 真实浏览器同源路径（评审修复：原实现两个无令牌子分支都拒绝，与设计矛盾）。
  const CLI_ENTRY = path.resolve(import.meta.dirname, "../../src/cli/main.ts");

  let supervisor: RunningSupervisor | null = null;
  let supervisorPort = 0;
  let supervisorHome = "";

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("无法获取端口"));
        }
        probe.close();
      });
      probe.on("error", reject);
    });
  }

  async function waitForAgentOnline(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${supervisorPort}/api/supervisor/status`);
      const body = (await response.json()) as SupervisorStatusResponse;
      if (body.agentServer.status === "online") return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("等待 agent server online 超时");
  }

  function postSupervisor(pathname: string, headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${supervisorPort}${pathname}`, { method: "POST", headers });
  }

  beforeAll(async () => {
    supervisorHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-supervisor-guard-"));
    const paths = getRuntimePaths({ OPENCOLORFUL_HOME: supervisorHome });
    supervisorPort = await freePort();
    supervisor = await startSupervisor({
      paths,
      supervisorPort,
      agentServerPort: await freePort(),
      entryScript: CLI_ENTRY,
    });
    await waitForAgentOnline();
  }, 60_000);

  afterAll(async () => {
    if (supervisor !== null) {
      await supervisor.stop().catch(() => {});
      supervisor = null;
    }
    // Windows 子进程句柄释放有延迟：重试清理，失败仅告警
    try {
      fs.rmSync(supervisorHome, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    } catch {
      console.warn(`清理临时目录失败（可手动删除）: ${supervisorHome}`);
    }
  });

  it("浏览器同源形态：本机 Origin、无令牌写控制面 → 2xx（端到端语义）", async () => {
    // Origin 恰为 Supervisor 自身源、不带任何令牌——同源浏览器 UI 的真实请求形态
    const response = await postSupervisor("/api/supervisor/stop", {
      origin: `http://127.0.0.1:${supervisorPort}`,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "stopped" });
  }, 30_000);

  it("恶意 Origin 无令牌 → 403（跨站主防线）", async () => {
    const response = await postSupervisor("/api/supervisor/start", { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("无 Origin 无令牌 → 403（Node 端脚本写须持令牌）", async () => {
    const response = await postSupervisor("/api/supervisor/start", {});
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
  });

  it("带有效令牌 → 2xx（令牌优先，恶意 Origin 亦放行）", async () => {
    const response = await postSupervisor("/api/supervisor/start", {
      "origin": "https://evil.example",
      "x-oc-token": supervisor!.token,
    });
    expect(response.status).toBe(201);
  }, 30_000);
});
