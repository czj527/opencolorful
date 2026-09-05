import crypto from "node:crypto";
import path from "node:path";

import type { AgentSettingsV2 } from "../contracts/agent-settings.js";
import type { PlatformEventEnvelope, PlatformEventType } from "../contracts/events.js";
import type { SessionBranchesChangedReason } from "../contracts/session-branch.js";
import { SessionBranchError } from "../contracts/session-branch.js";
import {
  branchTo,
  branchToRoot,
  createPiAgentSession,
  createPiFauxAgentSession,
  getBranchEntries,
  getLeafEntryId,
  getSessionTree,
  resolveEntry,
  type PiAgentEvent,
  type PiAgentSessionHandle,
  type PiFauxAgentOptions,
  type PiResourceSkills,
  type PiSessionHandle,
  type PiSessionTreeNode,
  type PiSessionTreeEntry,
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
  /**
   * 波次 B2（B0 §3.2.3 冻结持久化规则）：分支头写入端口（per-runtime 覆盖，
   * 测试内联注入用）。缺省回退模块级 registry（registerBranchHeadWriter，
   * SessionService 注册），组合根无需改动。
   */
  readonly refreshHead?: (sessionId: string, entryId: string | null) => void;
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
   * Phase 14 T6：Subagent 生命周期 hook（组合根/消息路由接线）——
   * onTurnBegin 更新工具上下文 turnId 槽；onUserPrompt / onTurnEnd /
   * onAbort 供 ParentSessionPort 的用户抢占/安全边界事件（§14.2）。缺省不调用。
   */
  readonly subagentLifecycle?: {
    onTurnBegin(turnId: string): void;
    onUserPrompt(): void;
    onTurnEnd(): void;
    onAbort(): void;
  };
  /**
   * T11（P0-2）：read 工具 Skill 文件受控读取端口（闭包引用
   * SkillCoreService.readSkillFileForSession）。注入后传给沙箱扩展上下文。
   */
  readonly skillRead?: (input: { readonly absPath: string }) => Promise<SkillFileReadOutcome>;
  /**
   * T9b（Phase 14 §18.3）：父 Agent 写 Tool 的工作区写 Lease 守卫（组合根
   * 按 WorkspaceMutationLeaseService 构造）。注入后传给沙箱扩展上下文，
   * write/edit/bash 执行入口检查/获取 operation-scoped short permit，
   * Subagent write Run 独占占用中 fail-closed 拒绝。
   */
  readonly workspaceLeaseGuard?: (input: {
    readonly toolName: "write" | "edit" | "bash";
    readonly absPath?: string;
  }) => { readonly allowed: boolean; readonly reason?: string; readonly release?: () => void };
  /** dispose 时的清理回调（如注销记忆工具上下文） */
  readonly onDispose?: () => void;
}

export interface PromptRun {
  readonly streamId: string;
  readonly completed: Promise<void>;
}

/** 波次 B2：regenerate 结果。branchId = 新用户条目 id（该分支的 turn root）。 */
export interface RegenerateRun {
  readonly streamId: string;
  readonly branchId: string;
  readonly completed: Promise<void>;
}

/**
 * 波次 B2（B0 §3.2.3 冻结持久化规则）：分支头写入端口注册表。
 *
 * Runtime 在每次用户条目 append 落地 / switchBranch / turn 收尾时写入分支头
 * （= 当前叶子）。写入器由 SessionService（持有 SQLite SessionIndex）注册，
 * Runtime 自身不依赖存储层；按 sessionId 键控，dispose 注销。per-runtime
 * 的 options.refreshHead 优先（测试内联注入用），未注入时查注册表。
 */
const branchHeadWriters = new Map<string, (sessionId: string, entryId: string | null) => void>();

export function registerBranchHeadWriter(
  sessionId: string,
  write: (sessionId: string, entryId: string | null) => void,
): void {
  branchHeadWriters.set(sessionId, write);
}

export function unregisterBranchHeadWriter(sessionId: string): void {
  branchHeadWriters.delete(sessionId);
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
  /** 当前 prompt 已提交的 instrumentation 终态，防止晚到 PI 事件重复收尾。 */
  private turnTerminalStatus: "completed" | "failed" | "cancelled" | "interrupted" | undefined;
  /** 当前进行中的模型调用（同一会话串行，同时只有一个） */
  private activeModelCall: LifecycleHandle | undefined;
  private modelCallSeq = 0;
  /** toolCallId → toolName（tool_end 事件不含 toolName，需要从 tool_start 记账） */
  private readonly toolNames = new Map<string, string>();
  /** 会话级插件工具（P0-1/P0-2：注入 PI 注册表；每 turn 冻结快照） */
  private readonly pluginTools: readonly PluginSessionTool[];
  private readonly snapshotFactory: SessionRuntimeOptions["snapshotFactory"];
  /** 波次 B2：分支头持久化端口（未注入时回退模块级 registry，见下） */
  private readonly refreshHead: ((sessionId: string, entryId: string | null) => void) | undefined;
  /** T11：Skill 元数据槽（beginTurn 每 turn 冻结写入；PI loader 每 turn 读取） */
  private readonly skillsSlotRef: { current: PiResourceSkills };
  private readonly skillSnapshotFactory: SessionRuntimeOptions["skillSnapshotFactory"];
  /** 波次 B2：会话句柄（树原语经 src/pi-sdk 受控适配器使用；分支操作必需） */
  private readonly sessionHandle: PiSessionHandle | undefined;
  /** Phase 14 T6：Subagent 生命周期 hook（turnId 槽/用户抢占/安全边界） */
  private readonly subagentLifecycle: SessionRuntimeOptions["subagentLifecycle"];
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
    this.refreshHead = options.refreshHead;
    this.sessionHandle = options.sessionHandle;
    this.skillSnapshotFactory = options.skillSnapshotFactory;
    this.subagentLifecycle = options.subagentLifecycle;
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
    // T9b（§18.3）：沙箱上下文外部端口（skillRead + workspaceLeaseGuard 合并注入）
    const sandboxContextOverrides =
      options.skillRead !== undefined || options.workspaceLeaseGuard !== undefined
        ? {
            ...(options.skillRead !== undefined ? { skillRead: options.skillRead } : {}),
            ...(options.workspaceLeaseGuard !== undefined ? { workspaceLeaseGuard: options.workspaceLeaseGuard } : {}),
          }
        : undefined;

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
        ...(sandboxService || options.skillRead !== undefined || options.workspaceLeaseGuard !== undefined ? { toolPolicy } : {}),
        ...(options.extraTools ? { extraTools: options.extraTools } : {}),
        // T11：PI Skill pointer——内部槽（beginTurn 每 turn 冻结；loader 每 turn 读取）
        ...(options.skillSnapshotFactory !== undefined ? { skills: () => skillsSlotRef.current } : {}),
        // T11（P0-2）+ T9b（§18.3）：沙箱扩展上下文外部端口
        ...(sandboxContextOverrides !== undefined ? { sandboxContext: sandboxContextOverrides } : {}),
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
        ...(sandboxService || options.skillRead !== undefined || options.workspaceLeaseGuard !== undefined ? { toolPolicy } : {}),
        // T11：PI Skill pointer——内部槽（beginTurn 每 turn 冻结；loader 每 turn 读取）
        ...(options.skillSnapshotFactory !== undefined ? { skills: () => skillsSlotRef.current } : {}),
        // T11（P0-2）+ T9b（§18.3）：沙箱扩展上下文外部端口
        ...(sandboxContextOverrides !== undefined ? { sandboxContext: sandboxContextOverrides } : {}),
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
    // Phase 14 T6：Subagent 工具上下文 turnId 槽更新（§20.2 工具上下文盖章）
    try {
      this.subagentLifecycle?.onTurnBegin(turnId);
    } catch {
      // best-effort：hook 失败不阻断 turn
    }
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
        // T13（P0-1）：冻结失败必须 fail-closed——清空上一轮遗留的 Skill 只读根，
        // 否则 PathGuard 动态规则残留会让 read 回退原始读取继续访问已失效权限
        if (this.sandboxService !== null) {
          this.sandboxService.setReadOnlyRoots([], "skill-root-read");
        }
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
    return this.startTurn(text, false);
  }

  /**
   * 波次 B2：regenerate（edit-and-retry 统一原语，B0 §3.2.1）。
   * 与 prompt 共享同一个单飞 ExecutionRegistry 与同一条内部 runTurn 路径
   * （turn 事件、streamId、abort、终态分类、观测账目完全一致）。
   *
   * 定位 turn 的用户条目：target 本身是 user message → 即 turn root；否则沿
   * parentId 链向根走，取最近的 user-message 祖先；找不到 → INVALID_INPUT。
   * 之后把叶子移到用户条目的父（根用户条目 → branchToRoot），append 新文本
   * 走 prompt 完全同一条路径，形成同父的新兄弟分支。
   *
   * branchId = 新用户条目 id：PI 在 turn 内部 append 用户消息后才产生 id，
   * 这里等待第一个 user message_end 落地后返回（turn 继续在后台执行，
   * completed 仍由 ExecutionRegistry 跟踪）。turn 启动即失败（未 append 用户
   * 条目，如模型鉴权失败）时抛错，失败终态已照常投影到会话流。
   */
  async regenerate(targetEntryId: string, text: string): Promise<RegenerateRun> {
    if (!text.trim()) {
      throw new SessionBranchError("invalid_input", "重生成内容不能为空");
    }
    // 单飞前置检查：并发 prompt/regenerate 在叶子移动之前拒绝（不留下半移动状态）
    if (this.executions.activeStream(this.sessionId) !== undefined) {
      throw new SessionBranchError("busy", "会话正在运行，请先停止后再操作");
    }
    const handle = this.requireSessionHandle("重生成");
    const target = resolveEntry(handle, targetEntryId);
    if (target === undefined) {
      throw new SessionBranchError("not_found", "引用的会话节点不存在，请刷新后重试");
    }
    const userEntry = this.resolveTurnUserEntry(handle, target);
    // 定位叶子：用户条目 parentId === null → branchToRoot，否则移到其父条目。
    // branchTo 只是纯指针移动，下一次 append 即成为同父的新兄弟分支。
    if (userEntry.parentId === null) {
      branchToRoot(handle);
    } else {
      branchTo(handle, userEntry.parentId);
    }
    const run = this.startTurn(text, true);
    const branchId = await run.branchId;
    if (branchId === null) {
      throw new Error("重新生成未能启动（用户消息未落盘），请查看会话流中的失败原因");
    }
    return { streamId: run.streamId, branchId, completed: run.completed };
  }

  /** 解析 regenerate 的 turn 用户条目（目标自身或最近的 user-message 祖先）。 */
  private resolveTurnUserEntry(
    handle: PiSessionHandle,
    target: PiSessionTreeEntry,
  ): PiSessionTreeEntry {
    let current: PiSessionTreeEntry | undefined = target;
    while (current !== undefined) {
      if (current.type === "message" && current.role === "user") {
        return current;
      }
      current = current.parentId === null ? undefined : resolveEntry(handle, current.parentId);
    }
    throw new SessionBranchError("invalid_input", "只能从用户消息重新生成");
  }

  /**
   * 波次 B2：切换当前分支（B0 §3.2.3）。busy 时由调用方（路由层）先行 409，
   * 这里再拒绝一次重复保护；叶子指针移动 + 分支头持久化 + 两个会话流事件
   * （session.branch.switched / session.branches.changed），Replay Store 先写。
   */
  switchBranch(branchId: string): { branchId: string; currentBranchId: string } {
    if (this.executions.activeStream(this.sessionId) !== undefined) {
      throw new SessionBranchError("busy", "会话正在运行，请先停止后再操作");
    }
    const handle = this.requireSessionHandle("分支切换");
    const target = resolveEntry(handle, branchId);
    if (target === undefined) {
      throw new SessionBranchError("not_found", "引用的会话节点不存在，请刷新后重试");
    }
    branchTo(handle, branchId);
    this.persistBranchHead(branchId);
    // Replay Store 先写再广播（与既有事件同一条 emit 路径）
    this.emitSessionEvent("session.branch.switched", { branchId });
    this.emitSessionEvent("session.branches.changed", { reason: "switch" });
    return { branchId, currentBranchId: branchId };
  }

  /** 波次 B2：分支集合变化事件（regenerate 在 turn 启动时 / fork 在源会话流） */
  emitBranchesChanged(reason: SessionBranchesChangedReason): void {
    this.emitSessionEvent("session.branches.changed", { reason });
  }

  private emitSessionEvent(
    type: "session.branch.switched" | "session.branches.changed",
    payload: { branchId: string } | { reason: SessionBranchesChangedReason },
  ): void {
    // 分支事件直接挂在会话流之外独立成流（streamId 独立、sequence 从 1 开始），
    // 不占用进行中 prompt 的 streamId 序列；仍经 Replay Store 先写再广播。
    const streamId = `branch-${crypto.randomUUID()}`;
    const envelope: PlatformEventEnvelope = {
      protocolVersion: 1,
      eventId: crypto.randomUUID(),
      sessionId: this.sessionId,
      streamId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type,
      payload,
    } as PlatformEventEnvelope;
    this.emit(envelope);
  }

  private persistBranchHead(entryId: string | null): void {
    try {
      const write = this.refreshHead ?? branchHeadWriters.get(this.sessionId);
      write?.(this.sessionId, entryId);
    } catch {
      // 分支头持久化失败不阻断 turn（重启后回退 PI 默认叶子语义，可恢复）
    }
  }

  private requireSessionHandle(operation: string): PiSessionHandle {
    const handle = this.sessionHandle;
    if (handle === undefined) {
      throw new SessionBranchError("conflict", `会话 Runtime 未绑定持久会话，无法${operation}`);
    }
    return handle;
  }

  /**
   * prompt 与 regenerate 的公共入口：单飞检查 → stream/turn 观测装配 →
   * 统一的 runTurn 异步路径。isRegenerate 为 true 时额外广播
   * branches.changed{regenerate}，并暴露新用户条目 id 的就绪 promise。
   */
  private startTurn(text: string, isRegenerate: boolean): PromptRun & { readonly branchId: Promise<string | null> } {
    const controller = new AbortController();
    const started = this.executions.start(this.sessionId, controller);
    if (started.status !== "accepted") {
      // 波次 B2：与 prompt 共用同一单飞机制，并发 prompt/regenerate 一律
      // "already-running" → 路由层映射 409 SESSION_BUSY。
      throw new SessionBranchError("busy", "会话正在运行，请先停止后再操作");
    }

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
    this.turnTerminalStatus = undefined;
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

    try {
      this.subagentLifecycle?.onUserPrompt();
    } catch {
      // best-effort
    }
    // 波次 B2：regenerate 的分支创建（叶子移动后第一个 append）在 turn 启动时
    // 广播 branches.changed；prompt 不发。广播失败不影响 turn。
    if (isRegenerate) {
      try {
        this.emitBranchesChanged("regenerate");
      } catch {
        // best-effort
      }
    }
    // 波次 B2（B0 §3.2.3 冻结规则）：用户条目 append 落地即刷新分支头 = 新叶子
    // （崩溃恢复语义：重生成中途崩溃后重开应落在进行中的重生成分支）。
    // branchId = 新用户条目 id：PI 在 turn 内 append 时才产生 id，这里用
    // turn 前条目快照 diff 出本 turn 的新用户条目（不依赖 PI 内部事件与
    // SessionManager append 的先后次序，turn 快速完成时同样正确）。
    const preTurnEntryIds = collectEntryIds(this.sessionHandle);
    let branchIdResolve: (value: string | null) => void = () => {};
    const branchId = new Promise<string | null>((resolve) => {
      branchIdResolve = resolve;
    });
    void this.watchTurnUserEntry(preTurnEntryIds, branchIdResolve);
    return instrument.runWithTrace({ trace }, () => {
      void this.runTurn(text, started.streamId, mapper, controller);
      return { streamId: started.streamId, completed: started.completed, branchId };
    });
  }

  /**
   * 观察本 turn 的用户条目 append：当前分支路径上第一个不属于 turn 前快照的
   * user message 条目即新用户条目 → 持久化分支头；regenerate 场景下同时以
   * 其为 branchId。执行结束仍未观察到 → branchId 解析为 null。
   */
  private async watchTurnUserEntry(
    preTurnEntryIds: ReadonlySet<string>,
    resolveBranchId: (value: string | null) => void,
  ): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      const handle = this.sessionHandle;
      if (handle === undefined) {
        resolveBranchId(null);
        return;
      }
      const leaf = getLeafEntryId(handle);
      if (leaf !== null) {
        const branch = getBranchEntries(handle, leaf);
        const newUserEntry = branch.find(
          (entry) =>
            entry.type === "message" &&
            entry.role === "user" &&
            !preTurnEntryIds.has(entry.entryId),
        );
        if (newUserEntry !== undefined) {
          this.persistBranchHead(leaf);
          resolveBranchId(newUserEntry.entryId);
          return;
        }
      }
      // 执行已结束且路径上没有新用户条目 → 用户条目未落盘（turn 启动即失败）
      if (this.executions.activeStream(this.sessionId) === undefined) {
        resolveBranchId(null);
        return;
      }
    }
    resolveBranchId(null);
  }

  abort(streamId: string): AbortResult {
    try {
      this.subagentLifecycle?.onAbort();
    } catch {
      // best-effort
    }
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

  private async runTurn(
    text: string,
    streamId: string,
    mapper: PlatformEventMapper,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.agent.prompt(text);
      // PI 的模型调用失败不抛出：错误以 stopReason="error" 附在 assistant 消息上
      // （2026-09-01 A4 CHAT-06 真链发现）。不判定会把失败 turn 记成 completed 且 UI 无失败终态。
      const assistantError = mapper.lastAssistantError;
      if (controller.signal.aborted || mapper.isAssistantAborted) {
        this.emitTerminal(mapper, "turn.cancelled", { reason: "aborted" }, "cancelled", "aborted");
      } else if (assistantError !== undefined) {
        this.emitTerminal(mapper, "turn.failed", { errorMessage: assistantError }, "failed", assistantError);
      } else {
        this.settleTurn(mapper, "completed");
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.emitTerminal(mapper, "turn.cancelled", { reason: "aborted" }, "cancelled", "aborted");
      } else {
        const cause = error instanceof Error ? error.message : String(error);
        this.emitTerminal(
          mapper,
          "turn.failed",
          { errorMessage: mapProviderError(error).message },
          "failed",
          cause,
        );
      }
      const apiError = mapProviderError(error);
      this.emit(mapper.error(apiError.message, apiError.code, apiError.retryable));
    } finally {
      this.activeModelCall = undefined;
      this.turn = undefined;
      // 波次 B2：turn 结束后叶子可能已推进到最终 assistant 条目（工具循环多轮
      // append），把分支头刷新到当前叶子；用户条目落地时的首次刷新由
      // watchTurnUserEntry 完成。
      const handle = this.sessionHandle;
      if (handle !== undefined) {
        const finalLeaf = getLeafEntryId(handle);
        if (finalLeaf !== null) this.persistBranchHead(finalLeaf);
      }
      this.emit(mapper.sessionStatus("idle"));
      this.executions.finish(this.sessionId, streamId);
      if (this.mapper === mapper) this.mapper = undefined;
      try {
        this.subagentLifecycle?.onTurnEnd();
      } catch {
        // best-effort
      }
    }
  }

  /**
   * 提交平台终态并同步 instrumentation。Mapper 可能已在 turn_end 接受
   * turn.completed，也可能因为失败/取消已接受其他终态；两条路径都只允许
   * 第一次终态关闭当前 prompt 的 lifecycle。
   */
  private emitTerminal(
    mapper: PlatformEventMapper,
    type: "turn.failed" | "turn.cancelled" | "turn.interrupted",
    payload: Record<string, unknown>,
    requestedStatus: "failed" | "cancelled" | "interrupted",
    reason: Error | string,
  ): void {
    const event = mapper.terminal(type, payload);
    this.settleTurn(mapper, requestedStatus, reason);
    if (event !== undefined) this.emit(event);
  }

  private settleTurn(
    mapper: PlatformEventMapper,
    requestedStatus: "completed" | "failed" | "cancelled" | "interrupted",
    reason?: Error | string,
  ): void {
    if (this.turnTerminalStatus !== undefined) return;

    const mappedStatus = mapper.terminalType;
    const status = mappedStatus === "turn.completed"
      ? "completed"
      : mappedStatus === "turn.failed"
        ? "failed"
        : mappedStatus === "turn.cancelled"
          ? "cancelled"
          : mappedStatus === "turn.interrupted"
            ? "interrupted"
            : requestedStatus;
    this.turnTerminalStatus = status;

    if (status === "completed") {
      this.turn?.complete();
    } else if (status === "failed") {
      this.turn?.fail(reason ?? "turn failed");
    } else if (status === "cancelled") {
      this.turn?.cancel(typeof reason === "string" ? reason : reason?.message ?? "cancelled");
    } else {
      this.turn?.interrupt(typeof reason === "string" ? reason : reason?.message ?? "interrupted");
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

/** turn 前条目快照：当前分支全部条目 id（含历史分支共享前缀部分）。 */
function collectEntryIds(handle: PiSessionHandle | undefined): ReadonlySet<string> {
  if (handle === undefined) return new Set<string>();
  const ids = new Set<string>();
  try {
    const leaf = getLeafEntryId(handle);
    if (leaf !== null) {
      for (const entry of getBranchEntries(handle, leaf)) ids.add(entry.entryId);
    }
  } catch {
    // 快照失败按空集合处理（diff 会把全部条目视为新条目，watcher 取首个用户条目）
  }
  return ids;
}
