/**
 * B4/B5 lane · 后端引导进程（由 fixtures/lane-b45/backend.ts 以 `node --import tsx` 拉起）。
 *
 * 与 lane-b3/server-bootstrap.ts 同构（隔离 home + ready 行 + stdin shutdown），差异：
 * 1. stub 只有两种行为，经控制端口切换：
 *    - mode=text：纯文本流式回复（text 可超长，供压缩 token 门槛）；
 *    - mode=todo_tool：第 1 次请求回流式 tool_calls(todo_write)（arguments 分片增量），
 *      第 2 次请求（tool result 回传后）回文本「待办清单已更新。」——PI 执行
 *      todo_write → SessionTodoStore.replace → todo.updated 事件。
 * 2. 无 circuit proxy——app 直连 Agent Server。
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
  const line = `${new Date().toISOString()} [lane-b45-bootstrap] ${message}`;
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

type StubMode = "text" | "todo_tool";

interface StubConfig {
  mode: StubMode;
  /** text 模式：回复文本 */
  text: string;
  /** todo_tool 模式：todo_write 的 arguments JSON（整体替换列表） */
  todosJson: string;
  /** todo_tool 模式已收到的请求计数（1 → tool_calls，2 → 文本收尾） */
  todoCalls: number;
}

const stubConfig: StubConfig = {
  mode: "text",
  text: "oc-e2e-b45 短回复。",
  todosJson: "[]",
  todoCalls: 0,
};

let stubRequestCount = 0;

function chunkFrame(delta: Record<string, unknown>, finishReason: string | null): string {
  const payload = {
    id: "chatcmpl-oc-e2e-b45",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "oc-e2e-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function finalStopFrame(): string {
  return chunkFrame({}, "stop");
}

function usageFrame(): string {
  const payload = {
    id: "chatcmpl-oc-e2e-b45",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "oc-e2e-model",
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textDeltas(text: string, chunks: number): string {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, chunks)));
  let out = "";
  for (let index = 0; index < text.length; index += size) {
    out += chunkFrame({ content: text.slice(index, index + size) }, null);
  }
  return out;
}

/** 流式 tool_calls：首帧携带 id/name（空 arguments），arguments 分片增量，最后 finish_reason=tool_calls */
function toolCallFrames(toolCallId: string, name: string, argsJson: string): string {
  let out = chunkFrame(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name, arguments: "" } }],
    },
    null,
  );
  const size = Math.max(1, Math.ceil(argsJson.length / 4));
  for (let index = 0; index < argsJson.length; index += size) {
    out += chunkFrame(
      { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(index, index + size) } }] },
      null,
    );
  }
  out += chunkFrame({}, "tool_calls");
  return out;
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

function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

const stubServer = http.createServer((request, response) => {
  const url = request.url ?? "";
  const method = request.method ?? "";

  /* 控制面：stub 行为配置（lane harness 调用） */
  if (url.startsWith("/__b45__/")) {
    void (async () => {
      if (method === "POST" && url.startsWith("/__b45__/config")) {
        const body = await readBody(request);
        try {
          const patch = JSON.parse(body) as Partial<StubConfig>;
          if (patch.mode !== undefined) stubConfig.mode = patch.mode;
          if (patch.text !== undefined) stubConfig.text = patch.text;
          if (patch.todosJson !== undefined) stubConfig.todosJson = patch.todosJson;
          stubConfig.todoCalls = 0;
          stubRequestCount = 0;
          log(`stub 配置更新：mode=${stubConfig.mode} textLen=${stubConfig.text.length} todosJsonLen=${stubConfig.todosJson.length}`);
          respondJson(response, 200, { ok: true, mode: stubConfig.mode });
        } catch (error) {
          respondJson(response, 400, { ok: false, message: String(error) });
        }
        return;
      }
      if (method === "GET" && url.startsWith("/__b45__/state")) {
        respondJson(response, 200, {
          mode: stubConfig.mode,
          requestCount: stubRequestCount,
          todoCalls: stubConfig.todoCalls,
        });
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

  void (async () => {
    await readBody(request);

    if (stubConfig.mode === "todo_tool") {
      stubConfig.todoCalls += 1;
      log(`stub 请求 #${requestNumber} → todo_tool（第 ${stubConfig.todoCalls} 次）`);
      if (stubConfig.todoCalls === 1) {
        startSse(response);
        response.write(chunkFrame({ role: "assistant" }, null));
        response.write(toolCallFrames("call_oc_e2e_b45_1", "todo_write", stubConfig.todosJson));
        response.write(usageFrame());
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      startSse(response);
      response.write(chunkFrame({ role: "assistant" }, null));
      response.write(textDeltas("待办清单已更新。", 2));
      response.write(finalStopFrame());
      response.write(usageFrame());
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    const text = stubConfig.text;
    log(`stub 请求 #${requestNumber} → text（len=${text.length}）`);
    startSse(response);
    response.write(chunkFrame({ role: "assistant" }, null));
    response.write(textDeltas(text, 8));
    response.write(finalStopFrame());
    response.write(usageFrame());
    response.write("data: [DONE]\n\n");
    response.end();
  })();
});

/* ---------------------------------------------------------------------------
 * 主流程（与 lane-b3 主流程同构：home 检查 → Agent Server → ready 行 → shutdown）
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
    version: "oc-e2e-lane-b45",
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
