import path from "node:path";

import type Database from "better-sqlite3";

import type { RuntimePaths } from "../../config/paths.js";
import type { PreferencesStore } from "../../config/preferences-store.js";
import type { PiModelRuntimeHandle } from "../../pi-sdk/index.js";
import type { AuditRecorder } from "../../observability/audit-recorder.js";
import type { ActivityRecorder } from "../../observability/activity-recorder.js";
import type { ModelService } from "../../runtime/model-service.js";
import type { SubagentToolServices } from "../../pi-sdk/subagent-tools-context.js";
import { ParentMailboxDeliveryCoordinator } from "./mailbox/parent-mailbox-delivery-coordinator.js";
import { ProtocolDispatcher } from "./protocol/protocol-dispatcher.js";
import { SubagentStartupRecovery, type SubagentStartupRecoveryReport } from "./recovery/startup-recovery.js";
import { createPiSubagentSessionFactory } from "./runtime/pi-session-adapter.js";
import { SubagentRuntimeHost } from "./runtime/runtime-host.js";
import { SubagentScheduler } from "./runtime/scheduler.js";
import type { SubagentSessionFactory } from "./runtime/types.js";
import {
  ArtifactStore,
  MessageStore,
  ParentMailboxStore,
  RunStore,
  SubagentTransactions,
  ThreadStore,
  WorkspaceLeaseStore,
} from "./stores/index.js";
import type { SubagentOwnership } from "./stores/types.js";
import { SubagentObservabilityProjector, wireSubagentRuntimeObservability } from "./observability/subagent-observability-projector.js";
import { SubagentArtifactFileService } from "./transcript/artifact-files.js";
import { SubagentReplayStore } from "./transcript/replay-store.js";
import { SubagentToolActivityTracker } from "./transcript/tool-summary.js";
import { SubagentTranscriptView } from "./transcript/transcript-view.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T6：Subagent 运行时组合根（plans/phase-14.md §16.4 / T6）
//
// 组合根构造全部 Subagent 服务并完成内部接线：
// - Stores（六表 + 事务）→ Replay/Projector → Transcript/Artifact/
//   ToolTracker → Host/Scheduler → Dispatcher → Coordinator → Recovery；
// - Host 回调接线：onTerminal/onMessage(input_required) → coordinator
//   signal（mailbox 行已由终态事务写入）；onRunFinished → coordinator
//   closing 终态化 + scheduler 容量释放；observability 经
//   wireSubagentRuntimeObservability 叠加（best-effort）；
// - SessionFactory = PI AgentSession 适配器（懒创建，T6a）；
// - runRecovery() 由 start.ts 在全部资源就绪后调用，errors 为空才
//   available=true（§16.5 fail-closed；spawn 前检查）；
// - toolServices 静态部分在此组装；per-Session 的父侧状态
//   （parentSnapshot/currentModel/toolCatalog/workspaceCwd）由消息路由
//   ensureRuntime 闭包补充后 registerSubagentContext（§20.2 注册边界）。
// ═══════════════════════════════════════════════════════════════

export interface BuildSubagentCompositionInput {
  readonly database: Database.Database;
  readonly paths: RuntimePaths;
  readonly modelService: ModelService;
  readonly preferencesStore: PreferencesStore;
  readonly activity: ActivityRecorder;
  readonly audit: AuditRecorder;
  /** 当前 Server 启动 bootId（Lease 持有者身份） */
  readonly bootId: string;
  readonly now?: () => number;
}

export interface SubagentRuntimeComposition {
  readonly stores: {
    readonly threads: ThreadStore;
    readonly runs: RunStore;
    readonly messages: MessageStore;
    readonly artifacts: ArtifactStore;
    readonly mailbox: ParentMailboxStore;
    readonly leases: WorkspaceLeaseStore;
    readonly transactions: SubagentTransactions;
  };
  readonly host: SubagentRuntimeHost;
  readonly scheduler: SubagentScheduler;
  readonly dispatcher: ProtocolDispatcher;
  readonly coordinator: ParentMailboxDeliveryCoordinator;
  readonly sessionFactory: SubagentSessionFactory;
  readonly transcriptView: SubagentTranscriptView;
  readonly artifactFiles: SubagentArtifactFileService;
  readonly replay: SubagentReplayStore;
  readonly toolTracker: SubagentToolActivityTracker;
  readonly projector: SubagentObservabilityProjector;
  /** 主会话工具上下文注入的静态服务（per-Session 状态由 ensureRuntime 补充） */
  readonly toolServices: Omit<SubagentToolServices, "parentSnapshot" | "currentModel" | "toolCatalog" | "workspaceCwd">;
  /** 稳定 ID 生成（sat_/sar_/sam_/saa_/smb_/sas_ 前缀） */
  readonly newId: (prefix: "sat_" | "sar_" | "sam_" | "saa_" | "smb_" | "sas_") => string;
  /** Thread 目录解析：<subagentsBase>/<owner>/subagents/<threadId>（§16.3） */
  readonly threadDirResolver: (input: { readonly threadId: string; readonly ownerAgentId: string }) => string;
  readonly modelRuntime: PiModelRuntimeHandle;
  readonly authPath: string;
  /** 启动恢复执行（幂等；errors 为空 → available=true，§16.5） */
  runRecovery(): SubagentStartupRecoveryReport;
  /** 恢复完成后才为 true；spawn 前检查（§16.5 fail-closed） */
  readonly available: () => boolean;
  /** 父 Session archive 联动（SessionService onArchive 接线；§14.4） */
  readonly handleParentSessionArchived: (sessionId: string) => void;
  dispose(): void;
}

function cryptoRandomSuffix(): string {
  const crypto = globalThis.crypto as { randomUUID?: () => string };
  const uuid = crypto.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return uuid.replaceAll("-", "").slice(0, 16);
}

export function buildSubagentComposition(input: BuildSubagentCompositionInput): SubagentRuntimeComposition {
  const { database, paths, modelService, preferencesStore, activity, audit, bootId } = input;
  const now = input.now ?? (() => Date.now());
  const newId = (prefix: "sat_" | "sar_" | "sam_" | "saa_" | "smb_" | "sas_"): string =>
    `${prefix}${cryptoRandomSuffix()}`;
  const threadDirResolver = (dir: { readonly threadId: string; readonly ownerAgentId: string }): string =>
    path.join(paths.subagentsBase, dir.ownerAgentId, "subagents", dir.threadId);

  // 1. Stores
  const threads = new ThreadStore(database);
  const runs = new RunStore(database, threads);
  const messages = new MessageStore(database, threads);
  const artifacts = new ArtifactStore(database, threads);
  const mailbox = new ParentMailboxStore(database);
  const leases = new WorkspaceLeaseStore(database);
  const transactions = new SubagentTransactions(database, { threadStore: threads, runStore: runs, messageStore: messages, mailboxStore: mailbox });

  // 2. 投影/只读组件（T7）
  const replay = new SubagentReplayStore(database);
  const projector = new SubagentObservabilityProjector({ activity, replay, runs, messages });
  const transcriptView = new SubagentTranscriptView({ threads, runs, messages, artifacts });
  const toolTracker = new SubagentToolActivityTracker();
  const artifactFiles = new SubagentArtifactFileService({
    artifacts,
    threads,
    paths,
    onIntegrityFailed: (event) => projector.projectArtifactIntegrityFailed(event),
  });

  // 3. Host / Scheduler / Dispatcher / Coordinator（observability 经 wire 叠加）
  let scheduler: SubagentScheduler;
  let coordinator: ParentMailboxDeliveryCoordinator;
  const sessionFactory = createPiSubagentSessionFactory({
    threadStore: threads,
    modelRuntime: modelService.getRuntime(),
    authPath: paths.authFile,
    threadDirResolver,
  });
  const host = new SubagentRuntimeHost(
    wireSubagentRuntimeObservability(
      {
        runs,
        messages,
        transactions,
        sessionFactory,
        bootId,
        now,
        onTerminal: (event) => {
          // mailbox 行已由 completeRunWithResult 写入；signal 触发父 Turn 唤醒
          coordinator.signal({ threadId: event.threadId });
        },
        onMessage: (event) => {
          if (event.message.envelope.messageType === "input_required") {
            coordinator.signal({ threadId: event.message.threadId });
          }
        },
        onLeaseLost: () => {
          // Lease 丢失的恢复由启动恢复处理；投影已由 wire 叠加
        },
        onRunFinished: (event) => {
          coordinator.onRunFinished(event);
          scheduler.onRunTerminal(); // 容量释放 → 启动排队 Run
        },
      },
      projector,
    ),
  );
  scheduler = new SubagentScheduler({ host });
  coordinator = new ParentMailboxDeliveryCoordinator({
    mailboxStore: mailbox,
    messageStore: messages,
    runStore: runs,
    threadStore: threads,
    transactions,
    cancelRun: (cancelInput) => host.cancelRun(cancelInput.runId, cancelInput.ownership, cancelInput.reasonCode),
    threadDirResolver,
    now,
  });
  const dispatcher = new ProtocolDispatcher({
    messages,
    runs,
    transactions,
    scheduler,
    runtime: {
      deliverParentMessage: (dispatchInput, ownership) => host.deliverParentMessage(dispatchInput, ownership),
      resumeFromInput: (runId, answerText, ownership) =>
        host.resumeFromInput(runId, answerText, ownership, new Date(now()).toISOString()),
    },
    now,
  });

  // 4. 启动恢复（§16.5；errors 为空 → available）
  const recovery = new SubagentStartupRecovery({
    runs,
    threads,
    messages,
    transactions,
    workspaceLeases: leases,
    coordinator,
    now,
  });
  let availableFlag = false;
  const runRecovery = (): SubagentStartupRecoveryReport => {
    const report = recovery.run();
    availableFlag = report.errors.length === 0;
    return report;
  };

  // 5. 父 Session archive 联动（§14.4：cancel + close + suppress + 删目录）
  const handleParentSessionArchived = (sessionId: string): void => {
    const row = database.prepare("SELECT agent_id FROM sessions WHERE id = ?").get(sessionId) as { agent_id: string | null } | undefined;
    const ownership: SubagentOwnership = { ownerAgentId: row?.agent_id ?? sessionId, parentSessionId: sessionId };
    try {
      coordinator.handleParentSessionArchived(ownership);
    } catch {
      // 联动失败不阻断归档主流程（诊断由 coordinator 内部记录）
    }
  };

  return {
    stores: { threads, runs, messages, artifacts, mailbox, leases, transactions },
    host,
    scheduler,
    dispatcher,
    coordinator,
    sessionFactory,
    transcriptView,
    artifactFiles,
    replay,
    toolTracker,
    projector,
    toolServices: {
      preferences: () => ({ subagents: preferencesStore.get().subagents }),
      modelResolver: (providerId, modelId) => {
        try {
          modelService.resolveModel(providerId, modelId);
          return true;
        } catch {
          return false;
        }
      },
      threads,
      runs,
      messages,
      artifacts,
      mailbox,
      leases,
      transactions,
      dispatcher,
      coordinator,
      scheduler,
      host,
      transcriptView,
      artifactFiles,
      replay,
      toolTracker,
      projector,
      audit: (record) => audit.appendStrict(record),
      available: () => availableFlag,
      now,
      newId,
      threadDirResolver,
    } as Omit<SubagentToolServices, "parentSnapshot" | "currentModel" | "toolCatalog" | "workspaceCwd">,
    newId,
    threadDirResolver,
    modelRuntime: modelService.getRuntime(),
    authPath: paths.authFile,
    runRecovery,
    available: () => availableFlag,
    handleParentSessionArchived,
    dispose: () => {
      coordinator.dispose();
      scheduler.drain();
      host.dispose();
    },
  };
}
