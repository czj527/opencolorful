/**
 * L6 真链冒烟 · 后端引导进程（由 fixtures/backend.ts 以 `node --import tsx` 拉起）
 *
 * 职责：
 * 1. 启动本地 OpenAI 兼容 stub Provider（协议面与 PI SDK openai-completions 客户端对接，
 *    仅监听 127.0.0.1 随机端口；第 1 次请求慢速流式（供 abort 断言），其后请求快速返回）；
 * 2. 以 `startForegroundServer({ port: 0 })` 启动真实 Agent Server（与 packaged 模式
 *    main.cjs 内嵌启动同一条代码路径；port 0 = 由内核分配空闲端口，fixture 不绑死端口假设）；
 * 3. ready 后向 stdout 打印一行 JSON（serverPort/stubPort），stdin 收到 shutdown 后优雅停止并退出。
 *
 * 隔离约定：本进程的全部落盘都在 OPENCOLORFUL_HOME 指向的临时目录内，不触碰用户真实 home。
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { getRuntimePaths } from "../../../../src/config/paths.js";
import { startForegroundServer } from "../../../../src/server/start.js";

const logPath = process.env.OC_E2E_LOG ?? "";
function log(message: string): void {
  const line = `${new Date().toISOString()} [bootstrap] ${message}`;
  process.stderr.write(`${line}\n`);
  if (logPath !== "") {
    try {
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      // 日志失败不影响主流程
    }
  }
}

/* ---- stub Provider（OpenAI chat.completions SSE 兼容，仅本地回环） ---- */

const ABORT_TEXT = process.env.OC_E2E_ABORT_TEXT ?? "oc-e2e-中止回复：这段文本以慢速流式输出，用于验证流式可见与停止按钮。";
const ABORT_CHUNKS = Number(process.env.OC_E2E_ABORT_CHUNKS ?? "30");
const ABORT_INTERVAL_MS = Number(process.env.OC_E2E_ABORT_INTERVAL_MS ?? "300");
const DONE_TEXT = process.env.OC_E2E_DONE_TEXT ?? "oc-e2e-完成回复：第二轮回复完整返回，用于验证消息定稿与持久化。";
const DONE_CHUNKS = Number(process.env.OC_E2E_DONE_CHUNKS ?? "4");
const DONE_INTERVAL_MS = Number(process.env.OC_E2E_DONE_INTERVAL_MS ?? "40");

function chunkFrame(content: string): string {
  const payload = {
    id: "chatcmpl-oc-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "oc-e2e-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const FINAL_FRAME = `data: ${JSON.stringify({
  id: "chatcmpl-oc-e2e",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "oc-e2e-model",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
})}\n\n`;

const USAGE_FRAME = `data: ${JSON.stringify({
  id: "chatcmpl-oc-e2e",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "oc-e2e-model",
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})}\n\n`;

function splitChunks(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / count));
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

let stubRequestCount = 0;

const stubServer = http.createServer((request, response) => {
  const url = request.url ?? "";
  if (request.method !== "POST" || !url.endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `stub 收到未知请求: ${request.method} ${url}` } }));
    return;
  }
  stubRequestCount += 1;
  const requestNumber = stubRequestCount;
  const isFirstRequest = requestNumber === 1;
  // 约定：第 1 次请求 = 首条消息（慢速流式，供流式断言与 abort 留窗）；其余请求快速完整返回
  const chunks = isFirstRequest
    ? splitChunks(ABORT_TEXT, ABORT_CHUNKS)
    : splitChunks(DONE_TEXT, DONE_CHUNKS);
  const interval = isFirstRequest ? ABORT_INTERVAL_MS : DONE_INTERVAL_MS;
  log(`stub 请求 #${requestNumber}：${chunks.length} 片段 × ${interval}ms`);

  request.resume(); // 丢弃请求体
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // 客户端 abort（服务端 runtime abort → fetch 断开）检测必须挂在 response 上：
  // request 流的 'close' 在请求体被消费完（resume）后即触发，不是 abort 信号。
  response.on("error", () => undefined);
  let finished = false;
  response.on("close", () => {
    if (!finished) {
      log(`stub 请求 #${requestNumber} 客户端断开（abort 语义）`);
    }
  });
  response.write(chunkFrame(""));

  let index = 0;
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(timer);
      return;
    }
    if (index < chunks.length) {
      response.write(chunkFrame(chunks[index]));
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

/* ---- Agent Server ---- */

async function main(): Promise<void> {
  const home = process.env.OPENCOLORFUL_HOME ?? "";
  if (home.trim() === "") {
    throw new Error("OPENCOLORFUL_HOME 未设置：引导进程拒绝在无隔离目录的情况下启动");
  }

  await new Promise<void>((resolve) => {
    stubServer.listen(0, "127.0.0.1", resolve);
  });
  const stubPort = (stubServer.address() as AddressInfo).port;
  log(`stub provider online: http://127.0.0.1:${stubPort}/v1/chat/completions`);

  const paths = getRuntimePaths();
  const server = await startForegroundServer({
    host: "127.0.0.1",
    port: 0,
    paths,
    version: "oc-e2e-smoke",
  });
  log(`agent server online: http://127.0.0.1:${server.port} (home=${home})`);

  // ready 行：fixture 以此判定端口，再自行轮询 /api/health 确认可用
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
        // stub close 兜底：有活跃连接时 2s 后强退
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
