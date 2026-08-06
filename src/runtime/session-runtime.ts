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
  type PiResourceSkills,
  type PiSessionHandle,
  type PluginSessionTool,
  type PluginToolTurnContext,
  type SkillFileReadOutcome,
} from "../pi-sdk/index.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { ToolPolicy } from "./tool-policy.js";
import type { ModelService } from "./model-service.js";
import { EventReplayStore } from "./event-replay-store.js";
import { PlatformEventMapper } from "./event-mapper.js";
import { type AbortResult, ExecutionRegistry } from "./execution-registry.js";
import { mapProviderError } from "./provider-errors.js";
import { instrument, type LifecycleHandle } from "../observability/instrument.js";
import type { TraceContext } from "../contracts/observability.js";

export interface SessionRuntimeOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDir?: string;
  readonly authPath: string;
  readonly providerId?: string;
  readonly modelId?: string;
  /** 归属 Agent（ownerAgentId 语义，永久 Agent 身份） */
  readonly agentId?: string;
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
  /** 额外启用的工具名称（如记忆工具），不受 tool_mode 影响 */
  readonly extraTools?: readonly string[];
  /** 会话级插件工具（P0-1：宿主按 Agent 绑定过滤后注入 PI 工具注册表） */
  readonly pluginTools?: readonly PluginSessionTool[];
  /**
   * P0-2/P0 turn 快照工厂：每 turn 开始冻结绑定插件的授权/绑定状态
   * （ExecutionSnapshotService.create），in-flight turn 内工具调用以冻结态为准。
   * 返回成功/失败判别联合（PluginToolTurnContext）——冻结失败（插件未激活/
   * 无运行实例/创建异常）必须显式返回失败，禁止 undefined 静默降级实时权限。
   */
  readonly snapshotFactory?: (pluginId: string, agentId: string) => PluginToolTurnContext;
  /**
   * T11（Phase 13 验收 P0-1/P1-8）：Skill 元数据冻结工厂——beginTurn 以真实
   * turnId 调用，结果写入内部槽（PI 每 turn 重建系统提示时读取）。工厂抛错或
   * 返回空 → 槽置空 + error 诊断（fail-closed，绝不保留上一 turn 的旧 Skill
   * pointer 暴露给模型）。
   */
  readonly skillSnapshotFactory?: (input: { readonly agentId: string; readonly sessionId: string; readonly turnId: string }) => PiResourceSkills;
  /**
   * T11（P0-2）：read 工具 Skill 文件受控读取端口（闭包引用
   * SkillCoreService.readSkillFileForSession）。注入后传给沙箱扩展上下文。
   */
  readonly skillRead?: (input: { readonly absPath: string }) => Promise<SkillFileReadOutcome>;
  /** dispose 时的清理回调（如注销记忆工具上下文） */
  readonly onDispose?: () => void;
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
  private readonly agentId: string | undefined;
  private readonly providerId: string | undefined;
  private readonly modelId: string | undefined;
  /** 当前 turn 的埋点句柄（平台边界自动 started/terminal） */
  private turn: LifecycleHandle | undefined;
  /** 当前进行中的模型调用（同一会话串行，同时只有一个） */
  private activeModelCall: LifecycleHandle | undefined;
  private modelCallSeq = 0;
  /** toolCallId → toolName（tool_end 事件不含 toolName，需要从 tool_start 记账） */
  private readonly toolNames = new Map<string, string>();
  /** 会话级插件工具（P0-1/P0-2：注入 PI 注册表；每 turn 冻结快照） */
  private readonly pluginTools: readonly PluginSessionTool[];
  private readonly snapshotFactory: SessionRuntimeOptions["snapshotFactory"];
  /** T11：Skill 元数据槽（beginTurn 每 turn 冻结写入；PI loader 每 turn 读取） */
  private readonly skillsSlotRef: { current: PiResourceSkills };
  private readonly skillSnapshotFactory: SessionRuntimeOptions["skillSnapshotFactory"];
  /** T11（P0-2）：沙箱服务（turn 冻结后同步 Skill 只读根） */
  private readonly sandboxService: SandboxService | null;

  private constructor(
    readonly sessionId: string,
    private readonly agent: PiAgentSessionHandle,
    private readonly publish: (event: PlatformEventEnvelope) => void,
    private readonly replayStore: EventReplayStore | undefined,
    toolPolicy: ToolPolicy,
    options: SessionRuntimeOptions,
    private readonly onDispose?: () => void,
    readonly systemPrompt?: string,
    skillsSlotRef?: { current: PiResourceSkills },
    sandboxService?: SandboxService | null,
  ) {
    this.skillsSlotRef = skillsSlotRef ?? { current: { skills: [], diagnostics: [] } };
    this.sandboxService = sandboxService ?? null;
    this.toolPolicy = toolPolicy;
    this.agentId = options.agentId;
    this.providerId = options.resolveProviderId ?? options.providerId;
    this.modelId = options.resolveModelId ?? options.modelId;
    this.pluginTools = options.pluginTools ?? [];
    this.snapshotFactory = options.snapshotFactory;
    this.skillSnapshotFactory = options.skillSnapshotFactory;
    this.unsubscribe = agent.subscribe((event) => {
      this.observePiEvent(event);
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
        sessionId: options.sessionId,
        ...(options.workspaceCwd !== undefined ? { workspaceCwd: options.workspaceCwd } : {}),
      });
      toolPolicy.setSandboxService(sandboxService);
    }

    // ── Agent session 创建 ───────────────────────────────────────
    let agent: PiAgentSessionHandle;
    // T11：Skill 元数据槽（beginTurn 冻结；loader 闭包读取同一引用）
    const skillsSlotRef: { current: PiResourceSkills } = { current: { skills: [], diagnostics: [] } };

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
        // T12（P1-1）：无 Agent Session（无 SandboxService）但注入 skillRead 时
        // 也传 toolPolicy——沙箱扩展上下文据此构造，read 工具才能命中受控路径
        ...(sandboxService || options.skillRead !== undefined ? { toolPolicy } : {}),
        ...(options.extraTools ? { extraTools: options.extraTools } : {}),
        // T11：PI Skill pointer——内部槽（beginTurn 每 turn 冻结；loader 每 turn 读取）
        ...(options.skillSnapshotFactory !== undefined ? { skills: () => skillsSlotRef.current } : {}),
        // T11（P0-2）：read 工具 Skill 受控读取端口（沙箱扩展上下文）
        ...(options.skillRead !== undefined ? { sandboxContext: { skillRead: options.skillRead } } : {}),
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
        ...(options.extraTools ? { extraTools: options.extraTools } : {}),
        ...(options.pluginTools && options.pluginTools.length > 0 ? { customTools: options.pluginTools } : {}),
        ...(options.noTools ? { noTools: options.noTools } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        // T12（P1-1）：无 Agent Session（无 SandboxService）但注入 skillRead 时
        // 也传 toolPolicy——沙箱扩展上下文据此构造，read 工具才能命中受控路径
        ...(sandboxService || options.skillRead !== undefined ? { toolPolicy } : {}),
        // T11：PI Skill pointer——内部槽（beginTurn 每 turn 冻结；loader 每 turn 读取）
        ...(options.skillSnapshotFactory !== undefined ? { skills: () => skillsSlotRef.current } : {}),
        // T11（P0-2）：read 工具 Skill 受控读取端口（沙箱扩展上下文）
        ...(options.skillRead !== undefined ? { sandboxContext: { skillRead: options.skillRead } } : {}),
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
      options,
      options.onDispose,
      options.systemPrompt,
      skillsSlotRef,
      sandboxService,
    );
  }

  /**
   * P0-2 turn 冻结：对每个插件工具按 snapshotFactory 冻结授权/绑定状态，
   * 写入 tool.turnContext.current（invoke 闭包读取后传给 ToolService）。
   * - P0：冻结失败（factory 抛错/返回 undefined/返回 { ok: false }）一律写入
   *   失败结果——invoke 侧 fail-closed 拒绝执行，绝不静默降级为实时权限；
   * - P1-2：按 pluginId memoize——同一插件全部工具共享同一冻结快照
   *   （一次 in-flight turn 一个 snapshotId，§十一"一次 turn 使用同一快照"）；
   * - 无 snapshotFactory（未接入插件系统）时不设置（此时也没有插件工具注入）。
   */
  private beginTurn(turnId: string): void {
    // T11：Skill 元数据冻结（P0-1 真实 turnId；P1-8 fail-closed——冻结失败
    // 置空 + error 诊断，绝不保留上一 turn 的旧 Skill pointer）
    if (this.skillSnapshotFactory !== undefined) {
      try {
        this.skillsSlotRef.current = this.skillSnapshotFactory({
          agentId: this.agentId ?? "",
          sessionId: this.sessionId,
          turnId,
        });
        // T12（P0-1）：按当前 Turn 可见 Skill 根**整体替换**沙箱只读根——
        // 上一轮解绑/停用/插件禁用后的旧根必须移除，否则 PathGuard 动态规则
        // 残留会让 read 回退原始读取绕过当前 Snapshot。正文读取仍优先走
        // SkillContentService 受控路径。
        if (this.sandboxService !== null) {
          const roots = this.skillsSlotRef.current.skills
            .map((skill) => skill.baseDir)
            .filter((baseDir): baseDir is string => typeof baseDir === "string" && baseDir.length > 0);
          this.sandboxService.setReadOnlyRoots(roots, "skill-root-read");
        }
      } catch (error) {
        this.skillsSlotRef.current = {
          skills: [],
          diagnostics: [
            {
              type: "error",
              message: `Skill 快照冻结失败：${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
            },
          ],
        };
      }
    }
    if (this.snapshotFactory === undefined) {
      return;
    }
    const frozenByPlugin = new Map<string, PluginToolTurnContext>();
    for (const tool of this.pluginTools) {
      if (tool.turnContext === undefined) {
        continue;
      }
      let frozen = frozenByPlugin.get(tool.pluginId);
      if (frozen === undefined) {
        try {
          const result = this.snapshotFactory(tool.pluginId, this.agentId ?? "");
          frozen =
            result ??
            // 防御：工厂返回 undefined 视为冻结失败（禁止 undefined 表示成功）
            { ok: false, error: `插件 ${tool.pluginId} 快照冻结返回空结果，本 turn 工具已禁用` };
        } catch (error) {
          frozen = {
            ok: false,
            error: error instanceof Error ? error.message.slice(0, 400) : "插件快照冻结失败",
          };
        }
        frozenByPlugin.set(tool.pluginId, frozen);
      }
      tool.turnContext.current = frozen;
    }
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

    // Phase 11：turn 埋点（trace 贯穿模型/工具事件）+ started/terminal 平台自动产生
    const turnId = started.streamId;
    const trace: TraceContext = {
      traceId: instrument.newTraceId(),
      spanId: instrument.newSpanId(),
      operationId: turnId,
    };
    const scope = this.agentId !== undefined
      ? { ownerAgentId: this.agentId, sessionId: this.sessionId }
      : { sessionId: this.sessionId };
    this.turn = instrument.startLifecycle({
      startEventName: "turn.started",
      actor: { kind: "user", id: "web" },
      executor: { kind: "agent", id: this.agentId ?? "main-agent" },
      target: { kind: "turn", id: turnId },
      scope,
      operationId: turnId,
      trace,
      terminals: {
        completed: "turn.completed",
        failed: "turn.failed",
        cancelled: "turn.cancelled",
        interrupted: "turn.interrupted",
      },
      ...(this.providerId !== undefined || this.modelId !== undefined
        ? { startPayload: { attributes: { providerId: this.providerId ?? null, modelId: this.modelId ?? null } } }
        : {}),
    });

    // P0-2：turn 开始冻结绑定插件的授权/绑定快照——本 turn 内工具调用以冻结态为准，
    // 绑定/授权在 turn 中途的变更不影响 in-flight 执行；T11：同处冻结 Skill 元数据
    this.beginTurn(turnId);

    return instrument.runWithTrace({ trace }, () => {
      void this.runPrompt(text, started.streamId, mapper, controller);
      return { streamId: started.streamId, completed: started.completed };
    });
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
    try {
      this.onDispose?.();
    } finally {
      this.agent.dispose();
    }
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
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.agent.prompt(text);
      this.turn?.complete();
    } catch (error) {
      if (controller.signal.aborted) {
        this.turn?.cancel("aborted");
      } else {
        this.turn?.fail(error instanceof Error ? error : String(error));
      }
      const apiError = mapProviderError(error);
      this.emit(mapper.error(apiError.message, apiError.code, apiError.retryable));
    } finally {
      this.activeModelCall = undefined;
      this.turn = undefined;
      this.emit(mapper.sessionStatus("idle"));
      this.executions.finish(this.sessionId, streamId);
      if (this.mapper === mapper) this.mapper = undefined;
    }
  }

  /**
   * Phase 11 模型/工具调用埋点（PiAgentEvent 观测点）。
   * 只记录语义摘要：模型调用按 message 边界、工具按 toolCallId；
   * 绝不记录 tool result / message 内容（可能含文件正文）。
   */
  private observePiEvent(event: PiAgentEvent): void {
    if (event.type === "message_start" && event.role === "assistant") {
      this.activeModelCall?.complete(); // 防御：串行模型调用不应重叠
      this.modelCallSeq += 1;
      this.activeModelCall = instrument.startLifecycle({
        startEventName: "model.call.started",
        actor: { kind: "user", id: "web" },
        executor: { kind: "agent", id: this.agentId ?? "main-agent" },
        ...(this.providerId !== undefined ? { target: { kind: "provider", id: this.providerId } } : {}),
        ...(this.agentId !== undefined
          ? { scope: { ownerAgentId: this.agentId, sessionId: this.sessionId } }
          : { scope: { sessionId: this.sessionId } }),
        operationId: `model-${this.sessionId}-${this.modelCallSeq}`,
        terminals: {
          completed: "model.call.completed",
          failed: "model.call.failed",
          cancelled: "model.call.cancelled",
        },
        ...(this.modelId !== undefined ? { startPayload: { attributes: { modelId: this.modelId } } } : {}),
      });
      return;
    }
    if (event.type === "message_end" && event.role === "assistant") {
      this.activeModelCall?.complete();
      this.activeModelCall = undefined;
      return;
    }
    if (event.type === "tool_start") {
      this.toolNames.set(event.toolCallId, event.toolName);
      instrument.startLifecycle({
        startEventName: "tool.call.started",
        actor: { kind: "user", id: "web" },
        executor: { kind: "agent", id: this.agentId ?? "main-agent" },
        target: { kind: "tool", id: event.toolName },
        ...(this.agentId !== undefined
          ? { scope: { ownerAgentId: this.agentId, sessionId: this.sessionId, toolCallId: event.toolCallId } }
          : { scope: { sessionId: this.sessionId, toolCallId: event.toolCallId } }),
        operationId: `tool-${this.sessionId}-${event.toolCallId}`,
        terminals: {
          completed: "tool.call.completed",
          failed: "tool.call.failed",
          cancelled: "tool.call.cancelled",
          denied: "tool.call.denied",
        },
        startPayload: { attributes: { toolName: event.toolName } },
      });
      return;
    }
    if (event.type === "tool_end") {
      const operationId = `tool-${this.sessionId}-${event.toolCallId}`;
      const toolName = this.toolNames.get(event.toolCallId) ?? "unknown";
      this.toolNames.delete(event.toolCallId);
      const scope = this.agentId !== undefined
        ? { ownerAgentId: this.agentId, sessionId: this.sessionId, toolCallId: event.toolCallId }
        : { sessionId: this.sessionId, toolCallId: event.toolCallId };
      // result 可能含文件正文：只记录 isError 布尔，绝不落盘 result
      if (event.isError) {
        instrument.activity({
          eventName: "tool.call.failed",
          status: "failed",
          operationId,
          actor: { kind: "user", id: "web" },
          executor: { kind: "agent", id: this.agentId ?? "main-agent" },
          target: { kind: "tool", id: toolName },
          scope,
          payload: { summaryCode: "tool_call_failed", attributes: { isError: true } },
        });
      } else {
        instrument.activity({
          eventName: "tool.call.completed",
          status: "completed",
          operationId,
          actor: { kind: "user", id: "web" },
          executor: { kind: "agent", id: this.agentId ?? "main-agent" },
          target: { kind: "tool", id: toolName },
          scope,
          payload: { summaryCode: "tool_call_completed" },
        });
      }
      return;
    }
  }
}
