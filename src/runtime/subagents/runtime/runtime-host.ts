import { type SubagentOwnership } from "../stores/types.js";
import type { SubagentMessageRecord } from "../stores/message-store.js";
import { MessageStore } from "../stores/message-store.js";
import type { SubagentRunRecord, SubagentRunUsage } from "../stores/run-store.js";
import { RunStore } from "../stores/run-store.js";
import type { SubagentTransactions } from "../stores/subagent-transactions.js";
import {
  SUBAGENT_HEARTBEAT_INTERVAL_MS,
  SUBAGENT_RUNTIME_LEASE_TTL_MS,
  SUBAGENT_MESSAGE_ID_PREFIX,
  SUBAGENT_MAILBOX_ID_PREFIX,
  isSubagentRunActive,
  type AgentMessageEnvelopeV1,
  type AgentMessageId,
  type ParentMailboxId,
  type SubagentDeliveryMode,
  type SubagentResultV1,
  type SubagentRunId,
  type SubagentRunLimitsV1,
  type SubagentRunStatus,
  type SubagentSnapshotId,
  type SubagentThreadId,
} from "../../../contracts/subagents.js";
import { parseInputArgs, parseProgressArgs, parseResultArgs, subagentInternalToolDefs, REPORT_SUBAGENT_RESULT_TOOL, isNestingForbiddenToolName } from "./internal-tools.js";
import type { SubagentSessionEvent, SubagentSessionFactory, SubagentSessionPort, SubagentSessionToolDef } from "./types.js";
import { WorkspaceMutationLeaseService, SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS } from "../workspace-lease-service.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T4：SubagentRuntimeHost（plans/phase-14.md §13 / §15）
//
// 单个 Subagent Run 的执行宿主：
// - queued → starting（startWithSnapshot：快照 + Runtime Lease 单事务）→ running；
//   快照冻结失败在 starting 阶段 fail-closed（Run 不启动）；
// - 三个内部控制工具恒注册（不可覆盖、schema 校验、result 唯一）；
// - 模型两次结束仍未调用 report_subagent_result → failed/subagent_result_not_reported；
// - timeout/budget 确定性保护（§15.2）：startup/first-event/idle/total →
//   timed_out；迭代/工具调用/Token → budget_exhausted；原因映射见 §15.5；
// - heartbeat 每 15s 续租、Lease TTL 45s；heartbeat 不得更新业务 lastActivityAt
//   （两个时间轴，§15.3）；Lease 丢失 → 停止写状态并 abort（恢复由启动恢复处理）；
// - 终态经 SubagentTransactions.completeRunWithResult（terminal+result+message+
//   mailbox 原子；T5 消费 mailbox）；
// - 事件回调（onRunProgress/onMessage/onTerminal/onLeaseLost）供 T5/T7 投影。
//
// T5 扩展（协议 Dispatcher 的 Runtime 侧，§13.4 / §14.1）：
// - cancelRun：父取消（stop → abort + cancelled 终态；waiting_for_input 先
//   cancelling 再收敛，转换表无直接边）；
// - deliverParentMessage：queue → followUp / interrupt → steer 投递；
// - started 状态 Mailbox 在 starting → running 事务内写入（不唤醒父 Turn）；
// - request_parent_input 改为原子事务（消息 + waiting_for_input + Mailbox）。
//
// RuntimeHost 不依赖 PI SDK：Session 行为经 SubagentSessionPort 抽象（宿主
// 适配 PI AgentSession，测试注入 Faux 适配器）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentRuntimeHostDeps {
  readonly runs: RunStore;
  readonly messages: MessageStore;
  readonly transactions: SubagentTransactions;
  readonly sessionFactory: SubagentSessionFactory;
  /** 当前 Server 启动 bootId（Lease 持有者身份） */
  readonly bootId: string;
  /**
   * T9b（§18.3）：工作区写 Lease 服务。write Run 启动时获取 run-scoped 独占
   * 长 Lease（subagent_write），heartbeat 续租，终态/清理释放；与父 Agent
   * 写 Tool 的 operation-scoped parent_write permit 互斥（组合根注入）。
   * 缺省（测试/无服务）不获取。
   */
  readonly workspaceLeases?: WorkspaceMutationLeaseService;
  readonly now?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly runtimeLeaseTtlMs?: number;
  /** T5/T7 投影回调（best-effort，失败不阻断执行） */
  readonly onRunProgress?: (event: { readonly runId: SubagentRunId; readonly phase?: string; readonly text: string }) => void;
  readonly onMessage?: (event: { readonly runId: SubagentRunId; readonly message: SubagentMessageRecord }) => void;
  readonly onTerminal?: (event: { readonly runId: SubagentRunId; readonly threadId: SubagentThreadId; readonly status: string; readonly reasonCode: string | null; readonly result: SubagentResultV1 | null }) => void;
  readonly onLeaseLost?: (event: { readonly runId: SubagentRunId }) => void;
  /** Run 完全清理后回调（active 已移除，容量真实释放；Scheduler 据此启动排队 Run） */
  readonly onRunFinished?: (event: { readonly runId: SubagentRunId; readonly threadId: SubagentThreadId }) => void;
}

export interface ExecuteSubagentRunInput {
  readonly runId: SubagentRunId;
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  readonly snapshotId: SubagentSnapshotId;
  /** EffectiveSnapshot 稳定序列化（capability_ceiling/snapshot_json 持久） */
  readonly snapshotJson: string;
  /** TaskRenderer 产物（TaskBrief + ContextPacket + 约束） */
  readonly prompt: string;
  /** EffectiveSnapshot 能力工具（内部三工具由 Host 自动注入） */
  readonly abilityTools: readonly SubagentSessionToolDef[];
  /** Thread PI transcript 目录（sessionDir/<sessionId>.jsonl 等） */
  readonly sessionDir: string;
  readonly workspaceCwd: string;
  readonly limits: SubagentRunLimitsV1;
  readonly thinkingLevel?: string;
  /** 触发本 Run 的协议消息（task/steer）——首条消息已由事务创建；终态消息新建 */
  readonly triggerMessageId: AgentMessageId;
}

export type ExecuteSubagentRunResult =
  | { readonly status: "started" }
  | { readonly status: "rejected"; readonly reasonCode: string; readonly reason: string };

/** 超时/预算终态原因（§15.5 映射，稳定 reasonCode） */
export const SUBAGENT_TIMEOUT_REASON_CODES = {
  startup: "subagent_timeout_startup",
  firstEvent: "subagent_timeout_first_event",
  idle: "subagent_timeout_idle",
  total: "subagent_timeout_total",
} as const;

export const SUBAGENT_BUDGET_REASON_CODES = {
  iterations: "subagent_budget_iterations",
  toolCalls: "subagent_budget_tool_calls",
  tokens: "subagent_budget_tokens",
} as const;

export class SubagentRuntimeHost {
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly runtimeLeaseTtlMs: number;
  /** runId → 活动句柄（abort/清理用；同一 Server 同时最多 capacity 个，由 Scheduler 保证） */
  private readonly active = new Map<SubagentRunId, ActiveRun>();

  constructor(private readonly deps: SubagentRuntimeHostDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? SUBAGENT_HEARTBEAT_INTERVAL_MS;
    this.runtimeLeaseTtlMs = deps.runtimeLeaseTtlMs ?? SUBAGENT_RUNTIME_LEASE_TTL_MS;
  }

  get activeRunCount(): number {
    return this.active.size;
  }

  isRunActive(runId: SubagentRunId): boolean {
    return this.active.has(runId);
  }

  /** 关闭：停止所有 active Run 的心跳/定时器并 abort Session（Server 关闭/重启时调用） */
  dispose(): void {
    for (const [, active] of [...this.active]) {
      this.clearTimers(active);
      active.abort();
      active.session = null;
    }
    this.active.clear();
  }

  /**
   * waiting_for_input 恢复（§9.4 / §13.4）：父 Agent 回答（answer_input
   * steer）后 waiting_for_input → running 并恢复 idle 计时；回答的
   * steer 消息落库由调用方（主 Agent answer_input 工具，T6）负责。
   * 返回是否成功恢复（非 waiting_for_input / 未活跃 / 已终态 → false）。
   */
  resumeFromInput(runId: SubagentRunId, answerText: string, ownership: SubagentOwnership, at: string): boolean {
    const active = this.active.get(runId);
    if (active === undefined || !active.waitingForInput || active.terminalHandled || active.leaseLost) {
      return false;
    }
    try {
      this.deps.runs.transit({ runId, from: "waiting_for_input", to: "running", reasonCode: null, now: at }, ownership);
    } catch {
      return false;
    }
    active.waitingForInput = false;
    this.touchActivity(active); // 重新武装 idle 计时
    active.session?.steer(answerText); // interrupt 语义：PI steer
    return true;
  }

  /**
   * T5 父侧取消（§13.4 stop → Runtime abort；§16.4 #5 取消终态 + terminal
   * message + mailbox）。只处理本 Host 活动 Run；已终态/Lease 丢失/非活跃
   * 返回 false（调用方按迟到消息结算）。转换表无 waiting_for_input →
   * cancelled 直接边（T1 冻结），先 waiting → cancelling 再收敛 cancelled。
   */
  cancelRun(runId: SubagentRunId, ownership: SubagentOwnership, reasonCode: string | null): boolean {
    const active = this.active.get(runId);
    if (active === undefined || active.terminalHandled || active.leaseLost) {
      return false;
    }
    const now = new Date(this.now()).toISOString();
    const current = this.deps.runs.get(runId, ownership);
    if (current === null || !isSubagentRunActive(current.status)) {
      return false; // 已终态：由 Dispatcher 按迟到结算
    }
    let fromOverride: SubagentRunStatus;
    if (current.status === "waiting_for_input" || current.status === "running" || current.status === "starting") {
      // 状态机没有 running/starting/waiting_for_input → cancelled 直接边
      // （T1 冻结），先转 cancelling 再收敛 cancelled（§16.4 #5）
      try {
        this.deps.runs.transit({ runId, from: current.status, to: "cancelling", reasonCode: null, now }, ownership);
        fromOverride = "cancelling";
      } catch {
        // 并发路径已抢先转换；按当前状态收敛
        const after = this.deps.runs.get(runId, ownership);
        if (after === null || !isSubagentRunActive(after.status)) {
          return false;
        }
        fromOverride = after.status === "cancelling" ? "cancelling" : after.status === "running" ? "running" : "starting";
      }
    } else if (current.status === "queued") {
      return false; // queued Run 由 Dispatcher 直接终态化（本 Host 无 Session）
    } else {
      fromOverride = current.status;
    }
    void this.terminal(runId, active.threadId, ownership, "cancelled", reasonCode, null, null, fromOverride);
    active.abort();
    return true;
  }

  /**
   * T5 父 → 子协议消息投递（§13.4 queue → PI followUp；interrupt → PI steer；
   * stop → cancelRun）。instruction 由 Dispatcher 从 Envelope parts 渲染
   * （data part 过 TypeBox 校验，非法不入 Runtime，§8.3）。
   * 返回 "applied"（已应用到活动 Session）/ "not-active"（Run 不在本 Host 活动）。
   */
  deliverParentMessage(
    input: {
      readonly runId: SubagentRunId;
      readonly messageType: "steer" | "cancel";
      readonly deliveryMode: SubagentDeliveryMode;
      readonly instruction: string | null;
    },
    ownership: SubagentOwnership,
  ): "applied" | "not-active" {
    const active = this.active.get(input.runId);
    if (active === undefined || active.terminalHandled || active.leaseLost) {
      return "not-active";
    }
    if (input.messageType === "cancel") {
      this.cancelRun(input.runId, ownership, "subagent_cancelled_by_parent");
      return "applied";
    }
    if (input.instruction !== null && input.instruction.length > 0) {
      if (input.deliveryMode === "interrupt") {
        active.session?.steer(input.instruction);
      } else {
        active.session?.followUp(input.instruction);
      }
    }
    return "applied";
  }

  /**
   * 启动并执行一个 Run（异步；不阻塞调用方）。
   * 所有失败路径都收敛到终态事务（failed/timed_out/budget_exhausted/interrupted），
   * 不留下活动态 Run（Lease 丢失除外——停止写状态，恢复由启动恢复处理）。
   */
  execute(input: ExecuteSubagentRunInput): ExecuteSubagentRunResult {
    if (this.active.has(input.runId)) {
      return { status: "rejected", reasonCode: "subagent_run_state_conflict", reason: `Run ${input.runId} 已在本 Host 执行中` };
    }
    void this.run(input);
    return { status: "started" };
  }

  private async run(input: ExecuteSubagentRunInput): Promise<void> {
    const { runId, threadId, ownership } = input;
    const holderId = `subagent-host`;
    const nowIso = () => new Date(this.now()).toISOString();
    let run: SubagentRunRecord;
    try {
      // 1. queued → starting + snapshot + Runtime Lease（单事务，§16.4 #3）
      run = this.deps.runs.startWithSnapshot(
        {
          runId,
          snapshotId: input.snapshotId,
          snapshotJson: input.snapshotJson,
          limits: input.limits,
          leaseBootId: this.deps.bootId,
          leaseHolderId: holderId,
          leaseExpiresAt: new Date(this.now() + this.runtimeLeaseTtlMs).toISOString(),
          now: nowIso(),
        },
        ownership,
      );
    } catch (error) {
      // 快照/租约事务失败：Run 未进入 starting（CAS 冲突或数据校验失败），
      // 保持原状态由启动恢复/调用方兜底；记录到回调
      this.deps.onRunProgress?.({ runId, text: `Run 启动失败（快照/租约事务）：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}` });
      return;
    }

    const active: ActiveRun = {
      runId,
      threadId,
      ownership,
      limits: input.limits,
      phase: "starting",
      toolCallCount: 0,
      iterationCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastActivityAt: this.now(),
      waitingForInput: false,
      resultReported: false,
      resultReminderSent: false,
      leaseLost: false,
      terminalHandled: false,
      workspaceLease: null,
      timers: [],
      abort: () => undefined,
      session: null,
    };
    this.active.set(runId, active);
    try {
      // T9b（§18.3）：write Run 获取工作区独占写 Lease（read Run 不获取；
      // 父 Agent 写 permit 占用中 → fail-closed 拒绝启动写 Run）
      if (this.deps.workspaceLeases !== undefined && workspaceAccessOf(input.snapshotJson) === "write") {
        const outcome = this.deps.workspaceLeases.acquire(input.workspaceCwd, {
          leaseKind: "subagent_write",
          ownerKind: "subagent",
          ownerId: runId,
          bootId: this.deps.bootId,
          ttlMs: SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS,
        });
        if (outcome.status === "denied") {
          await this.terminal(
            runId,
            threadId,
            ownership,
            "failed",
            "subagent_operation_failed",
            null,
            new Error(`工作区写 Lease 被占用（${outcome.reason}）`),
          );
          return;
        }
        active.workspaceLease = { canonicalWorkspace: input.workspaceCwd };
      }
      await this.runWithSession(input, active, run);
    } catch (error) {
      // 未收敛异常 → failed（安全摘要；不暴露内部细节）
      await this.terminal(runId, threadId, ownership, "failed", "subagent_operation_failed", null, error);
    } finally {
      this.cleanup(runId);
    }
  }

  private async runWithSession(input: ExecuteSubagentRunInput, active: ActiveRun, run: SubagentRunRecord): Promise<void> {
    const { runId, threadId, ownership } = input;
    let session: SubagentSessionPort;
    try {
      session = await this.createSessionWithStartupTimeout(input, active);
    } catch (error) {
      // startup 超时 → timed_out/subagent_timeout_startup；其他创建错误 → failed
      // （安全摘要，§22.3：不暴露内部细节）
      const startupTimedOut = error instanceof Error && error.message.startsWith("provider session startup timeout");
      await this.terminal(
        runId,
        threadId,
        ownership,
        startupTimedOut ? "timed_out" : "failed",
        startupTimedOut ? SUBAGENT_TIMEOUT_REASON_CODES.startup : "subagent_operation_failed",
        null,
        error,
      );
      return;
    }
    active.abort = () => session.abort();
    active.session = session;
    const unsubscribe = session.onEvent((event) => this.handleSessionEvent(input, active, session, event));

    // 2. starting → running（快照已冻结；进入执行）+ started 状态 Mailbox
    //    （§14.1：started 不唤醒父 Turn，只供状态查询；§8.4）
    try {
      this.deps.transactions.markRunStartedWithMailbox(
        {
          runId,
          threadId,
          ownership,
          mailbox: {
            mailboxId: this.newMailboxId(),
            messageId: this.newMessageId(),
            operationId: `subagent-started-${runId}`,
          },
          now: new Date(this.now()).toISOString(),
        },
      );
    } catch (error) {
      unsubscribe();
      session.dispose();
      await this.terminal(runId, threadId, ownership, "failed", "subagent_run_state_conflict", null, error);
      return;
    }
    active.phase = "running";

    // 3. 确定性保护定时器（§15.2）
    this.armTimers(input, active);

    // 4. 心跳续租（heartbeat 不更新业务 lastActivityAt，§15.3）
    const heartbeat = setInterval(() => {
      if (active.leaseLost) {
        return;
      }
      const renewed = this.deps.runs.renewLease(
        {
          runId,
          bootId: this.deps.bootId,
          holderId: "subagent-host",
          expiresAt: new Date(this.now() + this.runtimeLeaseTtlMs).toISOString(),
          now: new Date(this.now()).toISOString(),
        },
        ownership,
      );
      // T9b（§18.3）：write Run 同步续租工作区 Lease；续租失败视为 Lease 丢失
      let workspaceRenewed = true;
      if (renewed && active.workspaceLease !== null && this.deps.workspaceLeases !== undefined) {
        const outcome = this.deps.workspaceLeases.renew(active.workspaceLease.canonicalWorkspace, runId, this.deps.bootId, SUBAGENT_WRITE_LEASE_DEFAULT_TTL_MS);
        workspaceRenewed = outcome.status === "renewed";
      }
      if (!renewed || !workspaceRenewed) {
        // Lease 丢失：停止写状态并 abort（恢复由启动恢复处理）
        active.leaseLost = true;
        this.clearTimers(active);
        session.abort();
        this.deps.onLeaseLost?.({ runId });
      }
    }, this.heartbeatIntervalMs);
    active.timers.push(heartbeat);

    // 5. 启动模型循环
    try {
      await session.start({
        prompt: input.prompt,
        tools: [...subagentInternalToolDefs(), ...input.abilityTools],
        ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      });
    } catch (error) {
      unsubscribe();
      clearInterval(heartbeat);
      session.dispose();
      await this.terminal(runId, threadId, ownership, "failed", "subagent_operation_failed", null, error);
      return;
    }

    // 6. 会话结束（start resolve = 模型不再继续，§13.2）：
    //    模型结束由 terminal 事件驱动检查（onModelTerminal）；此处兜底
    //    处理"结束但从未收到 terminal 事件"的异常路径（结果缺失）。
    unsubscribe();
    clearInterval(heartbeat);
    session.dispose();
    if (active.leaseLost || active.resultReported || active.terminalHandled) {
      return; // 停止写状态 / 终态已收敛
    }
    await this.terminal(runId, threadId, ownership, "failed", "subagent_result_not_reported", null, null);
  }

  /** Session 创建受 startupTimeoutMs 保护（§15.2：Provider 启动超时 → timed_out） */
  private createSessionWithStartupTimeout(input: ExecuteSubagentRunInput, active: ActiveRun): Promise<SubagentSessionPort> {
    const { runId, threadId, ownership } = input;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`provider session startup timeout (${active.limits.startupTimeoutMs}ms)`));
      }, active.limits.startupTimeoutMs);
      void this.deps.sessionFactory
        .create({
          threadId,
          ownerAgentId: ownership.ownerAgentId,
          parentSessionId: ownership.parentSessionId,
          runId,
          sessionDir: input.sessionDir,
          workspaceCwd: input.workspaceCwd,
        })
        .then(
          (session) => {
            clearTimeout(timer);
            resolve(session);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  }

  private handleSessionEvent(
    input: ExecuteSubagentRunInput,
    active: ActiveRun,
    session: { followUp(message: string): void; steer(message: string): void },
    event: SubagentSessionEvent,
  ): void {
    const { runId, threadId, ownership } = input;
    switch (event.type) {
      case "first-event":
      case "token-usage":
      case "model-iteration":
      case "tool-call":
      case "tool-invoke":
        this.touchActivity(active);
        break;
      default:
        break;
    }
    switch (event.type) {
      case "first-event":
        this.cancelTimer(active, "firstEvent");
        break;
      case "model-iteration":
        active.iterationCount = event.iteration;
        if (active.iterationCount >= active.limits.maxModelIterations) {
          void this.terminal(runId, threadId, ownership, "budget_exhausted", SUBAGENT_BUDGET_REASON_CODES.iterations, null, null);
        }
        break;
      case "tool-call":
        active.toolCallCount += 1;
        if (active.toolCallCount >= active.limits.maxToolCalls) {
          void this.terminal(runId, threadId, ownership, "budget_exhausted", SUBAGENT_BUDGET_REASON_CODES.toolCalls, null, null);
        }
        break;
      case "token-usage":
        active.inputTokens += event.input;
        active.outputTokens += event.output;
        if (active.inputTokens + active.outputTokens >= active.limits.maxTotalTokens) {
          void this.terminal(runId, threadId, ownership, "budget_exhausted", SUBAGENT_BUDGET_REASON_CODES.tokens, null, null);
        }
        break;
      case "tool-invoke":
        void this.handleInternalTool(input, active, event);
        break;
      case "terminal":
        // 模型循环结束（§13.3）：result 缺失检查在 onModelTerminal 统一处理
        void this.onModelTerminal(input, active, session);
        break;
      case "error":
        this.deps.onRunProgress?.({ runId, text: `运行错误：${event.message.slice(0, 200)}` });
        break;
    }
  }

  /**
   * 模型循环结束（§13.3）：模型结束但未调用 report_subagent_result →
   * 第一次结束提醒一次（followUp，会话继续）；第二次仍缺失 →
   * failed/subagent_result_not_reported。
   */
  private onModelTerminal(
    input: ExecuteSubagentRunInput,
    active: ActiveRun,
    session: { followUp(message: string): void },
  ): void {
    if (active.leaseLost || active.terminalHandled || active.resultReported) {
      return;
    }
    if (!active.resultReminderSent) {
      active.resultReminderSent = true;
      session.followUp(
        "你还没有调用 report_subagent_result 提交最终结构化结果。请调用 report_subagent_result 后再结束；若任务确已无法完成，也必须调用该工具提交 disposition=failed 的结果。",
      );
      return;
    }
    void this.terminal(input.runId, input.threadId, input.ownership, "failed", "subagent_result_not_reported", null, null);
  }

  /** 内部控制工具分发（§13.3；其他工具由 Session 宿主执行，不进入本路径） */
  private async handleInternalTool(
    input: ExecuteSubagentRunInput,
    active: ActiveRun,
    event: Extract<SubagentSessionEvent, { readonly type: "tool-invoke" }>,
  ): Promise<void> {
    const { runId, threadId, ownership } = input;
    const resolve = event.resolve;

    // T9b（§13.5）：模型伪造父控制工具（spawn_subagent 等）→ 确定性拒绝
    if (isNestingForbiddenToolName(event.name)) {
      resolve({ ok: false, text: "subagent_nesting_forbidden: Subagent 不能创建或控制其他 Agent/Subagent" });
      return;
    }

    if (event.name === "report_subagent_progress") {
      const args = parseProgressArgs(event.args);
      if (args === null) {
        resolve({ ok: false, text: "参数校验失败（report_subagent_progress）" });
        return;
      }
      active.phase = args.phase ?? active.phase;
      try {
        const message = this.appendProtocolMessage(input, active, "progress", args.text);
        this.deps.onRunProgress?.({ runId, ...(args.phase !== undefined ? { phase: args.phase } : {}), text: args.text });
        this.deps.onMessage?.({ runId, message });
        resolve({ ok: true, text: "已记录进展" });
      } catch (error) {
        resolve({ ok: false, text: `进展记录失败：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}` });
      }
      return;
    }

    if (event.name === "request_parent_input") {
      const args = parseInputArgs(event.args);
      if (args === null) {
        resolve({ ok: false, text: "参数校验失败（request_parent_input）" });
        return;
      }
      if (active.waitingForInput) {
        resolve({ ok: false, text: "同一 Run 同时只能有一个未解决的 input_required" });
        return;
      }
      try {
        // §13.3：原子写消息 + waiting_for_input + Parent Mailbox（§16.4）
        const now = new Date(this.now()).toISOString();
        const envelope = this.protocolEnvelope(input, active, "input_required", args.question, now);
        const outcome = this.deps.transactions.waitingForInputWithMailbox(
          {
            runId,
            threadId,
            ownership,
            envelope,
            mailbox: {
              mailboxId: this.newMailboxId(),
              messageId: envelope.messageId,
              operationId: `subagent-input-required-${runId}`,
            },
            now,
          },
        );
        active.waitingForInput = true;
        this.pauseIdleTimer(active);
        this.deps.onMessage?.({ runId, message: outcome.message });
        resolve({ ok: true, text: "已向父 Agent 请求输入；等待父 Agent 回答后自动恢复" });
      } catch (error) {
        resolve({ ok: false, text: `请求输入失败：${error instanceof Error ? error.message.slice(0, 160) : "unknown"}` });
      }
      return;
    }

    if (event.name === REPORT_SUBAGENT_RESULT_TOOL) {
      const args = parseResultArgs(event.args);
      if (args === null) {
        resolve({ ok: false, text: "参数校验失败（report_subagent_result）" });
        return;
      }
      if (active.resultReported) {
        resolve({ ok: false, text: "本 Run 已提交过结果（一次性）" });
        return;
      }
      active.resultReported = true;
      const result: SubagentResultV1 = {
        version: 1,
        disposition: args.disposition,
        summary: args.summary,
        criteria: args.criteria,
        artifacts: args.artifacts,
        unresolvedIssues: args.unresolvedIssues,
        recommendedNextAction: args.recommendedNextAction,
      };
      await this.terminal(runId, threadId, ownership, "succeeded", null, result, null);
      resolve({ ok: true, text: "结果已提交" });
      return;
    }

    resolve({ ok: false, text: `未知内部控制工具：${event.name}` });
  }

  /** 终态收敛：terminal Run + result + result message + mailbox 原子（§16.4 #4） */
  private async terminal(
    runId: SubagentRunId,
    threadId: SubagentThreadId,
    ownership: SubagentOwnership,
    to: "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted" | "budget_exhausted",
    reasonCode: string | null,
    result: SubagentResultV1 | null,
    error: unknown,
    /** T5：调用方已知确切当前状态时覆盖（如取消路径 waiting → cancelling 后） */
    fromOverride?: SubagentRunStatus,
  ): Promise<void> {
    const active = this.active.get(runId);
    if (active === undefined || active.terminalHandled || active.leaseLost) {
      return; // 幂等：终态只收敛一次；Lease 丢失后停止写状态（恢复由启动恢复处理）
    }
    active.terminalHandled = true;
    this.clearTimers(active);
    const now = new Date(this.now()).toISOString();
    const usage: SubagentRunUsage = {
      inputTokens: active.inputTokens,
      outputTokens: active.outputTokens,
      totalTokens: active.inputTokens + active.outputTokens,
    };
    // from 取当前实际状态（starting 阶段失败 / waiting_for_input 终态都合法）；
    // 转换表没有 waiting_for_input → succeeded（T1 冻结），succeeded 先恢复
    // running 再收敛（并发被恢复路径抢先 → CAS 失败后从 running 重试）
    let from: SubagentRunStatus = fromOverride ?? (active.phase === "starting" ? "starting" : active.waitingForInput ? "waiting_for_input" : "running");
    if (to === "succeeded" && from === "waiting_for_input") {
      try {
        this.deps.runs.transit({ runId, from: "waiting_for_input", to: "running", reasonCode: null, now }, ownership);
      } catch {
        // 恢复路径已抢先转 running；下面从 running 重试
      }
      from = "running";
    }
    const messageId = this.newMessageId();
    const mailboxId = this.newMailboxId();
    try {
      const outcome = this.deps.transactions.completeRunWithResult(
        {
          runId,
          threadId,
          ownership,
          from,
          to,
          result: to === "succeeded" ? result : null,
          reasonCode: reasonCode ?? (error instanceof Error ? error.message.slice(0, 200) : null),
          usage,
          resultEnvelope: this.resultEnvelope(runId, threadId, messageId, to, result, reasonCode, ownership.ownerAgentId, now),
          mailbox: {
            mailboxId,
            messageId,
            notificationKind: to === "succeeded" ? "completed" : to,
            operationId: `subagent-terminal-${runId}-${to}`,
            triggerParentTurn: to !== "cancelled",
          },
          now,
        },
      );
      if (!outcome.idempotent) {
        this.deps.onTerminal?.({ runId, threadId, status: to, reasonCode: outcome.run.reasonCode, result: outcome.run.result });
      }
    } catch (terminalError) {
      // Runtime terminal 写库失败：阻止后续执行（Run 已不再写状态），
      // 重试语义交给启动恢复/调用方；记录到回调
      this.deps.onRunProgress?.({ runId, text: `终态事务失败：${terminalError instanceof Error ? terminalError.message.slice(0, 160) : "unknown"}` });
    }
  }

  /** 协议消息落库（store-first，§8.2；progress/input_required 由 Subagent 发送） */
  private appendProtocolMessage(
    input: ExecuteSubagentRunInput,
    active: ActiveRun,
    messageType: "progress" | "input_required",
    text: string,
  ): SubagentMessageRecord {
    const now = new Date(this.now()).toISOString();
    const envelope = this.protocolEnvelope(input, active, messageType, text, now);
    return this.deps.messages.append({ envelope, ownership: input.ownership, createdAt: now }).message;
  }

  /** Subagent → 父协议 Envelope（store-first：sequence 由 Store 分配后补全） */
  private protocolEnvelope(
    input: ExecuteSubagentRunInput,
    active: ActiveRun,
    messageType: "progress" | "input_required",
    text: string,
    now: string,
  ): Omit<AgentMessageEnvelopeV1, "sequence"> {
    return {
      protocol: "opencolorful.agent-message",
      version: 1,
      messageId: this.newMessageId(),
      contextId: input.threadId,
      taskId: input.runId,
      sender: { kind: "subagent", id: input.runId },
      recipient: { kind: "parent_agent", id: input.ownership.ownerAgentId },
      messageType,
      deliveryMode: "immediate",
      parts: [{ kind: "text", text }],
      metadata: { createdAt: now, traceId: `trace-${input.runId}`, schemaName: `subagent.${messageType}` },
    };
  }

  private resultEnvelope(
    runId: SubagentRunId,
    threadId: SubagentThreadId,
    messageId: AgentMessageId,
    to: string,
    result: SubagentResultV1 | null,
    reasonCode: string | null,
    ownerAgentId: string,
    now: string,
  ): Omit<AgentMessageEnvelopeV1, "sequence"> {
    const parts = result !== null
      ? [{ kind: "data" as const, schema: "subagent.result.v1", value: result }]
      : [{ kind: "text" as const, text: reasonCode ?? to }];
    return {
      protocol: "opencolorful.agent-message",
      version: 1,
      messageId,
      contextId: threadId,
      taskId: runId,
      sender: { kind: "subagent", id: runId },
      recipient: { kind: "parent_agent", id: ownerAgentId },
      messageType: "result",
      deliveryMode: "mailbox",
      parts,
      metadata: { createdAt: now, traceId: `trace-${runId}`, schemaName: "subagent.result" },
    };
  }

  // ── 确定性保护（§15.2）──────────────────────────────────────

  private armTimers(input: ExecuteSubagentRunInput, active: ActiveRun): void {
    const { runId, threadId, ownership } = input;
    // total timeout
    active.timers.push(setTimeout(() => {
      void this.terminal(runId, threadId, ownership, "timed_out", SUBAGENT_TIMEOUT_REASON_CODES.total, null, null);
    }, active.limits.totalRunTimeoutMs));
    // first-event timeout（start 后等待首个模型事件）
    active.timers.push({ kind: "firstEvent", handle: setTimeout(() => {
      void this.terminal(runId, threadId, ownership, "timed_out", SUBAGENT_TIMEOUT_REASON_CODES.firstEvent, null, null);
    }, active.limits.providerFirstEventTimeoutMs) });
    // idle timeout（活动重置；waiting_for_input 暂停）
    active.timers.push({ kind: "idle", handle: setTimeout(() => {
      if (!active.waitingForInput && !active.terminalHandled) {
        void this.terminal(runId, threadId, ownership, "timed_out", SUBAGENT_TIMEOUT_REASON_CODES.idle, null, null);
      }
    }, active.limits.idleTimeoutMs) });
  }

  private touchActivity(active: ActiveRun): void {
    active.lastActivityAt = this.now();
    const idle = active.timers.find((timer): timer is { readonly kind: "idle"; handle: NodeJS.Timeout } => "kind" in timer && timer.kind === "idle");
    if (idle !== undefined) {
      clearTimeout(idle.handle);
      idle.handle = setTimeout(() => {
        if (!active.waitingForInput && !active.terminalHandled) {
          void this.terminal(active.runId, active.threadId, active.ownership, "timed_out", SUBAGENT_TIMEOUT_REASON_CODES.idle, null, null);
        }
      }, active.limits.idleTimeoutMs);
    }
  }

  private pauseIdleTimer(active: ActiveRun): void {
    const idle = active.timers.find((timer): timer is { readonly kind: "idle"; handle: NodeJS.Timeout } => "kind" in timer && timer.kind === "idle");
    if (idle !== undefined) {
      clearTimeout(idle.handle);
    }
  }

  private cancelTimer(active: ActiveRun, kind: "firstEvent"): void {
    const index = active.timers.findIndex((timer) => "kind" in timer && timer.kind === kind);
    if (index >= 0) {
      const timer = active.timers[index];
      if (timer !== undefined && "handle" in timer) {
        clearTimeout(timer.handle);
      }
      active.timers.splice(index, 1);
    }
  }

  private clearTimers(active: ActiveRun): void {
    for (const timer of active.timers) {
      if ("handle" in timer) {
        clearTimeout(timer.handle);
      } else {
        clearTimeout(timer);
      }
    }
    active.timers = [];
  }

  private cleanup(runId: SubagentRunId): void {
    const active = this.active.get(runId);
    if (active === undefined) {
      return;
    }
    this.clearTimers(active);
    active.session = null;
    // 释放 Lease（仅持有者；终态事务已清 Lease，这里幂等兜底）
    try {
      this.deps.runs.releaseLease({ runId, bootId: this.deps.bootId, holderId: "subagent-host", now: new Date(this.now()).toISOString() }, active.ownership);
    } catch {
      // 终态后释放失败不阻断（启动恢复兜底）
    }
    // T9b（§18.3）：释放工作区写 Lease（write Run 持有；崩溃后 TTL 兜底）
    if (active.workspaceLease !== null && this.deps.workspaceLeases !== undefined) {
      try {
        this.deps.workspaceLeases.release(active.workspaceLease.canonicalWorkspace, runId, this.deps.bootId);
      } catch {
        // 释放失败不阻断（TTL 兜底）
      }
    }
    this.active.delete(runId);
    this.deps.onRunFinished?.({ runId, threadId: active.threadId });
  }

  private newMessageId(): AgentMessageId {
    return `${SUBAGENT_MESSAGE_ID_PREFIX}${cryptoRandomSuffix()}` as AgentMessageId;
  }

  private newMailboxId(): ParentMailboxId {
    return `${SUBAGENT_MAILBOX_ID_PREFIX}${cryptoRandomSuffix()}` as ParentMailboxId;
  }
}

interface ActiveRun {
  readonly runId: SubagentRunId;
  readonly threadId: SubagentThreadId;
  readonly ownership: SubagentOwnership;
  readonly limits: SubagentRunLimitsV1;
  phase: string;
  toolCallCount: number;
  iterationCount: number;
  inputTokens: number;
  outputTokens: number;
  lastActivityAt: number;
  waitingForInput: boolean;
  resultReported: boolean;
  resultReminderSent: boolean;
  leaseLost: boolean;
  terminalHandled: boolean;
  /** T9b（§18.3）：write Run 持有的工作区写 Lease（read Run 为 null） */
  workspaceLease: { readonly canonicalWorkspace: string } | null;
  timers: Array<NodeJS.Timeout | { readonly kind: "idle" | "firstEvent"; handle: NodeJS.Timeout }>;
  abort: () => void;
  /** 会话引用（resumeFromInput 经端口投递回答；清理时置空） */
  session: { followUp(message: string): void; steer(message: string): void } | null;
}

function cryptoRandomSuffix(): string {
  const crypto = globalThis.crypto as { randomUUID?: () => string };
  const uuid = crypto.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return uuid.replaceAll("-", "").slice(0, 16);
}

/**
 * T9b（§18.3）：从 EffectiveSnapshot 序列化中读取 workspaceAccess。
 * 解析失败/非 "write" → "read"（fail-closed：不获取 Lease 也绝不让 read Run 写）。
 */
function workspaceAccessOf(snapshotJson: string): "read" | "write" {
  try {
    const snapshot = JSON.parse(snapshotJson) as { workspaceAccess?: unknown };
    return snapshot.workspaceAccess === "write" ? "write" : "read";
  } catch {
    return "read";
  }
}
