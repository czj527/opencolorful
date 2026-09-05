/**
 * B3 lane（branches/workbench）· 后端引导进程（由 fixtures/lane-b3/backend.ts 以 `node --import tsx` 拉起）。
 *
 * 与 lane-a4b 引导的差异（lane 本地 fixture，不改共享文件）：
 * - 保留 stub Provider（fast/slow 可切换）用于 409 busy 场景（slow turn 进行中尝试分支操作）；
 * - 无 circuit proxy（B3 不做断线注入）。
 *
 * 隔离约定：本进程全部落盘都在 OPENCOLORFUL_HOME 指向的临时目录内；stub 仅监听 127.0.0.1。
 */
import fs from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { getRuntimePaths } from "../../../../../src/config/paths.js";
import { startForegroundServer } from "../../../../../src/server/start.js";

const logPath = process.env.OC_E2E_LOG ?? "";
function log(message: string): void {
  const line = `${new Date().toISOString()} [lane-b3-bootstrap] ${message}`;
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

type StubMode = "fast" | "slow";

interface StubConfig {
  mode: StubMode;
  chunks: number;
  intervalMs: number;
  text: string;
}

const DEFAULT_TEXT = "oc-e2e-lane-b3回复：B3 真链回归的完整回复，用于验证定稿与持久化。";

const stubConfig: StubConfig = {
  mode: "fast",
  chunks: 4,
  intervalMs: 20,
  text: DEFAULT_TEXT,
};

let stubRequestCount = 0;

function chunkFrame(content: string): string {
  const payload = {
    id: "chatcmpl-oc-e2e-lane-b3",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "oc-e2e-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const FINAL_FRAME = `data: ${JSON.stringify({
  id: "chatcmpl-oc-e2e-lane-b3",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "oc-e2e-model",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
})}\n\n`;

const USAGE_FRAME = `data: ${JSON.stringify({
  id: "chatcmpl-oc-e2e-lane-b3",
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
  if (url.startsWith("/__b3__/")) {
    void (async () => {
      if (method === "POST" && url.startsWith("/__b3__/config")) {
        const body = await readBody(request);
        try {
          const patch = JSON.parse(body) as Partial<StubConfig>;
          if (patch.mode !== undefined) stubConfig.mode = patch.mode;
          if (patch.chunks !== undefined) stubConfig.chunks = patch.chunks;
          if (patch.intervalMs !== undefined) stubConfig.intervalMs = patch.intervalMs;
          if (patch.text !== undefined) stubConfig.text = patch.text;
          stubRequestCount = 0;
          log(`stub 配置更新：mode=${stubConfig.mode} chunks=${stubConfig.chunks} intervalMs=${stubConfig.intervalMs}`);
          respondJson(response, 200, { ok: true, mode: stubConfig.mode });
        } catch (error) {
          respondJson(response, 400, { ok: false, message: String(error) });
        }
        return;
      }
      if (method === "GET" && url.startsWith("/__b3__/state")) {
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
  }, interval);
});

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
    version: "oc-e2e-lane-b3",
  });
  log(`agent server online: http://127.0.0.1:${server.port} (home=${home})`);

  // ready 行：lane fixture 以此判定端口，再自行轮询 /api/health 确认可用
  process.stdout.write(`${JSON.stringify({ type: "ready", serverPort: server.port, stubPort })}\n`);

  let stopping = false;
  const shutdown = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutdown: ${reason}`);
    void server.stop()
      .catch((error: unknown) => log(`server.stop 失败: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        stubServer.close(() => process.exit(0));
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
