// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：父 Session 端口（plans/phase-14.md §14 / §16.5 / §T5 交付 2）
//
// ParentMailboxDeliveryCoordinator 通过 ParentSessionPort 与主 Agent 会话
// 解耦（不依赖 PI SDK；PI import 边界：只有 src/pi-sdk/ 可 import
// @earendil-works/pi-*）：
//
// - getStatus：父 Session"空闲且可运行"判定输入（无 in-flight prompt/steer、
//   无未消费 abort、未归档/删除；§T5 交付 2）；
// - startContinuation：触发一次 platform-initiated parent turn（复用现有
//   SessionRuntime 注入路径，不新建平行调度器）。同一 Session 至多一个并发
//   continuation 由协调器（in-flight 记账）+ 端口（内部 guard）双重保证；
// - 用户消息优先：T6 在用户消息注入（SessionRuntime.prompt）前调用
//   noteUserMessage()——端口中止 in-flight continuation（不插队），
//   用户消息赢得 prompt 槽；
// - 终态语义：triggered = Turn 已触发并正常结束；interrupted = Turn 已触发
//   但被用户打断（同一 Mailbox 项只触发一次父 Turn，不重复触发）；
//   rejected = 未触发（可退避重试）；
// - subscribe：用户打断 / 任意 Turn 结束（安全输入边界）事件，协调器据此
//   结算 in-flight 投递与排队重检。
// ═══════════════════════════════════════════════════════════════

export type ParentSessionStatus = "idle" | "busy" | "archived" | "deleted" | "unknown";

export type ParentContinuationOutcome =
  /** Turn 已触发并正常结束 */
  | { readonly status: "triggered" }
  /** Turn 已触发但被用户打断（终态语义：不再重复触发同一 Mailbox 项） */
  | { readonly status: "interrupted" }
  /** 未触发（父 Session 忙/abort pending/无 runtime）；可退避重试 */
  | { readonly status: "rejected"; readonly reasonCode: string };

export interface ParentContinuationInput {
  /** continuation 输入只含 §14.2 摘要（threadId/runId/type/disposition/短摘要/提示） */
  readonly text: string;
  /** 去重 operationId（协调器生成） */
  readonly operationId: string;
}

export interface ParentSessionPortEvents {
  /** 用户打断（stop 或新消息抢占 continuation）；协调器结算 in-flight */
  readonly onUserInterrupt: () => void;
  /** 任意 Turn 结束（下一个安全输入边界；协调器重检排队投递） */
  readonly onTurnEnd: () => void;
}

export interface ParentSessionPort {
  readonly sessionId: string;
  readonly ownerAgentId: string;
  getStatus(): ParentSessionStatus;
  startContinuation(input: ParentContinuationInput): Promise<ParentContinuationOutcome>;
  /** 用户新消息即将注入（T6 消息路由在 prompt 前调用；用户优先） */
  noteUserMessage(): void;
  /** 用户 Turn 结束（T6 在用户 prompt completed 后调用；安全输入边界） */
  noteUserTurnEnd(): void;
  /** 用户中断（stop；未消费 abort 期间不自动 continuation） */
  noteUserAbort(): void;
  subscribe(events: ParentSessionPortEvents): () => void;
}
