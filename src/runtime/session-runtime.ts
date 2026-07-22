import type { PlatformEventEnvelope } from "../contracts/events.js";
import {
  createPiAgentSession,
  createPiFauxAgentSession,
  type PiAgentSessionHandle,
  type PiFauxAgentOptions,
  type PiSessionHandle,
} from "../pi-sdk/index.js";
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
}

export interface PromptRun {
  readonly streamId: string;
  readonly completed: Promise<void>;
}

export class SessionRuntime {
  private readonly executions = new ExecutionRegistry();
  private mapper: PlatformEventMapper | undefined;
  private readonly unsubscribe: () => void;

  private constructor(
    readonly sessionId: string,
    private readonly agent: PiAgentSessionHandle,
    private readonly publish: (event: PlatformEventEnvelope) => void,
    private readonly replayStore: EventReplayStore | undefined,
  ) {
    this.unsubscribe = agent.subscribe((event) => {
      if (!this.mapper) return;
      for (const mapped of this.mapper.map(event)) this.emit(mapped);
    });
  }

  static async create(options: SessionRuntimeOptions): Promise<SessionRuntime> {
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
      });
    } else {
      throw new Error("SessionRuntime 缺少 faux 参数或真实模型配置");
    }

    return new SessionRuntime(options.sessionId, agent, options.publish, options.replayStore);
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
