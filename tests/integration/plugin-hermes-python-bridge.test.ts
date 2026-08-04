import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CarrierRegistry } from "../../src/runtime/plugins/runtimes/carrier-registry.js";
import { resolvePythonInterpreter } from "../../src/runtime/plugins/runtimes/python-runtime.js";
import {
  HermesPythonBridge,
  HERMES_TOOLS_JSON,
  HERMES_WORKER_SUBDIR,
  materializeHermesWorker,
  type HermesBridgeDiagnostic,
  type HermesPythonBridgeOptions,
} from "../../src/runtime/plugins/compat/hermes-python-bridge.js";

// ═══════════════════════════════════════════════════════════════
// T7 Hermes L5 Python worker 兼容层（plans/phase-12.md §12.4）
// - 复用 python-runtime（解释器发现：声明校验 → 系统 python3，禁止下载）；
// - worker 具体化 + tools.list 注册诊断；
// - 成功/异常(traceback+stderr)/超时/取消/崩溃映射进入统一诊断。
// 需要系统 python3；不可用时全部 skip（不硬失败）。
// ═══════════════════════════════════════════════════════════════

const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures/plugins/hermes", import.meta.url));

let pythonAvailable = true;
try {
  resolvePythonInterpreter();
} catch {
  pythonAvailable = false;
}
const itPy = pythonAvailable ? it : it.skip;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function createVersionDir(fixtureName: string): string {
  const fixture = path.join(FIXTURES_ROOT, fixtureName);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hermes-bridge-"));
  temporaryDirectories.push(dir);
  fs.cpSync(fixture, dir, { recursive: true });
  return dir;
}

function makeBridge(
  versionDir: string,
  options: Partial<Omit<HermesPythonBridgeOptions, "versionDir" | "carriers">> & { readonly diagnostics?: HermesBridgeDiagnostic[] } = {},
): HermesPythonBridge {
  const carriers = new CarrierRegistry();
  const diagnostics: HermesBridgeDiagnostic[] = [];
  return new HermesPythonBridge({
    pluginId: options.pluginId ?? "hermes-toolset",
    version: options.version ?? "1.0.0",
    versionDir,
    carriers,
    ...(options.entry !== undefined ? { entry: options.entry } : {}),
    ...(options.interpreter !== undefined ? { interpreter: options.interpreter } : {}),
    ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
    onDiagnostic: (diag) => {
      diagnostics.push(diag);
      options.diagnostics?.push(diag);
    },
  });
}

describe("Hermes L5 worker 具体化", () => {
  it("materializeHermesWorker 写入 _ocf/worker.py 与 tools.json", () => {
    const versionDir = createVersionDir("toolset");
    materializeHermesWorker(versionDir, { name: "hermes-toolset", version: "1.0.0", entry: "__init__.py" });
    const workerPath = path.join(versionDir, HERMES_WORKER_SUBDIR, "worker.py");
    const toolsJsonPath = path.join(versionDir, HERMES_WORKER_SUBDIR, HERMES_TOOLS_JSON);
    expect(fs.existsSync(workerPath)).toBe(true);
    expect(fs.readFileSync(workerPath, "utf8")).toContain("HermesMockContext");
    const toolsJson = JSON.parse(fs.readFileSync(toolsJsonPath, "utf8")) as Record<string, unknown>;
    expect(toolsJson.entry).toBe("__init__.py");
    expect(toolsJson.name).toBe("hermes-toolset");
  });
});

describe("Hermes L5 worker 调用矩阵（真实 python3 子进程）", () => {
  itPy("start：工具清单与注册诊断（toolset 全部登记）", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir);
    const started = await bridge.start();
    expect(started.tools.map((tool) => tool.name).sort()).toEqual(
      ["hermes_boom", "hermes_crash", "hermes_slow", "hermes_sum", "hermes_wait"],
    );
    const sum = started.tools.find((tool) => tool.name === "hermes_sum");
    expect(sum?.schema).toMatchObject({ type: "object" });
    expect(started.diagnostics).toEqual([]);
    await bridge.stop("shutdown");
  });

  itPy("成功调用：hermes_sum 往返结果", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir);
    await bridge.start();
    const runtime = bridge.getRuntime();
    const carrier = new CarrierRegistry().issue({
      pluginId: "hermes-toolset",
      runtimeInstanceId: runtime?.runtimeInstanceId ?? "runtime-hermes-toolset-test",
      operationId: "exec-sum",
    });
    const result = await bridge.invokeTool({ toolId: "hermes_sum", args: { a: 2, b: 3 }, carrier, operationId: "exec-sum" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({ sum: 5 });
    }
    await bridge.stop("shutdown");
  });

  itPy("异常映射：hermes_boom → tool-error + traceback + stderr 进入诊断", async () => {
    const versionDir = createVersionDir("toolset");
    const diagnostics: HermesBridgeDiagnostic[] = [];
    const bridge = makeBridge(versionDir, { diagnostics });
    await bridge.start();
    const runtime = bridge.getRuntime();
    const carrier = new CarrierRegistry().issue({
      pluginId: "hermes-toolset",
      runtimeInstanceId: runtime?.runtimeInstanceId ?? "runtime-hermes-toolset-test",
      operationId: "exec-boom",
    });
    const result = await bridge.invokeTool({
      toolId: "hermes_boom",
      args: { why: "boom" },
      carrier,
      operationId: "exec-boom",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tool-error");
      expect(result.message).toContain("hermes boom failure");
      expect(result.data?.type).toBe("ValueError");
      expect(result.data?.traceback).toContain("hermes_boom");
      expect(result.data?.stderrTail).toContain("hermes-boom-stderr-marker");
    }
    // 统一诊断：onDiagnostic 收到失败记录（platform 边界 wrapper 负责 plugin.execution.*）
    expect(diagnostics.some((diag) => diag.eventName === "plugin.hermes.tool_failed" && diag.level === "error")).toBe(true);
    await bridge.stop("shutdown");
  });

  itPy("超时映射：hermes_slow(timeoutMs=150) → timeout", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir);
    await bridge.start();
    const runtime = bridge.getRuntime();
    const carrier = new CarrierRegistry().issue({
      pluginId: "hermes-toolset",
      runtimeInstanceId: runtime?.runtimeInstanceId ?? "runtime-hermes-toolset-test",
      operationId: "exec-slow",
    });
    const result = await bridge.invokeTool({ toolId: "hermes_slow", args: {}, carrier, operationId: "exec-slow", timeoutMs: 150 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
      expect(result.message).toContain("超时");
    }
    await bridge.stop("shutdown");
  });

  itPy("取消映射：AbortSignal → cancelled", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir);
    await bridge.start();
    const runtime = bridge.getRuntime();
    const carrier = new CarrierRegistry().issue({
      pluginId: "hermes-toolset",
      runtimeInstanceId: runtime?.runtimeInstanceId ?? "runtime-hermes-toolset-test",
      operationId: "exec-cancel",
    });
    const controller = new AbortController();
    const promise = bridge.invokeTool({
      toolId: "hermes_wait",
      args: {},
      carrier,
      operationId: "exec-cancel",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cancelled");
    }
    await bridge.stop("shutdown");
  });

  itPy("崩溃映射：hermes_crash(exit 7) → worker-crashed + exitCode", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir);
    await bridge.start();
    const runtime = bridge.getRuntime();
    const carrier = new CarrierRegistry().issue({
      pluginId: "hermes-toolset",
      runtimeInstanceId: runtime?.runtimeInstanceId ?? "runtime-hermes-toolset-test",
      operationId: "exec-crash",
    });
    const result = await bridge.invokeTool({ toolId: "hermes_crash", args: {}, carrier, operationId: "exec-crash" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("worker-crashed");
      expect(result.data?.exitCode).toBe(7);
    }
    expect(bridge.isHealthy()).toBe(false);
    await bridge.stop("shutdown");
  });

  itPy("未登记工具 → tool-not-found", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir);
    await bridge.start();
    const runtime = bridge.getRuntime();
    const carrier = new CarrierRegistry().issue({
      pluginId: "hermes-toolset",
      runtimeInstanceId: runtime?.runtimeInstanceId ?? "runtime-hermes-toolset-test",
      operationId: "exec-missing",
    });
    const result = await bridge.invokeTool({ toolId: "no_such_tool", args: {}, carrier, operationId: "exec-missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tool-not-found");
    }
    await bridge.stop("shutdown");
  });

  itPy("stop 优雅关闭：健康为 false 且不再可调用", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir);
    await bridge.start();
    await bridge.stop("plugin_disabled");
    expect(bridge.isHealthy()).toBe(false);
    const carrier = new CarrierRegistry().issue({
      pluginId: "hermes-toolset",
      runtimeInstanceId: "runtime-hermes-toolset-test",
      operationId: "exec-after-stop",
    });
    const result = await bridge.invokeTool({ toolId: "hermes_sum", args: {}, carrier, operationId: "exec-after-stop" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-started");
    }
  });

  itPy("插件声明不存在的解释器 → 启动拒绝（不下载）", async () => {
    const versionDir = createVersionDir("toolset");
    const bridge = makeBridge(versionDir, { interpreter: path.join(os.tmpdir(), "no-such-python.exe") });
    await expect(bridge.start()).rejects.toThrow(/解释器不存在/);
  });
});
