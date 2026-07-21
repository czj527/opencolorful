import type { PlatformEventEnvelope } from "../contracts/events.js";
import {
  createPiFauxAgentSession,
  type PiAgentSessionHandle,
  type PiFauxAgentOptions,
  type PiSessionHandle,
} from "../pi-sdk/index.js";
import { EventReplayStore } from "./event-replay-store.js";
import { PlatformEventMapper } from "./event-mapper.js";
import { type AbortResult, ExecutionRegistry } from "./execution-registry.js";

export interface SessionRuntimeOptions
  extends Omit<PiFauxAgentOptions, "response" | "tokensPerSecond"> {
  readonly faux: {
    readonly response: string;
    readonly tokensPerSecond?: number;
  };
  readonly publish: (event: PlatformEventEnvelope) => void;
  readonly replayStore?: EventReplayStore;
  readonly sessionHandle?: PiSessionHandle;
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
    const agent = await createPiFauxAgentSession({
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
    });
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
      this.emit(mapper.error(error instanceof Error ? error.message : "Prompt 执行失败"));
    } finally {
      this.emit(mapper.sessionStatus("idle"));
      this.executions.finish(this.sessionId, streamId);
      if (this.mapper === mapper) this.mapper = undefined;
    }
  }
}
