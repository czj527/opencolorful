import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PluginIpcCarrier } from "../../../contracts/plugin-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import { safeJoin } from "../paths.js";
import type { CarrierRegistry } from "../runtimes/carrier-registry.js";
import { PythonRuntime } from "../runtimes/python-runtime.js";
import type { RuntimeInvokeResult } from "../runtimes/runtime-host.js";
import {
  detectHermesToolFailure,
  HERMES_WORKER_ENTRY,
  HERMES_WORKER_SUBDIR,
  mapHermesToolResult,
  type HermesToolFailure,
} from "../compat/hermes-compat.js";

// ═══════════════════════════════════════════════════════════════
// Hermes L5 Python worker 兼容层（plans/phase-12.md §12.4）
//
// - 把选定 Hermes Python Tool 桥接为 OpenColorful Tool contribution 调用，
//   复用 python-runtime（解释器发现：插件声明且校验路径/venv → 系统 python3 →
//   python → 拒绝；禁止下载解释器）；
// - 具体化 _ocf/worker.py + _ocf/tools.json 到版本目录：worker 加载 Hermes
//   插件入口并调用 register(ctx)，Mock PluginContext 捕获 register_tool
//   声明的工具；Agent Loop/Gateway/全局单例/内部数据库依赖 → 精确中文诊断；
// - Python 异常/traceback/stderr/超时/取消统一映射进 HermesToolFailure，
//   并进入 DiagnosticLogger / instrument（平台边界 wrapper 负责
//   plugin.execution.* 生命周期）；
// - 不污染 Server 根依赖：worker 以 cwd=版本目录 + sys.path 注入插件目录
//   运行，平台不 pip install、不自动下载解释器。
// ═══════════════════════════════════════════════════════════════

export const HERMES_TOOLS_JSON = "tools.json" as const;
export { HERMES_WORKER_SUBDIR } from "../compat/hermes-compat.js";
/** stderr 环形缓冲上限（诊断用，不进入协议通道）。 */
export const HERMES_MAX_STDERR_BYTES = 16 * 1024;
/** stderr 诊断尾缀最大字符数。 */
export const HERMES_MAX_STDERR_TAIL_CHARS = 4 * 1024;

// ── worker 具体化 ───────────────────────────────────────────────

/**
 * 把 L5 worker（_ocf/worker.py + _ocf/tools.json）写入版本目录。
 * 幂等：内容确定（worker 模板固定），重复调用覆盖为相同内容。
 * 平台包装在 RuntimeHost.start 前调用，保证运行时入口就绪。
 */
export function materializeHermesWorker(
  versionDir: string,
  options: { readonly name: string; readonly version?: string; readonly entry?: string },
): void {
  const root = path.resolve(versionDir);
  const ocfDir = safeJoin(root, HERMES_WORKER_SUBDIR);
  fs.mkdirSync(ocfDir, { recursive: true });
  fs.writeFileSync(safeJoin(ocfDir, "worker.py"), hermesWorkerTemplate(), "utf8");
  const toolsJson: Record<string, unknown> = {
    name: options.name,
    ...(options.version !== undefined ? { version: options.version } : {}),
    entry: options.entry ?? "__init__.py",
  };
  fs.writeFileSync(safeJoin(ocfDir, HERMES_TOOLS_JSON), JSON.stringify(toolsJson, null, 2), "utf8");
}

/** L5 worker Python 源码模板（stdlib only；JSON-RPC/stdio 行帧）。 */
export function hermesWorkerTemplate(): string {
  return String.raw`# -*- coding: utf-8 -*-
"""OpenColorful L5 Python worker shim (Hermes plugin compat layer).

启动方式：<interpreter> _ocf/worker.py（cwd = 插件版本目录）。
协议：版本化 JSON-RPC/stdio（行分隔帧，见 src/runtime/plugins/runtimes/json-rpc.ts）。

worker 职责：
- 加载 Hermes 插件入口（默认 __init__.py），调用 register(ctx)；
  HermesMockContext 捕获 register_tool 声明的工具；
- 依赖 Hermes Agent Loop / Gateway / 全局单例 / 内部数据库的宿主能力
  抛出 HermesHostDependencyError，进入统一诊断（不伪造兼容）；
- 工具级异常以结果帧内嵌 __ocf_hermes_error__ 标记返回，
  由 Host 侧 mapHermesToolResult 映射为统一诊断（避免污染 JSON-RPC error 语义）。
"""
import importlib.util
import json
import os
import pathlib
import re
import sys
import threading
import traceback

_WORKER_DIR = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_DIR = os.path.dirname(_WORKER_DIR)
_REGISTRY = {}
try:
    with open(os.path.join(_WORKER_DIR, "tools.json"), "r", encoding="utf-8") as _fh:
        _REGISTRY = json.load(_fh)
except Exception:
    _REGISTRY = {}

_PLUGIN_ENTRY = str(_REGISTRY.get("entry") or "__init__.py")
_PLUGIN_NAME = str(_REGISTRY.get("name") or os.path.basename(os.path.abspath(_PLUGIN_DIR)))

# 插件目录进入 sys.path：插件本地（vendored）依赖可导入，不污染 Server 依赖
sys.path.insert(0, os.path.abspath(_PLUGIN_DIR))


class HermesHostDependencyError(Exception):
    """Hermes 宿主专属能力，OpenColorful 不支持。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class HermesMockContext(object):
    """模拟 Hermes PluginContext：register_tool 捕获；宿主能力明确拒绝。"""

    def __init__(self):
        self.tools = {}
        self.diagnostics = []
        self.manifest = {"name": _PLUGIN_NAME, "version": str(_REGISTRY.get("version") or "")}

    def register_tool(self, name=None, toolset=None, schema=None, handler=None,
                      description="", check_fn=None, requires_env=None,
                      is_async=False, emoji="", override=False, **kwargs):
        if not name or not callable(handler):
            self.diagnostics.append({"code": "invalid-tool",
                                     "message": "register_tool 缺少 name 或可调用 handler"})
            return
        if override:
            self.diagnostics.append({"code": "tool-override",
                                     "message": "register_tool(override=True) 试图覆盖平台内置工具，OpenColorful 不支持，已忽略"})
            return
        self.tools[name] = {"handler": handler, "schema": schema, "description": description or ""}

    def register_hook(self, *args, **kwargs):
        raise HermesHostDependencyError("agent-loop-hook",
                                        "Hermes 生命周期 Hook 依赖 Hermes Agent Loop 调用时机，OpenColorful 不支持")

    def register_command(self, *args, **kwargs):
        raise HermesHostDependencyError("cli-singleton",
                                        "Hermes 命令注册依赖 Hermes CLI 进程内单例，OpenColorful 不支持")

    def register_platform(self, *args, **kwargs):
        raise HermesHostDependencyError("gateway-platform",
                                        "Hermes Platform/Gateway 适配依赖宿主消息网关，OpenColorful 不支持")

    def inject_message(self, *args, **kwargs):
        raise HermesHostDependencyError("agent-loop-inject",
                                        "Hermes inject_message 依赖 Agent Loop 活跃会话队列，OpenColorful 不支持")

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        raise HermesHostDependencyError("host-dependency",
                                        "Hermes PluginContext." + name + " 依赖 Hermes 宿主能力，OpenColorful 不支持")


_CTX = HermesMockContext()


def _load_plugin():
    entry_path = os.path.join(_PLUGIN_DIR, _PLUGIN_ENTRY)
    if not os.path.isfile(entry_path):
        _CTX.diagnostics.append({"code": "no-entry", "message": "找不到 Hermes 插件入口 " + _PLUGIN_ENTRY})
        return None
    module_name = "ocf_hermes_plugin_" + re.sub(r"[^A-Za-z0-9_]", "_", _PLUGIN_NAME)
    spec = importlib.util.spec_from_file_location(module_name, entry_path)
    if spec is None or spec.loader is None:
        _CTX.diagnostics.append({"code": "import-failed", "message": "无法加载插件入口 " + _PLUGIN_ENTRY})
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except HermesHostDependencyError as exc:
        _CTX.diagnostics.append({"code": exc.code, "message": str(exc), "traceback": traceback.format_exc()})
        return None
    except Exception as exc:
        _CTX.diagnostics.append({"code": "import-failed", "message": "导入插件入口失败：" + repr(exc),
                                 "traceback": traceback.format_exc()})
        return None
    return module


def _register_plugin(module):
    register_fn = getattr(module, "register", None)
    if not callable(register_fn):
        _CTX.diagnostics.append({"code": "no-register", "message": "Hermes 插件缺少 register(ctx) 函数"})
        return
    try:
        register_fn(_CTX)
    except HermesHostDependencyError as exc:
        _CTX.diagnostics.append({"code": exc.code, "message": str(exc), "traceback": traceback.format_exc()})
    except Exception as exc:
        _CTX.diagnostics.append({"code": "register-failed", "message": "register(ctx) 抛异常：" + repr(exc),
                                 "traceback": traceback.format_exc()})


def _json_default(obj):
    import dataclasses
    import enum
    if isinstance(obj, pathlib.Path):
        return str(obj)
    if isinstance(obj, enum.Enum):
        return obj.value
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        try:
            return dataclasses.asdict(obj)
        except Exception:
            pass
    if isinstance(obj, (set, frozenset)):
        return sorted(obj, key=repr)
    if hasattr(obj, "__dict__"):
        return dict((key, value) for key, value in vars(obj).items() if not key.startswith("_"))
    raise TypeError("Object of type " + type(obj).__name__ + " is not JSON serializable")


def _send(message):
    sys.stdout.write(json.dumps(message, default=_json_default) + "\n")
    sys.stdout.flush()


_CANCEL_EVENTS = {}
_CANCEL_LOCK = threading.Lock()


def _mark_cancelled(request_id):
    with _CANCEL_LOCK:
        event = _CANCEL_EVENTS.get(request_id)
        if event is None:
            event = threading.Event()
            _CANCEL_EVENTS[request_id] = event
        event.set()


def _handle_request(msg):
    rid = msg.get("id")
    method = msg.get("method")
    if method == "runtime.initialize":
        _send({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": 1, "ok": True}})
        return
    if method == "tools.list":
        tools = [{"name": name, "description": info.get("description") or "", "schema": info.get("schema")}
                 for name, info in _CTX.tools.items()]
        _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": tools, "diagnostics": _CTX.diagnostics}})
        return
    if method == "runtime.get_diagnostics":
        _send({"jsonrpc": "2.0", "id": rid, "result": {"diagnostics": _CTX.diagnostics}})
        return
    tool = _CTX.tools.get(method)
    if tool is None:
        _send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "未登记的工具：" + str(method)}})
        return
    params = msg.get("params")
    if not isinstance(params, dict):
        params = {}
    try:
        result = tool["handler"](params)
    except HermesHostDependencyError as exc:
        _send({"jsonrpc": "2.0", "id": rid,
               "result": {"__ocf_hermes_error__": True, "type": exc.code, "message": str(exc),
                          "traceback": traceback.format_exc()}})
        return
    except Exception as exc:
        _send({"jsonrpc": "2.0", "id": rid,
               "result": {"__ocf_hermes_error__": True, "type": type(exc).__name__, "message": str(exc),
                          "traceback": traceback.format_exc()}})
        return
    try:
        json.dumps(result, default=_json_default)
    except Exception as exc:
        _send({"jsonrpc": "2.0", "id": rid,
               "result": {"__ocf_hermes_error__": True, "type": "ResultNotSerializable",
                          "message": "工具结果不可 JSON 序列化：" + str(exc), "traceback": ""}})
        return
    _send({"jsonrpc": "2.0", "id": rid, "result": result})


def _handle_notification(msg):
    method = msg.get("method")
    if method == "runtime.shutdown":
        sys.exit(0)
    elif method == "cancel":
        params = msg.get("params")
        if isinstance(params, dict):
            target = params.get("id")
            if target is not None:
                _mark_cancelled(target)
    elif method == "cancel-operation":
        pass


def _main():
    _module = _load_plugin()
    if _module is not None:
        _register_plugin(_module)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if not isinstance(msg, dict):
            continue
        if "id" in msg:
            try:
                _handle_request(msg)
            except Exception as exc:
                _send({"jsonrpc": "2.0", "id": msg.get("id"),
                       "error": {"code": -32603, "message": "worker 内部错误：" + str(exc)}})
        else:
            try:
                _handle_notification(msg)
            except Exception:
                pass


_main()
`;
}

// ── 桥接层 ─────────────────────────────────────────────────────

export interface HermesPythonBridgeOptions {
  readonly pluginId: string;
  readonly version: string;
  /** 安装版本目录（绝对路径；必须已存在） */
  readonly versionDir: string;
  /** Hermes 插件 Python 入口（相对版本目录；缺省 __init__.py） */
  readonly entry?: string;
  /** 插件声明且校验过的解释器（绝对路径/venv 内命令）；缺省系统 python3 */
  readonly interpreter?: string;
  readonly carriers: CarrierRegistry;
  readonly runtimeInstanceId?: string;
  readonly handshakeTimeoutMs?: number;
  /** 诊断回调（测试/平台包装可捕获统一诊断，不代替 Host Recorder 权威记录） */
  readonly onDiagnostic?: (diagnostic: HermesBridgeDiagnostic) => void;
}

export interface HermesBridgeDiagnostic {
  readonly eventName: string;
  readonly level: "warn" | "error";
  readonly message: string;
  readonly attributes?: Record<string, unknown>;
}

export interface HermesWorkerTool {
  readonly name: string;
  readonly description?: string;
  readonly schema?: unknown;
}

export interface HermesWorkerDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly traceback?: string;
}

export interface HermesBridgeStartResult {
  readonly tools: readonly HermesWorkerTool[];
  readonly diagnostics: readonly HermesWorkerDiagnostic[];
}

export interface HermesToolInvokeInput {
  readonly toolId: string;
  readonly args: unknown;
  /** 平台签发的一次性 carrier（绑定 pluginId+runtimeInstanceId+operationId） */
  readonly carrier: PluginIpcCarrier;
  readonly operationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HermesInvokeFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly data?: HermesToolFailure["data"];
}

export type HermesToolInvokeResult = { readonly ok: true; readonly result: unknown } | HermesInvokeFailure;

export class HermesPythonBridge {
  private runtime: PythonRuntime | undefined;
  private stderrBuffer = "";
  private exitInfo: { code: number | null; signal: string | null } | undefined;

  constructor(private readonly options: HermesPythonBridgeOptions) {}

  getRuntime(): PythonRuntime | undefined {
    return this.runtime;
  }

  isHealthy(): boolean {
    const runtime = this.runtime;
    return runtime !== undefined && runtime.isHealthy();
  }

  /** 具体化 worker → 启动 python-runtime → 握手 → 拉取工具清单与注册诊断。 */
  async start(): Promise<HermesBridgeStartResult> {
    materializeHermesWorker(this.options.versionDir, {
      name: this.options.pluginId,
      version: this.options.version,
      ...(this.options.entry !== undefined ? { entry: this.options.entry } : {}),
    });
    const runtimeInstanceId = this.options.runtimeInstanceId ?? `runtime-${this.options.pluginId}-${crypto.randomUUID()}`;
    const runtime = new PythonRuntime({
      pluginId: this.options.pluginId,
      version: this.options.version,
      runtimeInstanceId,
      versionDir: this.options.versionDir,
      entry: HERMES_WORKER_ENTRY,
      ...(this.options.interpreter !== undefined ? { interpreter: this.options.interpreter } : {}),
      carriers: this.options.carriers,
      onExit: (info) => {
        this.exitInfo = info;
      },
      onOutput: (chunk) => this.captureOutput(chunk),
      ...(this.options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: this.options.handshakeTimeoutMs } : {}),
    });
    this.runtime = runtime;
    await runtime.start();

    const listOperationId = `bridge-list-${crypto.randomUUID()}`;
    const carrier = this.options.carriers.issue({
      pluginId: this.options.pluginId,
      runtimeInstanceId,
      operationId: listOperationId,
    });
    const listing = await runtime.invoke({ operationId: listOperationId, method: "tools.list", carrier });
    if (!listing.ok) {
      throw new Error(`Hermes worker 工具清单获取失败：${listing.message}`);
    }
    const parsed = parseWorkerListing(listing.result);
    return parsed;
  }

  /** 桥接一次 Hermes 工具调用：复用 python-runtime，统一异常/超时/取消映射。 */
  async invokeTool(input: HermesToolInvokeInput): Promise<HermesToolInvokeResult> {
    const runtime = this.runtime;
    if (runtime === undefined) {
      return { ok: false, code: "not-started", message: "Hermes Python bridge 尚未启动" };
    }
    const result = await runtime.invoke({
      operationId: input.operationId,
      method: input.toolId,
      params: input.args,
      carrier: input.carrier,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!result.ok) {
      const mapped = this.mapTransportFailure(result);
      this.emitFailureDiagnostic(mapped);
      return mapped;
    }
    const mapped = mapHermesToolResult(result.result);
    if (!mapped.ok) {
      const failure = this.withStderrTail(mapped.failure);
      this.emitFailureDiagnostic(failure);
      return failure;
    }
    return { ok: true, result: mapped.result };
  }

  async stop(reason = "shutdown"): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime !== undefined) {
      await runtime.stop(reason);
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private captureOutput(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.stderrBuffer.length >= HERMES_MAX_STDERR_BYTES) {
      this.stderrBuffer = this.stderrBuffer.slice(-HERMES_MAX_STDERR_BYTES) + text;
    } else {
      this.stderrBuffer += text;
    }
    if (this.stderrBuffer.length > HERMES_MAX_STDERR_BYTES * 2) {
      this.stderrBuffer = this.stderrBuffer.slice(-HERMES_MAX_STDERR_BYTES);
    }
  }

  private stderrTail(): string {
    return this.stderrBuffer.slice(-HERMES_MAX_STDERR_TAIL_CHARS);
  }

  private mapTransportFailure(result: RuntimeInvokeResult & { ok: false }): HermesInvokeFailure {
    const code = result.code;
    const stderr = this.stderrTail();
    if (code === "timeout") {
      return { ok: false, code: "timeout", message: `Hermes 工具调用超时：${result.message}`, ...(stderr !== "" ? { data: { stderrTail: stderr } } : {}) };
    }
    if (code === "cancelled") {
      return { ok: false, code: "cancelled", message: "Hermes 工具调用已取消（用户中止或宿主生命周期取消）" };
    }
    if (code === "protocol-error" && result.message.includes("未登记的工具")) {
      return { ok: false, code: "tool-not-found", message: result.message.slice(0, 300) };
    }
    if (code === "connection-closed" || code === "protocol-error") {
      return {
        ok: false,
        code: "worker-crashed",
        message: `Hermes Python worker 异常终止：${result.message}`,
        data: { stderrTail: stderr, exitCode: this.exitInfo?.code ?? null },
      };
    }
    return { ok: false, code: "worker-error", message: result.message.slice(0, 400) };
  }

  private withStderrTail(failure: HermesToolFailure): HermesInvokeFailure {
    const stderr = this.stderrTail();
    const base: HermesInvokeFailure = { ok: false, code: failure.code, message: failure.message };
    if (stderr !== "" || failure.data !== undefined) {
      const data = { ...(failure.data ?? {}), ...(stderr !== "" ? { stderrTail: stderr } : {}) };
      return { ...base, data };
    }
    return base;
  }

  private emitFailureDiagnostic(failure: HermesInvokeFailure): void {
    const level = failure.code === "cancelled" ? "warn" : "error";
    const message = `Hermes 工具调用失败（${failure.code}）：${failure.message.slice(0, 300)}`;
    const attributes = { pluginId: this.options.pluginId, version: this.options.version };
    this.options.onDiagnostic?.({ eventName: "plugin.hermes.tool_failed", level, message, attributes });
    if (level === "error") {
      instrument.error("plugin.hermes.tool_failed", message, attributes);
    } else {
      instrument.warn("plugin.hermes.tool_failed", message, attributes);
    }
  }
}

// ── 解析 worker 清单 ───────────────────────────────────────────

function parseWorkerListing(raw: unknown): HermesBridgeStartResult {
  const tools: HermesWorkerTool[] = [];
  const diagnostics: HermesWorkerDiagnostic[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { tools, diagnostics };
  }
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.tools)) {
    for (const item of record.tools) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const tool = item as Record<string, unknown>;
      if (typeof tool.name !== "string" || tool.name === "") {
        continue;
      }
      const entry: HermesWorkerTool = {
        name: tool.name,
        ...(typeof tool.description === "string" && tool.description !== "" ? { description: tool.description } : {}),
        ...(tool.schema !== undefined ? { schema: tool.schema } : {}),
      };
      tools.push(entry);
    }
  }
  if (Array.isArray(record.diagnostics)) {
    for (const item of record.diagnostics) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const diag = item as Record<string, unknown>;
      if (typeof diag.code !== "string" || typeof diag.message !== "string") {
        continue;
      }
      const entry: HermesWorkerDiagnostic = {
        code: diag.code,
        message: diag.message,
        ...(typeof diag.traceback === "string" && diag.traceback !== "" ? { traceback: diag.traceback } : {}),
      };
      diagnostics.push(entry);
    }
  }
  return { tools, diagnostics };
}

/** 检查工具结果帧是否携带 Hermes 工具级错误（供测试/平台包装断言）。 */
export { detectHermesToolFailure };
