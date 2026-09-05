/**
 * A4e lane（Subagent 子代理回归）· 后端引导进程（由 fixtures/lane-a4e/backend.ts 以 `node --import tsx` 拉起）。
 *
 * 与共享冒烟引导（fixtures/server-bootstrap.ts）/ lane-a4b 引导的差异（lane 本地 fixture，不改共享文件）：
 * 1. 无 circuit proxy：app 直连 Agent Server（本 lane 不做断线语义）；
 * 2. stub Provider 是「脚本化 openai-completions 流式 stub」——按请求特征分类回放：
 *    a) 父会话首轮（system 无子代理标记、messages 无 tool 角色、非记忆复盘）
 *       → 流式 tool_calls delta（spawn_subagent，arguments 分多片增量发送，
 *       显式 model=<stub provider/model>，消除 §10.2 模型解析歧义）；
 *    b) 子代理会话轮（system 含 SUBAGENT_SYSTEM_PROMPT 标记）
 *       → 首轮回 report_subagent_progress tool_call；次轮（有 tool 结果）
 *       回 report_subagent_result tool_call，但该响应被「门」挡住，
 *       直到控制面 POST /__a4e__/release 放行（用例据此在终态前断言运行中态；
 *       45s 自动放行兜底，防止用例崩溃后 Run 挂到 idle timeout）；
 *       结果已提交后的再轮 → 纯文本；
 *    c) 记忆复盘 utility 轮（system 含「记忆复盘员」）→ 回 {"intents":[]}；
 *    d) 其余父会话轮（含 spawn tool 结果回来的次轮 / mailbox 唤醒轮）→ 纯文本收尾。
 * 3. 控制面（仅 127.0.0.1）：
 *    - POST /__a4e__/config  { providerId, modelId }  → 设置 spawn 参数 + 复位脚本状态；
 *    - POST /__a4e__/release                            → 放行被挡住的 report_subagent_result；
 *    - GET  /__a4e__/state                              → 脚本状态与请求分类日志（诊断/报告证据）。
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
  const line = `${new Date().toISOString()} [lane-a4e-bootstrap] ${message}`;
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
 * 脚本化 stub Provider（OpenAI chat.completions SSE 兼容，仅本地回环）
 * ------------------------------------------------------------------------ */

/** pi-session-adapter.ts SUBAGENT_SYSTEM_PROMPT 的独特片段（只在子会话 system 出现） */
const SUBAGENT_SYSTEM_MARKER = "被父 Agent 委派的子代理";
/** background-review.ts SYSTEM_PROMPT 的独特片段（记忆复盘 utility 轮） */
const MEMORY_REVIEW_MARKER = "记忆复盘员";

interface StubScriptConfig {
  /** spawn_subagent.arguments.model.providerId（由用例按 GET /api/settings/providers 实况回填） */
  providerId: string;
  /** spawn_subagent.arguments.model.modelId */
  modelId: string;
}

interface RequestClassification {
  readonly n: number;
  readonly kind: "parent-first" | "parent-followup" | "child-first" | "child-followup" | "memory-review";
  readonly gated: boolean;
}

const scriptConfig: StubScriptConfig = { providerId: "oc-e2e-stub", modelId: "oc-e2e-model-a" };
let spawnSent = false;
let resultReleased = false;
let resultSent = false;
let requestCount = 0;
const requestLog: RequestClassification[] = [];

function resetScript(config: Partial<StubScriptConfig>): void {
  if (config.providerId !== undefined) scriptConfig.providerId = config.providerId;
  if (config.modelId !== undefined) scriptConfig.modelId = config.modelId;
  spawnSent = false;
  resultReleased = false;
  resultSent = false;
  requestCount = 0;
  requestLog.length = 0;
}

/** 等待放行（用例控制面触发）；45s 自动放行兜底（unref，不阻塞进程退出） */
function waitForRelease(): Promise<void> {
  if (resultReleased) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resultReleased = true;
      log("gate 45s 自动放行（兜底）");
      resolve();
    }, 45_000);
    timer.unref?.();
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
const waiters: Array<() => void> = [];

function releaseGate(): void {
  resultReleased = true;
  while (waiters.length > 0) {
    waiters.shift()?.();
  }
}

/* ---- SSE 帧构造 ---- */

function chunkFrame(delta: Record<string, unknown>, finishReason: string | null): string {
  const payload = {
    id: "chatcmpl-oc-e2e-a4e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: scriptConfig.modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function usageFrame(): string {
  const payload = {
    id: "chatcmpl-oc-e2e-a4e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: scriptConfig.modelId,
    choices: [],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const DONE_FRAME = "data: [DONE]\n\n";

function textDeltas(text: string, chunks: number): string {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, chunks)));
  let out = "";
  for (let index = 0; index < text.length; index += size) {
    out += chunkFrame({ content: text.slice(index, index + size) }, null);
  }
  return out;
}

/** 流式 tool_calls：首帧携带 id/name（空 arguments），arguments 分多片增量，最后 finish_reason=tool_calls */
function toolCallFrames(toolCallId: string, name: string, argsJson: string, argChunks: number): string {
  let out = chunkFrame(
    { role: "assistant", tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name, arguments: "" } }] },
    null,
  );
  const size = Math.max(1, Math.ceil(argsJson.length / Math.max(1, argChunks)));
  for (let index = 0; index < argsJson.length; index += size) {
    out += chunkFrame(
      { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(index, index + size) } }] },
      null,
    );
  }
  out += chunkFrame({}, "tool_calls");
  return out;
}

const SPAWN_TOOL_CALL_ID = "call_a4e_spawn";
const PROGRESS_TOOL_CALL_ID = "call_a4e_progress";
const RESULT_TOOL_CALL_ID = "call_a4e_result";

function spawnArgumentsJson(): string {
  return JSON.stringify({
    brief: {
      version: 1,
      title: "SUB-02 真链子代理任务",
      objective: "A4e 真链回归：读取任务简报，汇报一次进展，然后提交结构化结果。",
      successCriteria: ["Run 启动并进入 running", "提交结构化结果"],
      deliverables: ["结构化结果一份"],
      context: ["本任务由 A4e 真链回归触发"],
      constraints: ["不得修改平台代码"],
      nonGoals: ["不做 UI 自动化"],
      executionMode: "research",
      reporting: { progress: "milestones", evidenceRequired: true, artifactPreference: "references" },
    },
    context: {
      version: 1,
      userRequest: "A4e 真链回归：spawn 一个子代理并观察 Dock 与 SSE",
      parentSummary: "父会话由本地脚本化 stub Provider 驱动",
      messageRefs: [],
      resources: [],
      knownFacts: ["平台为 Windows"],
      unresolvedQuestions: [],
    },
    model: { providerId: scriptConfig.providerId, modelId: scriptConfig.modelId },
    limits: { maxModelIterations: 12, maxToolCalls: 16 },
  });
}

const PROGRESS_ARGS = JSON.stringify({ text: "已完成简报解读，准备提交结果", phase: "整理结果" });
const RESULT_ARGS = JSON.stringify({
  disposition: "satisfied",
  summary: "A4e 真链回归结果：已按简报完成并以结构化结果提交。",
  criteria: [{ criterion: "Run 启动并进入 running", status: "met", evidenceRefs: [] }],
  artifacts: [],
  unresolvedIssues: [],
  recommendedNextAction: "accept",
});

const PARENT_FIRST_HINT = "父 Agent（A4e stub）：收到请求，现委派一个子代理执行任务。";
const PARENT_FOLLOWUP_TEXT = "子代理已提交结果：A4e 真链回归任务收尾完成。";
const CHILD_TAIL_TEXT = "结果已提交，子代理任务结束。";
const MEMORY_REVIEW_TEXT = '{"intents":[]}';

/* ---- 请求解析 ---- */

interface ParsedChatRequest {
  readonly isSubagentSession: boolean;
  readonly hasToolResult: boolean;
  readonly isMemoryReview: boolean;
  readonly stream: boolean;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && typeof (part as Record<string, unknown>)["text"] === "string") {
        return (part as Record<string, unknown>)["text"] as string;
      }
      return "";
    }).join("");
  }
  return "";
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
  response.on("error", () => undefined);
}

async function handleChatCompletions(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readBody(request);
  let parsed: { messages?: unknown; stream?: unknown } = {};
  try {
    parsed = JSON.parse(raw) as { messages?: unknown; stream?: unknown };
  } catch {
    respondJson(response, 400, { error: { message: "stub 收到非 JSON 请求体" } });
    return;
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages as Array<{ role?: unknown; content?: unknown }> : [];
  const allText = messages.map((message) => messageText(message.content)).join("\n");
  const isSubagentSession = allText.includes(SUBAGENT_SYSTEM_MARKER);
  const hasToolResult = messages.some((message) => message.role === "tool");
  const isMemoryReview = !isSubagentSession && allText.includes(MEMORY_REVIEW_MARKER);

  let kind: RequestClassification["kind"];
  if (isSubagentSession) {
    kind = hasToolResult ? "child-followup" : "child-first";
  } else if (isMemoryReview) {
    kind = "memory-review";
  } else {
    kind = spawnSent && hasToolResult ? "parent-followup" : spawnSent ? "parent-followup" : "parent-first";
  }
  requestCount += 1;
  log(`stub 请求 #${requestCount} → ${kind}（stream=${String(parsed.stream ?? true)}）`);

  if (kind === "parent-first") {
    spawnSent = true;
    startSse(response);
    response.write(toolCallFrames(SPAWN_TOOL_CALL_ID, "spawn_subagent", spawnArgumentsJson(), 5));
    response.write(usageFrame());
    response.write(DONE_FRAME);
    response.end();
    requestLog.push({ n: requestCount, kind, gated: false });
    return;
  }

  if (kind === "child-first") {
    startSse(response);
    response.write(toolCallFrames(PROGRESS_TOOL_CALL_ID, "report_subagent_progress", PROGRESS_ARGS, 2));
    response.write(usageFrame());
    response.write(DONE_FRAME);
    response.end();
    requestLog.push({ n: requestCount, kind, gated: false });
    return;
  }

  if (kind === "child-followup" && !resultSent) {
    log(`stub 请求 #${requestCount} → 门挡住 report_subagent_result，等待放行`);
    requestLog.push({ n: requestCount, kind, gated: true });
    await waitForRelease();
    resultSent = true;
    log(`stub 请求 #${requestCount} → 放行，返回 report_subagent_result`);
    startSse(response);
    response.write(toolCallFrames(RESULT_TOOL_CALL_ID, "report_subagent_result", RESULT_ARGS, 4));
    response.write(usageFrame());
    response.write(DONE_FRAME);
    response.end();
    return;
  }

  // memory-review / parent-followup / 结果已提交后的子会话再轮：纯文本
  const text = kind === "memory-review" ? MEMORY_REVIEW_TEXT
    : kind === "child-followup" ? CHILD_TAIL_TEXT
    : PARENT_FOLLOWUP_TEXT;
  requestLog.push({ n: requestCount, kind, gated: false });
  if (parsed.stream === false) {
    respondJson(response, 200, {
      id: "chatcmpl-oc-e2e-a4e",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: scriptConfig.modelId,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    });
    return;
  }
  startSse(response);
  response.write(textDeltas(text, 3));
  response.write(chunkFrame({}, "stop"));
  response.write(usageFrame());
  response.write(DONE_FRAME);
  response.end();
}

const stubServer = http.createServer((request, response) => {
  const url = request.url ?? "";
  const method = request.method ?? "";

  /* 控制面（lane harness 调用） */
  if (url.startsWith("/__a4e__/")) {
    void (async () => {
      if (method === "POST" && url.startsWith("/__a4e__/config")) {
        const body = await readBody(request);
        try {
          const patch = JSON.parse(body) as Partial<StubScriptConfig>;
          resetScript(patch);
          log(`stub 脚本已配置/复位：providerId=${scriptConfig.providerId} modelId=${scriptConfig.modelId}`);
          respondJson(response, 200, { ok: true, providerId: scriptConfig.providerId, modelId: scriptConfig.modelId });
        } catch (error) {
          respondJson(response, 400, { ok: false, message: String(error) });
        }
        return;
      }
      if (method === "POST" && url.startsWith("/__a4e__/release")) {
        releaseGate();
        respondJson(response, 200, { ok: true, released: true });
        return;
      }
      if (method === "GET" && url.startsWith("/__a4e__/state")) {
        respondJson(response, 200, {
          providerId: scriptConfig.providerId,
          modelId: scriptConfig.modelId,
          spawnSent,
          resultReleased,
          resultSent,
          requestCount,
          requests: requestLog,
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
  void handleChatCompletions(request, response);
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
    version: "oc-e2e-lane-a4e",
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
        // close 兜底：有活跃连接（子代理 SSE 等）时 2s 后强退
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
