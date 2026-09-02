/**
 * A4b lane（chat/stream/recovery）· 后端引导进程（由 fixtures/lane-a4b/backend.ts 以 `node --import tsx` 拉起）。
 *
 * 与共享冒烟引导（fixtures/server-bootstrap.ts）的差异（lane 本地 fixture，不改共享文件）：
 * 1. stub Provider 行为可经控制端口切换（fast/slow/error-401/error-429/timeout-reset），
 *    用于 CHAT-06 的错 Key / 限流 / 超时渲染回归；
 * 2. Agent Server 前置一个本地转发代理（circuit proxy）：app 经 OPENCOLORFUL_SERVER_URL 指向代理，
 *    控制端点可断开/恢复代理转发（socket 直接 destroy，等效网络断线），
 *    用于 CHAT-05 的 IPC 断线语义回归——不 kill 真实 Agent Server 进程（隔离红线：不注入进程失败）。
 * 3. ready 行额外携带 proxyPort。
 *
 * 隔离约定：本进程全部落盘都在 OPENCOLORFUL_HOME 指向的临时目录内；stub/代理仅监听 127.0.0.1。
 */
import fs from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { getRuntimePaths } from "../../../../../src/config/paths.js";
import { startForegroundServer } from "../../../../../src/server/start.js";

const logPath = process.env.OC_E2E_LOG ?? "";
function log(message: string): void {
  const line = `${new Date().toISOString()} [lane-a4b-bootstrap] ${message}`;
  process.stderr.write(`${line}\n`);
  if (logPath !== "") {
    try {
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      // 日志失败不影响主流程
    }
  }
}

/* ---------------------------------------------------------------------------
 * stub Provider（OpenAI chat.completions SSE 兼容，仅本地回环）
 * ------------------------------------------------------------------------ */

type StubMode = "fast" | "slow" | "error-401" | "error-429" | "timeout-reset";

interface StubConfig {
  mode: StubMode;
  /** fast/slow 模式：分片数与间隔 */
  chunks: number;
  intervalMs: number;
  /** fast/slow 模式：完整回复文本 */
  text: string;
  /** timeout-reset 模式：挂起后销毁 socket 的延迟 */
  delayMs: number;
}

const DEFAULT_TEXT = "oc-e2e-lane回复：A4b 真链回归的完整回复，用于验证定稿与持久化。";

const stubConfig: StubConfig = {
  mode: "fast",
  chunks: 4,
  intervalMs: 20,
  text: DEFAULT_TEXT,
  delayMs: 2_500,
};

let stubRequestCount = 0;

function chunkFrame(content: string): string {
  const payload = {
    id: "chatcmpl-oc-e2e-lane",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "oc-e2e-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const FINAL_FRAME = `data: ${JSON.stringify({
  id: "chatcmpl-oc-e2e-lane",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "oc-e2e-model",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
})}\n\n`;

const USAGE_FRAME = `data: ${JSON.stringify({
  id: "chatcmpl-oc-e2e-lane",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "oc-e2e-model",
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})}\n\n`;

function splitChunks(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, count)));
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", () => resolve(body));
  });
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

const stubServer = http.createServer((request, response) => {
  const url = request.url ?? "";
  const method = request.method ?? "";

  /* 控制面：stub 行为配置（lane harness 调用） */
  if (url.startsWith("/__a4b__/")) {
    void (async () => {
      if (method === "POST" && url.startsWith("/__a4b__/config")) {
        const body = await readBody(request);
        try {
          const patch = JSON.parse(body) as Partial<StubConfig>;
          if (patch.mode !== undefined) stubConfig.mode = patch.mode;
          if (patch.chunks !== undefined) stubConfig.chunks = patch.chunks;
          if (patch.intervalMs !== undefined) stubConfig.intervalMs = patch.intervalMs;
          if (patch.text !== undefined) stubConfig.text = patch.text;
          if (patch.delayMs !== undefined) stubConfig.delayMs = patch.delayMs;
          stubRequestCount = 0;
          log(`stub 配置更新：mode=${stubConfig.mode} chunks=${stubConfig.chunks} intervalMs=${stubConfig.intervalMs} delayMs=${stubConfig.delayMs}`);
          respondJson(response, 200, { ok: true, mode: stubConfig.mode });
        } catch (error) {
          respondJson(response, 400, { ok: false, message: String(error) });
        }
        return;
      }
      if (method === "GET" && url.startsWith("/__a4b__/state")) {
        respondJson(response, 200, { mode: stubConfig.mode, requestCount: stubRequestCount });
        return;
      }
      respondJson(response, 404, { ok: false });
    })();
    return;
  }

  /* 模型面：OpenAI 兼容 chat.completions */
  if (method !== "POST" || !url.endsWith("/chat/completions")) {
    respondJson(response, 404, { error: { message: `stub 收到未知请求: ${method} ${url}` } });
    return;
  }
  stubRequestCount += 1;
  const requestNumber = stubRequestCount;

  if (stubConfig.mode === "error-401") {
    log(`stub 请求 #${requestNumber} → 401`);
    respondJson(response, 401, { error: { message: "oc-e2e-lane 无效的 API Key（stub 401）" } });
    return;
  }
  if (stubConfig.mode === "error-429") {
    log(`stub 请求 #${requestNumber} → 429`);
    respondJson(response, 429, { error: { message: "oc-e2e-lane rate limit exceeded（stub 429）" } });
    return;
  }
  if (stubConfig.mode === "timeout-reset") {
    log(`stub 请求 #${requestNumber} → 挂起 ${stubConfig.delayMs}ms 后断开（超时近似）`);
    const socket = request.socket;
    setTimeout(() => {
      if (!response.writableEnded) {
        socket.destroy();
        log(`stub 请求 #${requestNumber} socket 已销毁`);
      }
    }, stubConfig.delayMs).unref();
    request.resume();
    return;
  }

  // fast / slow：SSE 流式
  const chunks = splitChunks(stubConfig.text, stubConfig.chunks);
  const interval = stubConfig.intervalMs;
  log(`stub 请求 #${requestNumber}：mode=${stubConfig.mode}，${chunks.length} 片段 × ${interval}ms`);
  request.resume();
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.on("error", () => undefined);
  let finished = false;
  response.on("close", () => {
    if (!finished) log(`stub 请求 #${requestNumber} 客户端断开（abort 语义）`);
  });
  response.write(chunkFrame(""));

  let index = 0;
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(timer);
      return;
    }
    if (index < chunks.length) {
      response.write(chunkFrame(chunks[index] ?? ""));
      index += 1;
      return;
    }
    clearInterval(timer);
    response.write(FINAL_FRAME);
    response.write(USAGE_FRAME);
    response.write("data: [DONE]\n\n");
    response.end();
    finished = true;
  }, interval);
});

/* ---------------------------------------------------------------------------
 * circuit proxy（app → Agent Server 的本地转发代理；可断开/恢复转发）
 * ------------------------------------------------------------------------ */

let circuitOpen = false;
let serverPort = 0;

const proxyServer = http.createServer((request, response) => {
  const url = request.url ?? "";
  const method = request.method ?? "";

  /* 控制面：断路器（lane harness 调用；断开状态下的恢复指令也走这里） */
  if (url.startsWith("/__a4b__/")) {
    void (async () => {
      if (method === "POST" && url.startsWith("/__a4b__/circuit")) {
        const body = await readBody(request);
        try {
          const patch = JSON.parse(body) as { open?: boolean };
          circuitOpen = patch.open === true;
          log(`断路器 → ${circuitOpen ? "OPEN（app 侧断线）" : "CLOSED（恢复转发）"}`);
          respondJson(response, 200, { ok: true, open: circuitOpen });
        } catch (error) {
          respondJson(response, 400, { ok: false, message: String(error) });
        }
        return;
      }
      if (method === "GET" && url.startsWith("/__a4b__/circuit")) {
        respondJson(response, 200, { open: circuitOpen });
        return;
      }
      respondJson(response, 404, { ok: false });
    })();
    return;
  }

  if (circuitOpen) {
    // 等效网络断线：直接销毁 socket（main 侧 fetch → ECONNRESET，status 0）
    log(`断路器拦截：${method} ${url}`);
    request.socket.destroy();
    return;
  }

  const headers = { ...request.headers, host: `127.0.0.1:${serverPort}` };
  const upstream = http.request(
    { host: "127.0.0.1", port: serverPort, method, path: url, headers },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
      upstreamResponse.on("error", () => {
        try {
          response.destroy();
        } catch {
          // 已销毁
        }
      });
    },
  );
  upstream.on("error", () => {
    try {
      response.destroy();
    } catch {
      // 已销毁
    }
  });
  request.on("error", () => upstream.destroy());
  request.pipe(upstream);
});

// 长连 SSE：关闭代理侧全部超时
proxyServer.requestTimeout = 0;
proxyServer.headersTimeout = 0;
proxyServer.keepAliveTimeout = 0;

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------ */

function listen(server: http.Server, name: string): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      log(`${name} online: 127.0.0.1:${port}`);
      resolve(port);
    });
  });
}

async function main(): Promise<void> {
  const home = process.env.OPENCOLORFUL_HOME ?? "";
  if (home.trim() === "") {
    throw new Error("OPENCOLORFUL_HOME 未设置：引导进程拒绝在无隔离目录的情况下启动");
  }

  const stubPort = await listen(stubServer, "stub provider");
  const paths = getRuntimePaths();
  const server = await startForegroundServer({
    host: "127.0.0.1",
    port: 0,
    paths,
    version: "oc-e2e-lane-a4b",
  });
  serverPort = server.port;
  log(`agent server online: http://127.0.0.1:${serverPort} (home=${home})`);
  const proxyPort = await listen(proxyServer, "circuit proxy");

  // ready 行：lane fixture 以此判定端口，再自行轮询 /api/health 确认可用
  process.stdout.write(`${JSON.stringify({ type: "ready", serverPort: server.port, stubPort, proxyPort })}\n`);

  let stopping = false;
  const shutdown = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutdown: ${reason}`);
    void server.stop()
      .catch((error: unknown) => log(`server.stop 失败: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        stubServer.close(() => process.exit(0));
        proxyServer.close(() => process.exit(0));
        // close 兜底：有活跃连接时 2s 后强退
        setTimeout(() => process.exit(0), 2_000).unref();
      });
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    for (const line of data.split("\n")) {
      if (line.trim() === "shutdown") shutdown("stdin 指令");
    }
  });
  process.stdin.on("end", () => shutdown("stdin 关闭"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log(`bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
