import { AsyncLocalStorage } from "node:async_hooks";

import type { AuditAcceptResult, AuditRecordInput } from "../observability/audit-recorder.js";
import type { ParentMailboxDeliveryCoordinator } from "../runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.js";
import type { ProtocolDispatcher } from "../runtime/subagents/protocol/protocol-dispatcher.js";
import type { SubagentStartupRecovery } from "../runtime/subagents/recovery/startup-recovery.js";
import type { SubagentRuntimeHost } from "../runtime/subagents/runtime/runtime-host.js";
import type { SubagentScheduler } from "../runtime/subagents/runtime/scheduler.js";
import type { SubagentSessionToolDef, SubagentToolInvokeResult } from "../runtime/subagents/runtime/types.js";
import type { ParentPluginContributionEntry, ParentSkillEntry } from "../runtime/subagents/delegation-policy.js";
import type {
  ArtifactStore,
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
  WorkspaceLeaseStore,
} from "../runtime/subagents/stores/index.js";
import type { SubagentObservabilityProjector } from "../runtime/subagents/observability/subagent-observability-projector.js";
import type { SubagentArtifactFileService } from "../runtime/subagents/transcript/artifact-files.js";
import type { SubagentReplayStore } from "../runtime/subagents/transcript/replay-store.js";
import type { SubagentTranscriptView } from "../runtime/subagents/transcript/transcript-view.js";
import type { SubagentToolActivityTracker } from "../runtime/subagents/transcript/tool-summary.js";
import type { SubagentDefaultModel } from "../contracts/subagents.js";
import type { ResourceRef, TraceContext } from "../contracts/observability.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T6：主 Agent 七个 Core 工具的 per-Session 上下文
// （plans/phase-14.md §20.2：工具上下文必须有 ownerAgentId/sessionId/
// turnId/trace；注册边界=只普通主 Agent Session）
//
// 模式与 memory-tools/skill-tools 一致：全局 Symbol 状态表 +
// AsyncLocalStorage；生产执行按 sessionId 精确匹配并 fail-closed
// （未注册的 Session 调用工具直接拒绝，不静默 no-op）。
//
// turnIdSlot：SessionRuntime.beginTurn 每 turn 写入（T6c 接线）；
// traceSlot：工具调用时由 wrapper 写入当前 TraceContext；
// parentSnapshot：spawn 时父 Agent 当前有效工具/插件/Skill 快照
// （§12.1 EffectiveSnapshot 输入）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentToolServices {
  /** 当前 Subagent 偏好（defaultModel 等；§10.1） */
  readonly preferences: () => { readonly subagents: { readonly defaultModel: SubagentDefaultModel | null } | undefined };
  /** 主 Agent 当前模型（parent_inherited 来源；§10.2） */
  readonly currentModel: () => { readonly providerId: string; readonly modelId: string } | null;
  /** 父 Agent 当前有效能力快照（§12.1 EffectiveSnapshot 输入） */
  readonly parentSnapshot: () => { readonly toolIds: readonly string[]; readonly pluginContributions: readonly ParentPluginContributionEntry[]; readonly skillEntries: readonly ParentSkillEntry[] };
  /** 模型可用性判定（ModelService.resolveModel try/catch 适配） */
  readonly modelResolver: (providerId: string, modelId: string) => boolean;
  /** 父侧工具目录（EffectiveSnapshot.toolIds → 工具定义；未收录 → null） */
  readonly toolCatalog: (name: string) => SubagentSessionToolDef | null;
  /**
   * 能力工具执行器工厂（复审 P0-2/P0-3）：为每个 Run 构建 run-scoped 执行
   * 器——spawn 时冻结插件执行快照（version/runtimeInstanceId/grantRevision
   * 真实值）与 Skill 可见集，执行闭包只消费该冻结状态（当前 Run 不漂移）；
   * 同时校验快照 toolIds 全部可解析、插件快照全部冻结成功，任何缺失 →
   * { ok: false }（spawn fail-closed，不允许静默缩减快照）。
   */
  readonly createRunToolExecutor: (input: {
    readonly runId: string;
    readonly snapshot: import("../runtime/subagents/delegation-policy.js").EffectiveSnapshot;
    readonly spawnTurnId: string | null;
  }) => { readonly ok: true; readonly executor: (input: { readonly name: string; readonly args: unknown; readonly signal?: AbortSignal }) => Promise<SubagentToolInvokeResult> } | { readonly ok: false; readonly reason: string };
  /** 主会话工作区目录（Thread.workspaceCwd 冻结源） */
  readonly workspaceCwd: () => string;
  /** Thread 目录解析：<subagentsBase>/<owner>/subagents/<threadId>（§16.3） */
  readonly threadDirResolver: (input: { readonly threadId: string; readonly ownerAgentId: string }) => string;
  readonly threads: ThreadStore;
  readonly runs: RunStore;
  readonly messages: MessageStore;
  readonly artifacts: ArtifactStore;
  readonly mailbox: ParentMailboxStore;
  readonly leases: WorkspaceLeaseStore;
  readonly transactions: SubagentTransactions;
  readonly dispatcher: ProtocolDispatcher;
  readonly coordinator: ParentMailboxDeliveryCoordinator;
  readonly scheduler: SubagentScheduler;
  readonly host: SubagentRuntimeHost;
  readonly transcriptView: SubagentTranscriptView;
  readonly artifactFiles: SubagentArtifactFileService;
  readonly replay: SubagentReplayStore;
  readonly toolTracker: SubagentToolActivityTracker;
  readonly projector: SubagentObservabilityProjector;
  /** 严格审计（§22.5：Thread 创建/能力委派必须 durable；rejected → 回滚拒绝） */
  readonly audit: (input: AuditRecordInput) => AuditAcceptResult;
  /** 工具可用性（启动恢复完成后才置 true；§16.5 fail-closed） */
  readonly available: () => boolean;
  readonly now: () => number;
  /** 生成稳定 ID（thread/run/message/artifact/mailbox/snapshot 前缀） */
  readonly newId: (prefix: "sat_" | "sar_" | "sam_" | "saa_" | "smb_" | "sas_") => string;
}

export interface SubagentToolContext {
  readonly ownerAgentId: string;
  readonly sessionId: string;
  /** turnId 槽：SessionRuntime.beginTurn 每 turn 更新（T6c 接线） */
  readonly turnIdSlot: { current: string | undefined };
  /** trace 槽：工具调用时由 wrapper 写入（T6c 接线） */
  readonly traceSlot: { current: TraceContext | undefined };
  readonly services: SubagentToolServices;
}

export interface SubagentToolContextState {
  readonly storage: AsyncLocalStorage<SubagentToolContext>;
  readonly sessionContexts: Map<string, SubagentToolContext>;
  /** run-scoped 能力工具执行器注册表（跨模块加载器边界共享，见 abilityExecutors） */
  readonly abilityExecutors: Map<string, SubagentRunAbilityExecutor>;
}

const STATE_KEY = Symbol.for("opencolorful.subagent-tool-context-state");
const globalState = globalThis as typeof globalThis & Record<symbol, unknown>;
let state = globalState[STATE_KEY] as SubagentToolContextState | undefined;
if (!state) {
  state = {
    storage: new AsyncLocalStorage<SubagentToolContext>(),
    sessionContexts: new Map<string, SubagentToolContext>(),
    abilityExecutors: new Map<string, SubagentRunAbilityExecutor>(),
  };
  globalState[STATE_KEY] = state;
}

// 兼容旧全局状态（由未带 abilityExecutors 的早期版本创建）：补齐字段
if (state.abilityExecutors === undefined) {
  (state as { abilityExecutors: Map<string, SubagentRunAbilityExecutor> }).abilityExecutors = new Map<string, SubagentRunAbilityExecutor>();
}

const storage = state.storage;
const sessionContexts = state.sessionContexts;
const abilityExecutors = state.abilityExecutors;

/** 在直接调用/测试的异步上下文中注入 Subagent 工具上下文 */
export function runWithSubagentContext<T>(ctx: SubagentToolContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

// ── 能力工具执行器注册表（T9a §25.4 / 复审 P0-2 / #14）──────────────────
//
// 能力工具的目录（toolCatalog）与执行（createRunToolExecutor）都是 per-Session
// 的（插件绑定/授权随父会话变化）；SubagentSessionFactory 在组合根构造，拿
// 不到 per-Session 插件工具。spawn/steer 工具在提交 Run 时把本 Session 构建的
// run-scoped 执行器（已绑定 spawn 冻结快照）按 runId 注册到这里；
// pi-session-adapter 的缺省 abilityExecutor 按 runId 查询执行。Run 终态/清理
// 由注册表按 runId 惰性清理（上限保护）。
//
// 注册表锚定在 globalThis[Symbol.for("opencolorful.subagent-tool-context-state")]
// 上（与 state/sessionContexts 同锚点），解决 jiti 加载的 PI 扩展与 tsx 原生加载
// 的组合根跨模块加载器边界时各有一份 Map 的问题。

/** run-scoped 能力工具执行器（spawn 冻结快照绑定后的执行闭包） */
export type SubagentRunAbilityExecutor = (input: {
  readonly name: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
}) => Promise<SubagentToolInvokeResult>;

const MAX_ABILITY_EXECUTOR_ENTRIES = 256;

/** 注册能力工具执行器（spawn/steer 提交 Run 时调用；同 runId 覆盖） */
export function registerSubagentAbilityExecutor(
  runId: string,
  executor: SubagentRunAbilityExecutor,
): void {
  if (abilityExecutors.size >= MAX_ABILITY_EXECUTOR_ENTRIES && !abilityExecutors.has(runId)) {
    // 有界：超出后清理最早注册的 32 条（防泄漏）
    const keys = [...abilityExecutors.keys()];
    for (const key of keys.slice(0, 32)) {
      abilityExecutors.delete(key);
    }
  }
  abilityExecutors.set(runId, executor);
}

/** 按 runId 查询（pi-session-adapter 缺省 abilityExecutor） */
export function getSubagentAbilityExecutor(runId: string): SubagentRunAbilityExecutor | undefined {
  return abilityExecutors.get(runId);
}

/**
 * 将生产主 Session 与其 Subagent 工具上下文绑定（T6c messages 路由
 * ensureRuntime 调用；仅普通主 Agent Session）。清理函数只删除同一份
 * 上下文，避免旧 Runtime dispose 时误删已重建的新 Runtime。
 */
export function registerSubagentContext(
  sessionId: string,
  ctx: SubagentToolContext,
): () => void {
  sessionContexts.set(sessionId, ctx);
  return () => {
    if (sessionContexts.get(sessionId) === ctx) {
      sessionContexts.delete(sessionId);
    }
  };
}

export function unregisterSubagentContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
}

/** 获取当前 Subagent 工具上下文。生产执行按 sessionId 精确匹配并 fail-closed。 */
export function requireSubagentContext(executionContext?: {
  readonly sessionManager: { getSessionId(): string };
}): SubagentToolContext {
  if (executionContext !== undefined) {
    const sessionId = executionContext.sessionManager.getSessionId();
    const registered = sessionContexts.get(sessionId);
    if (registered === undefined) {
      throw new Error("Subagent 工具上下文未就绪，工具调用被阻止");
    }
    return registered;
  }
  const ctx = storage.getStore();
  if (ctx === undefined) {
    throw new Error("Subagent 工具上下文未就绪，工具调用被阻止");
  }
  return ctx;
}

/** 工具上下文里拿当前 turn 的归属 ResourceRef（审计 target 用） */
export function subagentThreadResource(threadId: string): ResourceRef {
  return { kind: "subagent_thread", id: threadId };
}
