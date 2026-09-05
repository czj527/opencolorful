import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";

import { PLATFORM_VERSION } from "../index.js";
import type { RuntimePaths } from "../config/paths.js";
import type { EventReplayStore } from "../runtime/event-replay-store.js";
import type { ModelService } from "../runtime/model-service.js";
import type { SessionService } from "../runtime/session-service.js";
import type { PromptService } from "../runtime/prompt-service.js";
import type { PreferencesStore } from "../config/preferences-store.js";
import type { AgentStore } from "../config/agent-store.js";
import type { FolderPicker } from "../platform/folder-picker.js";
import type { UsageStore } from "../storage/usage-store.js";
import { defaultMemoryAgentSettings } from "../contracts/memory.js";
import { instrument } from "../observability/instrument.js";
import { registerDirectoryRoutes } from "./routes/directories.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { createRuntimeBootstrap } from "./routes/runtime-bootstrap.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSessionBranchRoutes } from "./routes/session-branches.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerSandboxRoutes } from "./routes/sandbox.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerAgentEventRoutes } from "./routes/agent-events.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerSubagentRoutes } from "./routes/subagents.js";
import { registerPluginDevRoutes, registerPluginRoutes } from "./routes/plugins.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerSkillAdminRoutes } from "./routes/skill-admin.js";
import { ClientRegistry } from "./ws/client-registry.js";
import { SessionHandler } from "./ws/session-handler.js";

export interface ServerAppOptions {
  readonly version?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly paths?: RuntimePaths;
  readonly modelService?: ModelService;
  readonly sessionService?: SessionService;
  readonly promptService?: PromptService;
  readonly replayStore?: EventReplayStore;
  readonly preferencesStore?: PreferencesStore;
  readonly agentStore?: AgentStore;
  readonly folderPicker?: FolderPicker;
  readonly usageStore?: UsageStore;
  readonly wsRegistry?: ClientRegistry;
  readonly wsPromptService?: PromptService;
  readonly wsReplayStore?: EventReplayStore;
  readonly database?: import("better-sqlite3").Database;
  /** Phase 11 fail-closed 审计（沙箱/工作区/凭据等高风险修改，评审 P0-1） */
  readonly audit?: import("../observability/audit-recorder.js").AuditRecorder;
  readonly pluginFacade?: import("../platform/plugin-facade.js").PluginFacade;
  /** Phase 13 T6 Skill Core Service（组合根注入；注入后才注册 Skill 路由） */
  readonly skillCoreService?: import("../runtime/skills/core/skill-core-service.js").SkillCoreService;
  /** Phase 13 T8 Skill 管理 Service（来源信任/Linked Source/Bundle/详情等管理面端点） */
  readonly skillAdminService?: import("../runtime/skills/core/skill-admin-service.js").SkillAdminService;
  /** Phase 10 手动 flush 的实际执行钩子（封存 + 重建 Markdown/事件索引） */
  readonly memoryFlushHook?: (agentId: string) => void;
  /** Phase 10.5 管理依赖（deep-dive/rollback/runs/settings/timeline） */
  readonly memoryAdmin?: import("./routes/memory.js").MemoryAdminDeps;
  /**
   * Phase 14 T6/T7：Subagent 只读 API 与运行时组合根。
   * composition 注入后：注册 subagent 路由 + 主会话工具上下文/父端口
   * 接线（messages 路由 ensureRuntime）；组合根缺服务时不注册工具
   * （§20.2：不注册后静默 no-op）。
   */
  readonly subagent?: import("./routes/subagents.js").SubagentRouteDeps & {
    readonly composition?: import("../runtime/subagents/composition.js").SubagentRuntimeComposition;
  };
}

export interface ServerAppResult {
  readonly app: Hono;
  readonly nodeWebSocket: ReturnType<typeof createNodeWebSocket>;
}

export function createServerApp(options: ServerAppOptions = {}): ServerAppResult {
  const version = options.version ?? PLATFORM_VERSION;
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? Date.now();
  const app = new Hono();

  // Phase 11 API 埋点中间件：请求计时 → diagnostic（debug）；5xx/异常 → api.request.failed。
  // 不记录请求体/响应体；跳过 WS 与 SSE 长连接（计时无意义）。
  app.use("*", async (context, next) => {
    const method = context.req.method;
    const url = new URL(context.req.url);
    const accept = context.req.header("accept") ?? "";
    const isStreaming = accept.includes("text/event-stream");
    if (url.pathname === "/ws" || isStreaming || url.pathname === "/api/health") {
      return next();
    }
    const startedAt = Date.now();
    try {
      await next();
      const durationMs = Date.now() - startedAt;
      instrument.debug("api.request", `${method} ${url.pathname}`, {
        method,
        path: url.pathname,
        status: context.res.status,
        durationMs,
      });
      if (context.res.status >= 500) {
        instrument.apiRequestFailed(method, url.pathname, context.res.status, `HTTP ${context.res.status}`);
      }
    } catch (error) {
      instrument.apiRequestFailed(method, url.pathname, 500, error instanceof Error ? error : String(error));
      throw error;
    }
  });

  const nodeWebSocket = createNodeWebSocket({ app });

  app.get("/api/health", (context) =>
    context.json({
      status: "ok",
      version,
      pid,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    }),
  );

  if (options.modelService !== undefined) {
    registerProviderRoutes(app, options.modelService);
    registerModelRoutes(app, options.modelService);
  }
  if (options.preferencesStore !== undefined) {
    registerSettingsRoutes(app, options.preferencesStore, options.modelService);
  }
  if (options.agentStore !== undefined) {
    registerAgentRoutes(app, options.agentStore, options.sessionService, options.audit);
  }
  if (options.agentStore !== undefined && options.paths !== undefined) {
    registerSandboxRoutes(app, options.agentStore, options.paths);
  }
  if (options.folderPicker !== undefined) {
    registerDirectoryRoutes(app, options.folderPicker);
  }
  if (options.usageStore !== undefined) {
    registerUsageRoutes(app, options.usageStore);
  }
  if (options.database !== undefined && options.paths !== undefined) {
    registerMemoryRoutes(app, options.database, options.paths, options.agentStore, options.memoryFlushHook, options.memoryAdmin);
  }
  if (options.replayStore !== undefined) {
    registerAgentEventRoutes(app, options.replayStore, options.agentStore, options.sessionService);
  }
  // 波次 B2 修复：共享 Runtime Bootstrap 单例（Runtime 全量装配 + profile/
  // 插件签名跟踪）。messages 路由与会话分支路由共用同一实例，保证分支路由
  // 懒创建的 Runtime 工具面（插件/Skill/Subagent/记忆/人设）与 messages 路径
  // 完全一致，不存在静默降级装配。
  const memorySettingsResolver =
    options.preferencesStore !== undefined && options.agentStore !== undefined
      ? (agentId: string) => {
          // 评审 P1#7b：injectBudgetChars 走真实记忆设置（per-Agent 覆盖 → 全局默认 →
          // 平台默认），与 start.ts resolveMemorySettings 同一优先级链
          const global = options.preferencesStore!.get().memory ?? defaultMemoryAgentSettings();
          try {
            const perAgent = options.agentStore!.getSettings(agentId)?.memory;
            if (perAgent !== undefined) return perAgent;
          } catch { /* 读取失败用全局默认 */ }
          return global;
        }
      : undefined;
  const runtimeBootstrap =
    options.promptService !== undefined
      ? createRuntimeBootstrap({
          promptService: options.promptService,
          ...(options.sessionService !== undefined ? { sessionService: options.sessionService } : {}),
          ...(options.replayStore !== undefined ? { replayStore: options.replayStore } : {}),
          ...(options.paths !== undefined ? { paths: options.paths } : {}),
          ...(options.modelService !== undefined ? { modelService: options.modelService } : {}),
          ...(options.agentStore !== undefined ? { agentStore: options.agentStore } : {}),
          ...(options.database !== undefined ? { database: options.database } : {}),
          ...(options.pluginFacade !== undefined ? { pluginFacade: options.pluginFacade } : {}),
          ...(options.skillCoreService !== undefined ? { skillCoreService: options.skillCoreService } : {}),
          ...(memorySettingsResolver !== undefined ? { memorySettingsResolver } : {}),
          ...(options.subagent !== undefined ? { subagent: options.subagent } : {}),
        })
      : undefined;

  if (options.sessionService !== undefined && runtimeBootstrap !== undefined) {
    // 波次 B2：会话分支/重生成/Fork 路由（共享 Runtime Bootstrap）
    registerSessionBranchRoutes(app, {
      sessionService: options.sessionService,
      promptService: options.promptService!,
      runtimeBootstrap,
    });
  }
  if (options.sessionService !== undefined) {
    registerSessionRoutes(
      app,
      options.sessionService,
      options.modelService,
      options.promptService,
      options.preferencesStore,
      options.agentStore,
      options.audit,
    );
  }
  if (runtimeBootstrap !== undefined) {
    registerMessageRoutes(app, {
      promptService: options.promptService!,
      runtimeBootstrap,
      ...(options.sessionService !== undefined ? { sessionService: options.sessionService } : {}),
      ...(options.replayStore !== undefined ? { replayStore: options.replayStore } : {}),
      ...(options.paths !== undefined ? { paths: options.paths } : {}),
      ...(options.modelService !== undefined ? { modelService: options.modelService } : {}),
      ...(options.agentStore !== undefined ? { agentStore: options.agentStore } : {}),
      ...(options.database !== undefined ? { database: options.database } : {}),
      ...(options.pluginFacade !== undefined ? { pluginFacade: options.pluginFacade } : {}),
      // Phase 13 T6：Skill Core Service（注入后 Agent 会话启用五个 Skill Core 工具）
      ...(options.skillCoreService !== undefined ? { skillCoreService: options.skillCoreService } : {}),
      ...(memorySettingsResolver !== undefined ? { memorySettingsResolver } : {}),
      // Phase 14 T6：Subagent 运行时组合根（主会话启用七个 Core 工具 + 父端口）
      ...(options.subagent !== undefined ? { subagent: options.subagent } : {}),
    });
  }
  if (options.replayStore !== undefined && options.promptService !== undefined) {
    registerEventRoutes(app, options.replayStore, options.promptService, options.sessionService);
  }
  if (options.pluginFacade !== undefined) {
    registerPluginRoutes(app, { facade: options.pluginFacade });
    registerPluginDevRoutes(app, { facade: options.pluginFacade });
  }
  if (options.skillCoreService !== undefined) {
    registerSkillRoutes(app, { core: options.skillCoreService });
  }
  // Phase 13 T8 管理面端点（来源信任/Linked Source/Bundle/文件树/详情/学习策略）
  if (options.skillCoreService !== undefined && options.skillAdminService !== undefined) {
    registerSkillAdminRoutes(app, { core: options.skillCoreService, admin: options.skillAdminService });
  }

  if (options.database !== undefined && options.paths !== undefined) {
    registerObservabilityRoutes(app, {
      database: options.database,
      paths: options.paths,
      getHealth: () => instrument.getHealth(),
      // 评审 P1-7：observability 偏好（retention 默认天数/logger 参数）接入路由
      ...(options.preferencesStore !== undefined ? { preferencesStore: options.preferencesStore } : {}),
      // 评审 P0（第三轮）：retention 删除与 Audit 同事务（fail-closed）
      ...(options.audit !== undefined ? { audit: options.audit } : {}),
    });
  }

  // Phase 14 T7：Subagent transcript/SSE/Artifact 只读 API（组合根注入后注册）
  if (options.subagent !== undefined) {
    registerSubagentRoutes(app, options.subagent);
  }

  // WebSocket 路由
  const wsRegistry = options.wsRegistry;
  const wsPromptService = options.wsPromptService;
  const wsReplayStore = options.wsReplayStore;
  if (wsRegistry !== undefined && wsPromptService !== undefined && wsReplayStore !== undefined) {
    app.get("/ws", nodeWebSocket.upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        const clientId = `ws-${crypto.randomUUID()}`;
        instrument.wsConnected(clientId);
        const handler = new SessionHandler(
          ws,
          clientId,
          wsRegistry,
          wsPromptService,
          wsReplayStore,
          options.sessionService,
        );
        wsRegistry.register(clientId, ws);

        const unsubscribe = wsReplayStore.subscribe((event) => {
          if (event.sessionId === null) return;
          if (wsRegistry.isSubscribed(clientId, event.sessionId)) {
            ws.send(JSON.stringify({ type: "event", payload: event }));
          }
        });

        ws.raw?.addEventListener("message", (evt) => {
          const raw = typeof evt.data === "string"
            ? evt.data
            : new TextDecoder().decode(evt.data as ArrayBuffer);
          handler.handleMessage(raw);
        });

        ws.raw?.addEventListener("close", () => {
          unsubscribe();
          instrument.wsDisconnected(clientId);
          handler.handleClose();
        });
      },
    })));
  }

  app.notFound((context) => context.json({ code: "NOT_FOUND", message: "资源不存在" }, 404));
  return { app, nodeWebSocket };
}
