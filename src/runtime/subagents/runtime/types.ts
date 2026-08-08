// ═══════════════════════════════════════════════════════════════
// Phase 14 T4：Subagent Session 端口（plans/phase-14.md §13.2 / §13.3）
//
// SubagentRuntimeHost 不直接依赖 PI SDK（PI SDK 边界：只有 src/pi-sdk/ 可
// import @earendil-works/pi-*）。宿主（生产接线 T6 / 测试 Faux 适配器）实现
// SubagentSessionPort，把 PI AgentSession（createPiAgentSession /
// createPiFauxAgentSession）适配为端口：
// - start：注入工具定义并启动任务（模型循环）；
// - followUp / steer：映射 PI Agent 的 followUp / steer（queue / interrupt）；
// - onEvent：工具调用、迭代、Token 用量、首事件与终态事件流（RuntimeHost
//   据此驱动状态机、预算、超时与内部工具）；
// - 无记忆、无 spawn：工具注入由宿主按 EffectiveSnapshot 组装，内部三工具
//   由 RuntimeHost 提供（report_subagent_progress / request_parent_input /
//   report_subagent_result，§13.3：不属于 CapabilityCeiling，不可覆盖）。
// ═══════════════════════════════════════════════════════════════

/** 注入 Session 的工具定义（宿主转换为 PI customTools 或其他运行时形状） */
export interface SubagentSessionToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（跨进程输入由宿主/RuntimeHost 过 TypeBox 校验） */
  readonly parameters: Record<string, unknown>;
}

/** 工具调用结果（返回给模型循环） */
export interface SubagentToolInvokeResult {
  readonly ok: boolean;
  readonly text: string;
}

/** Session 事件流（RuntimeHost 消费） */
export type SubagentSessionEvent =
  | { readonly type: "tool-invoke"; readonly toolCallId: string; readonly name: string; readonly args: unknown; readonly resolve: (result: SubagentToolInvokeResult) => void }
  | { readonly type: "model-iteration"; readonly iteration: number }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly name: string }
  | { readonly type: "token-usage"; readonly input: number; readonly output: number }
  | { readonly type: "first-event" }
  | { readonly type: "terminal"; readonly reason: "completed" | "failed" | "cancelled" | "interrupted" }
  | { readonly type: "error"; readonly message: string };

export interface SubagentSessionStartInput {
  /** 渲染后的任务 Prompt（TaskBrief + ContextPacket + 约束，T3 TaskRenderer 产物） */
  readonly prompt: string;
  /** 注入的工具定义（内部三工具 + EffectiveSnapshot 能力工具） */
  readonly tools: readonly SubagentSessionToolDef[];
  /** thinkingLevel（Thread 冻结值；宿主转换为模型参数） */
  readonly thinkingLevel?: string;
}

/** 纠偏/消息投递结果（P0-1 复审：不能静默丢消息，未就绪必须显式 deferred） */
export type SubagentMessageDelivery = "applied" | "deferred" | "failed";

/** Subagent 会话端口（宿主适配 PI AgentSession 实现） */
export interface SubagentSessionPort {
  readonly sessionId: string;
  start(input: SubagentSessionStartInput): Promise<void>;
  /**
   * queue 纠偏 → PI followUp（P0-1：真实转发，不是 prompt 模拟）。
   * - applied：消息已进入会话队列；
   * - deferred：会话未就绪（未启动/无首事件）——调用方必须延迟重试，不得丢弃；
   * - failed：会话已终结——调用方按终态结算（迟到的消息不再应用）。
   */
  followUp(message: string): SubagentMessageDelivery;
  /** interrupt 纠偏 → PI steer（P0-1：真实转发） */
  steer(message: string): SubagentMessageDelivery;
  abort(): void;
  dispose(): void;
  /** 订阅事件流；返回退订函数（重复订阅去重） */
  onEvent(listener: (event: SubagentSessionEvent) => void): () => void;
}

/** 宿主提供 Session 工厂（注入 RuntimeHost；测试注入 Faux 适配器） */
export interface SubagentSessionFactory {
  create(input: { readonly threadId: string; readonly ownerAgentId: string; readonly parentSessionId: string; readonly runId: string; readonly sessionDir: string; readonly workspaceCwd: string }): Promise<SubagentSessionPort>;
}
