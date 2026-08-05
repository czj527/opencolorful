import type { Hono } from "hono";
import * as path from "node:path";

import type { RuntimePaths } from "../../config/paths.js";
import type { AgentStore } from "../../config/agent-store.js";
import { createApiError, type ApiError } from "../../contracts/api-error.js";
import type { ToolMode } from "../../contracts/session-settings.js";
import { defaultMemoryAgentSettings, type MemoryAgentSettings } from "../../contracts/memory.js";
import type { EventReplayStore } from "../../runtime/event-replay-store.js";
import type { ModelService } from "../../runtime/model-service.js";
import type { PromptService } from "../../runtime/prompt-service.js";
import type { SessionService } from "../../runtime/session-service.js";
import { SessionRuntime, type SessionRuntimeOptions } from "../../runtime/session-runtime.js";
import { ToolPolicy } from "../../runtime/tool-policy.js";
import { buildMemoryInjectionBlock } from "../../runtime/memory/memory-injection.js";
import { MemoryRecallService } from "../../runtime/memory/recall-service.js";
import { MemoryFactStore } from "../../storage/memory/fact-store.js";
import { MemoryEventStore } from "../../storage/memory/event-store.js";
import { MemoryRecallStore } from "../../storage/memory/recall-store.js";
import { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import { PinnedMemoryStore } from "../../storage/memory/pinned-store.js";
import { SessionIndex } from "../../storage/session-index.js";
import { registerMemoryContext } from "../../pi-sdk/memory-tools.js";
import { MEMORY_TOOL_NAMES } from "../../pi-sdk/agent-session.js";
import type { PluginSessionTool } from "../../pi-sdk/index.js";
import type { PluginFacade } from "../../platform/plugin-facade.js";
import type Database from "better-sqlite3";


/**
 * Phase 12 P0-1/P0-2/P1-2 生产接线（模块级导出供测试直接复用，不复制逻辑）：
 * 按 Agent 绑定解析插件工具（注入主会话 PI 工具注册表）。
 * - 仅注入 enabled 绑定；工具贡献需插件已激活（ToolService.listTools 只列已登记工具）；
 * - 绑定指定了 contributions 时按 id 过滤，否则取该插件全部工具；
 * - P0-2 turn 快照槽：SessionRuntime 每 turn 冻结写入 turnContext.current，
 *   invoke 读取后传给 ToolService（in-flight 以冻结态为准）；
 * - P1-2：冻结失败 fail-closed（invoke 拒绝执行，不降级实时权限）；
 * - 插件系统异常时降级为空（不阻塞会话创建）。
 */
export function buildPluginSessionTools(
  facade: PluginFacade,
  agentId: string,
  sessionId: string,
): readonly PluginSessionTool[] {
  try {
    const bindings = facade.listAgentBindings(agentId).filter((binding) => binding.enabled);
    if (bindings.length === 0) {
      return [];
    }
    const bound = new Map<string, readonly string[] | undefined>();
    for (const binding of bindings) {
      bound.set(binding.pluginId, binding.contributions.length > 0 ? binding.contributions : undefined);
    }
    return facade.hostApi.tools
      .listTools()
      .filter((tool) => {
        // P0-2：未绑定插件的工具绝不注入（bound.get 对未绑定插件也返回 undefined，
        // 必须用 has 区分"未绑定"与"绑定但允许全部贡献"）
        if (!bound.has(tool.pluginId)) {
          return false;
        }
        const allowed = bound.get(tool.pluginId);
        return allowed === undefined || allowed.includes(tool.contributionId);
      })
      .map((descriptor) => {
        // P0-2 turn 快照槽：SessionRuntime 每 turn 开始冻结该插件的授权/绑定状态
        const turnContext: { current: import("../../pi-sdk/index.js").PluginToolTurnContext | undefined } = { current: undefined };
        return {
          qualifiedName: descriptor.qualifiedName,
          pluginId: descriptor.pluginId,
          name: descriptor.name,
          ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
          ...(descriptor.inputSchema !== undefined ? { inputSchema: descriptor.inputSchema } : {}),
          turnContext,
          invoke: async (params: unknown, signal?: AbortSignal) => {
            const frozen = turnContext.current;
            // P1-2：冻结失败 fail-closed——本 turn 该插件工具禁用，不执行、不降级实时权限
            if (frozen?.error !== undefined) {
              return {
                ok: false as const,
                code: "snapshot-error",
                message: `插件 ${descriptor.pluginId} 快照冻结失败，本 turn 工具已禁用：${frozen.error}`,
              };
            }
            const result = await facade.hostApi.tools.invoke({
              pluginId: descriptor.pluginId,
              contributionId: descriptor.contributionId,
              params,
              agentId,
              sessionId,
              ...(frozen?.snapshot !== undefined ? { snapshot: frozen.snapshot as import("../../contracts/plugin-protocol.js").PluginExecutionSnapshot } : {}),
              ...(frozen?.state !== undefined ? { state: frozen.state as import("../../runtime/plugins/grants/execution-snapshot.js").ResolveState } : {}),
              ...(signal !== undefined ? { signal } : {}),
            });
            return result.ok
              ? { ok: true as const, result: result.result }
              : { ok: false as const, code: result.code, message: result.message };
          },
        };
      });
  } catch {
    return [];
  }
}

/**
 * P0-2 turn 快照工厂（模块级导出供测试直接复用，不复制逻辑）：每 turn 开始
 * 冻结绑定插件的授权/绑定状态（ExecutionSnapshotService.create），in-flight
 * 工具调用以冻结态为准。P1-2：冻结失败返回 { error }（invoke 侧 fail-closed），
 * 绝不吞成 undefined 走实时权限——权限边界不容许静默 fail-open。
 */
export function buildPluginTurnSnapshotFactory(
  facade: PluginFacade,
): NonNullable<SessionRuntimeOptions["snapshotFactory"]> {
  return (pluginId: string, agentId: string) => {
    try {
      const active = facade.get(pluginId);
      if (active === undefined) {
        return undefined;
      }
      const instance = facade.runtimeHost.getInstance(pluginId);
      if (instance === undefined) {
        return undefined;
      }
      return facade.snapshots.create({
        pluginId,
        pluginVersion: active.version,
        runtimeKind: instance.kind,
        runtimeInstanceId: instance.runtimeInstanceId,
        agentId,
      });
    } catch (error) {
      return {
        snapshot: undefined,
        state: undefined,
        error: error instanceof Error ? error.message.slice(0, 400) : `插件 ${pluginId} 快照冻结失败`,
      };
    }
  };
}

export interface MessageRoutesOptions {
  readonly promptService: PromptService;
  readonly sessionService?: SessionService;
  readonly replayStore?: EventReplayStore;
  readonly paths?: RuntimePaths;
  readonly modelService?: ModelService;
  readonly agentStore?: AgentStore;
  readonly database?: Database.Database;
  /**
   * 记忆设置解析（评审 P1#7b：injectBudgetChars 必须接真实设置）。
   * 与 start.ts resolveMemorySettings 同一优先级：per-Agent 覆盖 → 全局默认 → 平台默认。
   * 未提供时按平台默认（buildMemoryInjectionBlock 的默认预算）。
   */
  readonly memorySettingsResolver?: (agentId: string) => MemoryAgentSettings;
  /** Phase 12：插件组合根（绑定 Agent 的插件工具注入主会话） */
  readonly pluginFacade?: PluginFacade;
}

// ensureRuntime 的失败结果：路由层直接转成对应状态码
class EnsureRuntimeError extends Error {
  constructor(readonly apiError: ApiError, readonly status: 409 | 500) {
    super(apiError.message);
  }
}

export function registerMessageRoutes(app: Hono, options: MessageRoutesOptions): void {
  const { promptService, sessionService, replayStore, paths, modelService, agentStore, database } = options;

  // 跟踪每个 session 运行时使用的 systemPrompt（含记忆块 revision），用于检测 profile/memory 更新
  const runtimeSystemPrompt = new Map<string, string | undefined>();
  // P0-2：插件状态签名（绑定/授权修订/版本/运行实例），变化时重建 Runtime（下一 turn 生效）
  const pluginSignatures = new Map<string, string>();

  /**
   * P0-2：Agent 的插件状态签名——enabled 绑定的 pluginId、active 版本、状态、
   * grantRevision/bindingRevision、运行实例 id 与绑定贡献列表。任一变化都会
   * 使签名不同，触发 Runtime 重建（解绑/新绑定/授权变更/插件更新下一 turn 生效）。
   */
  function pluginSignature(agentId: string | undefined): string {
    const facade = options.pluginFacade;
    if (agentId === undefined || facade === undefined) {
      return "";
    }
    try {
      const bindings = facade.listAgentBindings(agentId).filter((binding) => binding.enabled);
      if (bindings.length === 0) {
        return "";
      }
      const parts = bindings.map((binding) => {
        const active = facade.get(binding.pluginId);
        const instance = facade.runtimeHost.getInstance(binding.pluginId);
        return [
          binding.pluginId,
          active?.version ?? "",
          active?.status ?? "",
          String(binding.grantRevision),
          String(binding.revision),
          instance?.runtimeInstanceId ?? "",
          [...binding.contributions].sort().join(","),
        ].join(":");
      });
      return parts.sort().join("|");
    } catch {
      return "";
    }
  }

  /** P0-2/P1-2 turn 快照工厂：模块级 buildPluginTurnSnapshotFactory 的接线（facade 未接入时无快照） */
  function pluginSnapshotFactory(): SessionRuntimeOptions["snapshotFactory"] {
    if (options.pluginFacade === undefined) {
      return undefined;
    }
    return buildPluginTurnSnapshotFactory(options.pluginFacade);
  }


  /**
   * 构建含记忆注入的完整 system prompt。未绑定 Agent 或不具备记忆条件时仅返回 persona。
   */
  function buildSystemPrompt(agentId: string): string | undefined {
    if (agentStore === undefined) return undefined;
    const baseColor = agentStore.getBaseColor(agentId);
    const parts: string[] = [];
    if (baseColor.persona) {
      parts.push(baseColor.persona);
    }
    if (baseColor.replyStyle) {
      parts.push(`回复风格: ${baseColor.replyStyle}`);
    }
    if (baseColor.personality.length > 0) {
      parts.push(`性格标签: ${baseColor.personality.join("、")}`);
    }
    if (baseColor.innerSetting) {
      parts.push(`相处边界: ${baseColor.innerSetting}`);
    }

    // 记忆注入：在 persona 之后追加（预算取自真实记忆设置，评审 P1#7b）
    if (paths && database) {
      const memoryDir = path.join(paths.agents, agentId, "memory");
      const pinnedStore = new PinnedMemoryStore(database);
      const pinned = pinnedStore.listByAgent(agentId);
      const memorySettings = options.memorySettingsResolver !== undefined
        ? options.memorySettingsResolver(agentId)
        : defaultMemoryAgentSettings();
      const injection = buildMemoryInjectionBlock({
        memoryDir,
        pinned,
        budgetChars: memorySettings.injectBudgetChars,
      });
      if (injection) {
        parts.push(injection.block);
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  // 懒重建 runtime：无 runtime 时按 messages 路由同款逻辑创建；
  // 已有 runtime 且 Agent profile 变更时先 invalidate 再重建。
  // 失败抛 EnsureRuntimeError，由调用方映射为 HTTP 响应。
  async function ensureRuntime(sessionId: string): Promise<void> {
    const createRuntime = async (systemPrompt: string | undefined) => {
      const snapshotFactory = pluginSnapshotFactory();
      // 仅在需要创建/重建 runtime 时才要求 sessionService 与 paths 存在
      if (!sessionService || !paths) {
        throw new EnsureRuntimeError(createApiError("CONFLICT", "Session Runtime 未就绪"), 409);
      }
      const session = sessionService.open(sessionId);
      const view = sessionService.getView(sessionId);
      const toolMode = (view.toolMode ?? "off") as ToolMode;
      const toolPolicy = new ToolPolicy();
      const fileTools = toolPolicy.resolveTools(
        toolMode,
        view.workspaceCwd ?? undefined,
        view.workspaceConfirmed,
      );
      const runtimeCwd = view.workspaceCwd || process.cwd();

      // 记忆工具：Agent 绑定 + 数据库可用时始终启用
      const hasMemoryTools = !!(view.agentId && database);
      const extraTools = hasMemoryTools ? [...MEMORY_TOOL_NAMES] : undefined;
      // 有记忆工具时决不使用 noTools: "all"
      const noTools = (toolPolicy.shouldDisableAllTools(toolMode) && !hasMemoryTools)
        ? ("all" as const)
        : undefined;
      const tools = fileTools.length > 0 ? [...fileTools] : undefined;

      // 构建沙箱上下文：当 session 绑定 Agent 且 paths/agentStore 可用时
      let agentSettings: import("../../contracts/agent-settings.js").AgentSettingsV2 | undefined;
      let agentHomeDir: string | undefined;
      let platformHome: string | undefined;
      if (view.agentId && agentStore && paths) {
        try {
          agentSettings = agentStore.getSettings(view.agentId);
          agentHomeDir = path.join(paths.agents, view.agentId);
          platformHome = paths.home;
        } catch {
          // 读取 Agent 设置失败时降级运行，不启用沙箱
        }
      }

      // 构建记忆层上下文（在 runtime 创建后注册）
      let unregisterMemory: (() => void) | undefined;
      const setupMemoryContext = (runtime: SessionRuntime) => {
        if (!database || !view.agentId || !paths) return;
        try {
          const factStore = new MemoryFactStore(database);
          const eventStore = new MemoryEventStore(database);
          const recallStore = new MemoryRecallStore(database);
          const journalStore = new MemoryJournalStore(database);
          const pinnedStore = new PinnedMemoryStore(database);
          const sessionIndex = new SessionIndex(database);

          const recallService = new MemoryRecallService({
            factStore,
            eventStore,
            recallStore,
            sessionIndex,
            publish: (env) => {
              if (replayStore) replayStore.publish(env);
            },
            agentsDir: paths.agents,
          });

          unregisterMemory = registerMemoryContext(sessionId, {
            agentId: view.agentId!,
            recallService,
            journalStore,
            pinnedStore,
          });
        } catch {
          // 记忆层初始化失败不阻塞会话创建
        }
      };

      // 插件工具（P0-1）：按 Agent 绑定过滤，注入主会话（生产接线 buildPluginSessionTools）
      const pluginTools =
        view.agentId !== undefined && view.agentId !== null && options.pluginFacade !== undefined
          ? buildPluginSessionTools(options.pluginFacade, view.agentId, sessionId)
          : [];

      // 如果 session 选择了模型且有 modelService，使用真实模型
      const selectedModel = session.model;
      if (selectedModel && modelService && selectedModel.providerId !== "faux") {
        const runtime = await SessionRuntime.create({
          sessionId,
          cwd: runtimeCwd,
          authPath: paths.authFile,
          publish: () => {},
          sessionHandle: session,
          modelService,
          resolveProviderId: selectedModel.providerId,
          resolveModelId: selectedModel.modelId,
          ...(view.agentId != null ? { agentId: view.agentId } : {}),
          ...(noTools ? { noTools } : {}),
          ...(tools ? { tools } : {}),
          ...(extraTools ? { extraTools } : {}),
          ...(pluginTools.length > 0 ? { pluginTools } : {}),
          ...(snapshotFactory !== undefined ? { snapshotFactory } : {}),
          thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(replayStore ? { replayStore } : {}),
          ...(agentSettings ? { agentSettings } : {}),
          ...(agentHomeDir ? { agentHomeDir } : {}),
          ...(platformHome ? { platformHome } : {}),
          workspaceCwd: view.workspaceCwd,
          onDispose: () => unregisterMemory?.(),
        });
        setupMemoryContext(runtime);
        promptService.register(runtime);
        runtimeSystemPrompt.set(sessionId, systemPrompt);
        pluginSignatures.set(sessionId, pluginSignature(view.agentId ?? undefined));
      } else {
        const runtime = await SessionRuntime.create({
          sessionId,
          cwd: process.cwd(),
          sessionDir: paths.sessions,
          authPath: paths.authFile,
          providerId: "faux",
          modelId: "faux-1",
          faux: { response: "已收到您的消息", tokensPerSecond: 20 },
          publish: () => {},
          sessionHandle: session,
          ...(view.agentId != null ? { agentId: view.agentId } : {}),
          ...(noTools ? { noTools } : {}),
          ...(tools ? { tools } : {}),
          ...(extraTools ? { extraTools } : {}),
          ...(pluginTools.length > 0 ? { pluginTools } : {}),
          ...(snapshotFactory !== undefined ? { snapshotFactory } : {}),
          thinkingLevel: view.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(replayStore ? { replayStore } : {}),
          ...(agentSettings ? { agentSettings } : {}),
          ...(agentHomeDir ? { agentHomeDir } : {}),
          ...(platformHome ? { platformHome } : {}),
          workspaceCwd: view.workspaceCwd,
          onDispose: () => unregisterMemory?.(),
        });
        setupMemoryContext(runtime);
        promptService.register(runtime);
        runtimeSystemPrompt.set(sessionId, systemPrompt);
        pluginSignatures.set(sessionId, pluginSignature(view.agentId ?? undefined));
      }
    };

    if (!promptService.hasRuntime(sessionId)) {
      // 对齐原 messages 路由：无 runtime 且缺少 sessionService/paths 时直接 409
      if (!sessionService || !paths) {
        throw new EnsureRuntimeError(createApiError("CONFLICT", "Session Runtime 未就绪"), 409);
      }
      try {
        const view = sessionService.getView(sessionId);
        // 构建 Agent 人设 system prompt（仅当会话绑定了 Agent 且 profile 存在时）
        const systemPrompt = view.agentId ? buildSystemPrompt(view.agentId) : undefined;
        await createRuntime(systemPrompt);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) throw error;
        throw new EnsureRuntimeError(createApiError("SESSION_ERROR", "无法创建 Session Runtime"), 500);
      }
      return;
    }

    // Runtime 已存在：检查 Agent profile 或插件状态是否有更新，如有则重建 runtime
    const view = sessionService?.getView(sessionId);
    if (view?.agentId && agentStore) {
      const currentPrompt = buildSystemPrompt(view.agentId);
      const lastPrompt = runtimeSystemPrompt.get(sessionId);
      // P0-2：插件绑定/授权/版本/运行实例变化（解绑、新绑定、授权变更、插件更新）
      // 必须触发重建——否则下一 turn 仍看到旧工具集
      const currentPluginSig = pluginSignature(view.agentId ?? undefined);
      const lastPluginSig = pluginSignatures.get(sessionId);
      if (currentPrompt !== lastPrompt || currentPluginSig !== lastPluginSig) {
        // profile 或插件状态已更新，使旧 runtime 失效并重建
        promptService.invalidate(sessionId);
        runtimeSystemPrompt.delete(sessionId);
        pluginSignatures.delete(sessionId);
        try {
          await createRuntime(currentPrompt);
        } catch (error) {
          if (error instanceof EnsureRuntimeError) throw error;
          throw new EnsureRuntimeError(createApiError("SESSION_ERROR", "无法重建 Session Runtime"), 500);
        }
      }
    }
  }

  app.post("/api/sessions/:id/messages", async (context) => {
    const sessionId = context.req.param("id");
    try {
      const body = (await context.req.json()) as { content?: unknown };
      if (typeof body.content !== "string" || !body.content.trim()) {
        return context.json(createApiError("INVALID_INPUT", "Prompt 不能为空"), 400);
      }
      if (sessionService !== undefined) {
        const view = sessionService.getView(sessionId);
        if (view.archived) {
          return context.json(createApiError("CONFLICT", "已归档 Session 不能执行 Prompt"), 409);
        }
      }

      try {
        await ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) {
          return context.json(error.apiError, error.status);
        }
        throw error;
      }

      const run = promptService.prompt(sessionId, body.content);
      return context.json(
        {
          status: "accepted",
          sessionId,
          streamId: run.streamId,
        },
        202,
      );
    } catch {
      return context.json(createApiError("CONFLICT", "Session 当前无法接受 Prompt"), 409);
    }
  });

  app.post("/api/sessions/:id/abort", async (context) => {
    try {
      const body = (await context.req.json()) as { streamId?: unknown };
      if (typeof body.streamId !== "string") {
        return context.json(createApiError("INVALID_INPUT", "streamId 无效"), 400);
      }
      return context.json(promptService.abort(context.req.param("id"), body.streamId));
    } catch {
      return context.json(createApiError("NOT_FOUND", "Session Runtime 不存在"), 404);
    }
  });

  app.post("/api/sessions/:id/compact", async (context) => {
    const sessionId = context.req.param("id");

    // 归档会话拒绝 compact（对齐 messages 路由的 archived 检查）
    if (sessionService !== undefined) {
      try {
        const view = sessionService.getView(sessionId);
        if (view.archived) {
          return context.json(createApiError("CONFLICT", "已归档 Session 不能压缩"), 409);
        }
      } catch {
        return context.json(createApiError("NOT_FOUND", "Session 不存在"), 404);
      }
    }

    // 忙时拒绝：会话正在生成时返回 409 SESSION_BUSY
    if (promptService.isBusy(sessionId)) {
      return context.json(createApiError("SESSION_BUSY", "会话正在生成，无法压缩", false), 409);
    }

    // 无 runtime 时走与 messages 相同的懒重建
    if (!promptService.hasRuntime(sessionId)) {
      try {
        await ensureRuntime(sessionId);
      } catch (error) {
        if (error instanceof EnsureRuntimeError) {
          return context.json(error.apiError, error.status);
        }
        throw error;
      }
    }

    try {
      await promptService.compact(sessionId);
      return context.json({ status: "completed" });
    } catch {
      return context.json(createApiError("CONFLICT", "当前会话无需压缩"), 409);
    }
  });
}
