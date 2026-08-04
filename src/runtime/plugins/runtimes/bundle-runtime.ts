import type { PluginRuntime, RuntimeInvokeInput, RuntimeInvokeResult, RuntimeStatus } from "./runtime-host.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Bundle Runtime（plans/phase-12.md §9.1）
//
// - 无子进程：只加载声明式资源（Skills/配置/工具描述/命令描述）；
// - 声明式工具由 Host 直接执行（in-process handler），仍走平台统一的
//   权限 + Trace + Activity 包装（由 RuntimeHost.invoke 承担）；
// - handler 由 T5（Contribution Registry）注册；本模块只提供受控执行面，
//   不暴露 Store/spool/Audit 写入口；
// - 状态机简单：starting → running → stopped；无崩溃（无进程）。
// ═══════════════════════════════════════════════════════════════

export interface BundleRuntimeOptions {
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
}

/** 声明式 handler：参数 + 平台注入的调用上下文（含一次性 carrier）。 */
export interface BundleHandlerContext {
  readonly pluginId: string;
  readonly runtimeInstanceId: string;
  readonly operationId: string;
  readonly carrier: import("../../../contracts/plugin-protocol.js").PluginIpcCarrier;
}

export class BundleRuntime implements PluginRuntime {
  readonly kind = "bundle" as const;
  readonly pluginId: string;
  readonly version: string;
  readonly runtimeInstanceId: string;
  state: RuntimeStatus = "starting";
  private readonly handlers = new Map<string, (params: unknown, ctx: BundleHandlerContext) => unknown>();

  constructor(options: BundleRuntimeOptions) {
    this.pluginId = options.pluginId;
    this.version = options.version;
    this.runtimeInstanceId = options.runtimeInstanceId;
  }

  /** 注册声明式工具 handler（T5 Contribution Registry 接线时调用）。 */
  registerHandler(method: string, handler: (params: unknown, ctx: BundleHandlerContext) => unknown): void {
    if (this.handlers.has(method)) {
      throw new Error(`Bundle handler 已注册：${method}`);
    }
    this.handlers.set(method, handler);
  }

  hasHandler(method: string): boolean {
    return this.handlers.has(method);
  }

  async start(): Promise<void> {
    this.state = "running";
  }

  async stop(_reason: string): Promise<void> {
    this.state = "stopped";
  }

  /** 直接执行声明式 handler（仍然在 RuntimeHost 的权限 + Trace 包装之内）。 */
  async invoke(input: RuntimeInvokeInput): Promise<RuntimeInvokeResult> {
    if (this.state !== "running") {
      return { ok: false, code: "not-running", message: "Bundle 运行实例未处于 running 状态" };
    }
    const handler = this.handlers.get(input.method);
    if (handler === undefined) {
      return { ok: false, code: "method-not-found", message: `Bundle 未注册方法：${input.method}` };
    }
    try {
      const value = await handler(input.params, {
        pluginId: this.pluginId,
        runtimeInstanceId: this.runtimeInstanceId,
        operationId: input.operationId,
        carrier: input.carrier,
      });
      return { ok: true, result: value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "handler-error", message: message.slice(0, 400) };
    }
  }

  cancel(): void {
    // 无子进程：无远端工作可取消
  }

  isHealthy(): boolean {
    return this.state === "running";
  }
}
