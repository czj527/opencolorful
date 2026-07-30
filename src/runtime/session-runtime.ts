import crypto from "node:crypto";
import path from "node:path";

import type { AgentSettingsV2 } from "../contracts/agent-settings.js";
import type { PlatformEventEnvelope } from "../contracts/events.js";
import {
  createPiAgentSession,
  createPiFauxAgentSession,
  type PiAgentEvent,
  type PiAgentSessionHandle,
  type PiFauxAgentOptions,
  type PiSessionHandle,
} from "../pi-sdk/index.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { ToolPolicy } from "./tool-policy.js";
import type { ModelService } from "./model-service.js";
import { EventReplayStore } from "./event-replay-store.js";
import { PlatformEventMapper } from "./event-mapper.js";
import { type AbortResult, ExecutionRegistry } from "./execution-registry.js";
import { mapProviderError } from "./provider-errors.js";

export interface SessionRuntimeOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDir?: string;
  readonly authPath: string;
  readonly providerId?: string;
  readonly modelId?: string;
  // faux 模式（测试用）
  readonly faux?: {
    readonly response: string;
    readonly tokensPerSecond?: number;
  };
  // 真实模型模式
  readonly modelService?: ModelService;
  readonly resolveProviderId?: string;
  readonly resolveModelId?: string;
  // 共享
  readonly publish: (event: PlatformEventEnvelope) => void;
  readonly replayStore?: EventReplayStore;
  readonly sessionHandle?: PiSessionHandle;
  readonly tools?: readonly string[];
  readonly noTools?: "all";
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly systemPrompt?: string;
  // 沙箱（Phase 9）
  readonly agentSettings?: AgentSettingsV2;
  readonly agentHomeDir?: string;
  readonly platformHome?: string;
  /** Session 的实际工作目录（优先于 agent.defaultCwd） */
  readonly workspaceCwd?: string | null;
}

export interface PromptRun {
  readonly streamId: string;
  readonly completed: Promise<void>;
}

export class SessionRuntime {
  private readonly executions = new ExecutionRegistry();
  private mapper: PlatformEventMapper | undefined;
  private controlMapper: PlatformEventMapper | undefined;
  private readonly unsubscribe: () => void;
  private readonly toolPolicy: ToolPolicy;

  private constructor(
    readonly sessionId: string,
    private readonly agent: PiAgentSessionHandle,
    private readonly publish: (event: PlatformEventEnvelope) => void,
    private readonly replayStore: EventReplayStore | undefined,
    toolPolicy: ToolPolicy,
  ) {
    this.toolPolicy = toolPolicy;
    this.unsubscribe = agent.subscribe((event) => {
      const mapper = this.mapper ?? this.resolveControlMapper(event);
      if (!mapper) return;
      for (const mapped of mapper.map(event)) this.emit(mapped);
    });
  }

  // 手动 compact 在空闲时触发，没有活动 prompt stream；
  // compaction 事件改走独立的 control stream（新 streamId、sequence 从 1 开始）
  private resolveControlMapper(event: PiAgentEvent): PlatformEventMapper | undefined {
    if (event.type === "compaction_start") {
      this.controlMapper = new PlatformEventMapper(
        this.sessionId,
        `ctrl-${crypto.randomUUID()}`,
      );
      return this.controlMapper;
    }
    if (event.type === "compaction_end") {
      const mapper = this.controlMapper;
      this.controlMapper = undefined;
      return mapper;
    }
    return undefined;
  }

  static async create(options: SessionRuntimeOptions): Promise<SessionRuntime> {
    // ── 沙箱初始化 ──────────────────────────────────────────────
    let sandboxService: SandboxService | null = null;
    const toolPolicy = new ToolPolicy();

    if (options.agentSettings && options.agentHomeDir && options.platformHome) {
      sandboxService = SandboxService.create({
        agentSettings: options.agentSettings,
        agentId: path.basename(options.agentHomeDir),
        agentHomeDir: options.agentHomeDir,
        platformHome: options.platformHome,
        auditLogPath: path.join(
          options.platformHome,
          "logs",
          "security-audit.jsonl",
        ),
        sessionId: options.sessionId,
        ...(options.workspaceCwd !== undefined ? { workspaceCwd: options.workspaceCwd } : {}),
      });
      toolPolicy.setSandboxService(sandboxService);
    }

    // ── Agent session 创建 ───────────────────────────────────────
    let agent: PiAgentSessionHandle;

    if (options.faux !== undefined) {
      if (!options.sessionDir || !options.providerId || !options.modelId) {
        throw new Error("Faux 模式需要 sessionDir、providerId 和 modelId");
      }
      agent = await createPiFauxAgentSession({
        sessionId: options.sessionId,
        cwd: options.cwd,
        sessionDir: options.sessionDir,
        authPath: options.authPath,
        providerId: options.providerId,
        modelId: options.modelId,
        response: options.faux.response,
        ...(options.sessionHandle ? { sessionHandle: options.sessionHandle } : {}),
        ...(options.faux.tokensPerSecond
          ? { tokensPerSecond: options.faux.tokensPerSecond }
          : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(sandboxService ? { toolPolicy } : {}),
      });
    } else if (options.modelService && options.resolveProviderId && options.resolveModelId && options.sessionHandle) {
      // 真实模型路径
      const resolved = options.modelService.resolveModel(
        options.resolveProviderId,
        options.resolveModelId,
      );
      agent = await createPiAgentSession({
        sessionId: options.sessionId,
        cwd: options.cwd,
        authPath: options.authPath,
        modelRuntime: options.modelService.getRuntime(),
        providerId: options.resolveProviderId,
        modelId: options.resolveModelId,
        sessionHandle: options.sessionHandle,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.noTools ? { noTools: options.noTools } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(sandboxService ? { toolPolicy } : {}),
      });
    } else {
      throw new Error("SessionRuntime 缺少 faux 参数或真实模型配置");
    }

    return new SessionRuntime(
      options.sessionId,
      agent,
      options.publish,
      options.replayStore,
      toolPolicy,
    );
  }

  prompt(text: string): PromptRun {
    if (!text.trim()) throw new Error("Prompt 不能为空");
    const controller = new AbortController();
    const started = this.executions.start(this.sessionId, controller);
    if (started.status !== "accepted") throw new Error("Session 已有运行中的 Prompt");

    const mapper = new PlatformEventMapper(this.sessionId, started.streamId);
    this.mapper = mapper;
    this.emit(mapper.sessionStatus("running"));
    controller.signal.addEventListener(
      "abort",
      () => {
        void this.agent.abort();
      },
      { once: true },
    );

    void this.runPrompt(text, started.streamId, mapper);
    return { streamId: started.streamId, completed: started.completed };
  }

  abort(streamId: string): AbortResult {
    return this.executions.abort(this.sessionId, streamId);
  }

  activeStream(): string | undefined {
    return this.executions.activeStream(this.sessionId);
  }

  /** 获取沙箱 ToolPolicy，用于文件路径检查（未配置沙箱时仍可用，默认放行） */
  getToolPolicy(): ToolPolicy {
    return this.toolPolicy;
  }

  async compact(): Promise<void> {
    await this.agent.compact();
  }

  dispose(): void {
    const active = this.executions.activeStream(this.sessionId);
    if (active) this.executions.abort(this.sessionId, active);
    this.unsubscribe();
    this.agent.dispose();
  }

  private emit(event: PlatformEventEnvelope): void {
    if (this.replayStore) {
      this.replayStore.publish(event);
    }
    this.publish(event);
  }

  private async runPrompt(
    text: string,
    streamId: string,
    mapper: PlatformEventMapper,
  ): Promise<void> {
    try {
      await this.agent.prompt(text);
    } catch (error) {
      const apiError = mapProviderError(error);
      this.emit(mapper.error(apiError.message, apiError.code, apiError.retryable));
    } finally {
      this.emit(mapper.sessionStatus("idle"));
      this.executions.finish(this.sessionId, streamId);
      if (this.mapper === mapper) this.mapper = undefined;
    }
  }
}
