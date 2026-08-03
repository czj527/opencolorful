import crypto from "node:crypto";
import type { MemoryMutationProposal } from "../../../contracts/memory.js";
import { MemoryFactStore } from "../../../storage/memory/fact-store.js";
import { MemoryEventStore } from "../../../storage/memory/event-store.js";
import { MemoryJournalStore } from "../../../storage/memory/journal-store.js";
import { MemoryBatchStore } from "../../../storage/memory/batch-store.js";
import { MemoryRecallStore } from "../../../storage/memory/recall-store.js";
import { memoryAgentToolMap, validateToolArgs, type MemoryToolContext } from "./memory-agent-tools.js";
import { MEMORY_AGENT_SYSTEM_PROMPT, buildMemoryAgentPrompt, parseAgentReply } from "./memory-agent-prompts.js";
import { writeMemoryRunReport } from "./run-report.js";
import { instrument } from "../../../observability/instrument.js";
export interface MemoryAgentDeps {
  agentId: string;
  batchStore: MemoryBatchStore;
  journalStore: MemoryJournalStore;
  factStore: MemoryFactStore;
  eventStore: MemoryEventStore;
  recallStore: MemoryRecallStore;
  agentsDir: string;
  completeText: (req: { systemPrompt: string; prompt: string; maxTokens?: number }) => Promise<string>;
  assertSessionReadable?: (sessionPath: string, agentId: string) => void;
  /** 会话 id → JSONL 绝对路径（文件名带时间戳前缀，须由 SessionIndex 解析） */ sessionPathResolver: (sessionId: string) => string;
  /** 由调用方注入的 runId（resolver 统一事件/报告/回滚的标识）；缺省时内部生成 */ runId?: string;
  /** 每周复核模式：附加低置信度/跨日期聚合候选复核提示 */ weekly?: boolean;
  limits?: { maxIterations?: number; maxTokens?: number; maxMinutes?: number };
  now?: () => Date;
}
export interface MemoryAgentRunResult {
  runId: string;
  status: "completed" | "deferred" | "failed";
  proposals: readonly MemoryMutationProposal[];
  batchIds: readonly string[];
  iterations: number;
  /** report_run 工具返回的整理总结（脱敏），落盘到运行报告 */ report?: { summary: string; issues: readonly string[] };
  /** 输入快照（batch revision 等），与报告同落盘 */ inputSnapshot?: { batches: Array<{ id: string; revision: Record<string, unknown> }>; pendingIntents: number };
  reason?: string;
  /** 报告写入失败（不改变整理结果，仅上报） */ reportError?: string;
}
export class MemoryAgentRunner {
  constructor(private readonly deps: MemoryAgentDeps) {}

  async run(): Promise<MemoryAgentRunResult> {
    const now = this.deps.now ?? (() => new Date());
    const runId = this.deps.runId ?? `run_${crypto.randomUUID()}`;
    const started = now();
    const proposals: MemoryMutationProposal[] = [];
    const batches = this.deps.batchStore.listPendingBatches(this.deps.agentId);
    const batchIds = batches.map((b) => b.id);
    // Phase 11 T5：批次进入处理（不含记忆正文，只记 id）
    for (const batch of batches) {
      instrument.activity({
        eventName: "memory.batch.processing",
        actor: { kind: "scheduler", id: "memory-scheduler" },
        executor: { kind: "memory_agent", id: this.deps.agentId },
        scope: { ownerAgentId: this.deps.agentId, ...(batch.sessionId !== undefined ? { sessionId: batch.sessionId } : {}) },
        target: { kind: "memory_batch", id: batch.id },
        payload: { summaryCode: "memory_batch_processing" },
      });
    }
    const history: string[] = [];
    const limits = { maxIterations: 8, maxTokens: 8000, maxMinutes: 10, ...this.deps.limits };
    let iterations = 0;
    let estimate = 0;
    let malformed = 0;
    let status: MemoryAgentRunResult["status"] = "deferred";
    let reason = "预算耗尽";
    let agentReport: { summary: string; issues: readonly string[] } | undefined;
    const inputSnapshot = {
      batches: batches.map((b) => ({ id: b.id, revision: b.revision ?? {} })),
      pendingIntents: this.deps.journalStore.listPending(this.deps.agentId).length,
    };
    try {
      while (iterations < limits.maxIterations) {
        if ((now().getTime() - started.getTime()) / 60000 > limits.maxMinutes || estimate > limits.maxTokens) break;
        iterations += 1;
        let text: string;
        try {
          text = await this.deps.completeText({
            systemPrompt: MEMORY_AGENT_SYSTEM_PROMPT,
            prompt: buildMemoryAgentPrompt({ batches, journalIntents: this.deps.journalStore.listPending(this.deps.agentId), history, budget: `${estimate}/${limits.maxTokens}`, weekly: this.deps.weekly === true }),
            maxTokens: limits.maxTokens,
          });
        } catch {
          status = "failed";
          reason = "模型调用失败";
          break;
        }
        estimate += text.length / 4;
        const reply = parseAgentReply(text);
        if (reply.kind === "malformed") {
          malformed += 1;
          history.push("模型输出格式错误，请只输出合法 JSON。");
          if (malformed >= 3) break;
          continue;
        }
        malformed = 0;
        if (reply.kind === "final") {
          // final 回复自带 report（{summary, issues?}）→ 与 report_run 同样落盘（复审 P2）
          if (reply.report !== undefined && typeof reply.report === "object" && !Array.isArray(reply.report)) {
            const report = reply.report as { summary?: unknown; issues?: unknown };
            agentReport = {
              summary: typeof report.summary === "string" ? report.summary : "",
              issues: Array.isArray(report.issues) ? report.issues.filter((x): x is string => typeof x === "string") : [],
            };
          }
          status = "completed";
          reason = "";
          break;
        }
        const tool = memoryAgentToolMap.get(reply.tool);
        if (!tool || !validateToolArgs(reply.tool, reply.args)) {
          history.push("工具名称或参数不在白名单内。");
          continue;
        }
        try {
          const ctx: MemoryToolContext = {
            agentId: this.deps.agentId,
            runId,
            factStore: this.deps.factStore,
            eventStore: this.deps.eventStore,
            journalStore: this.deps.journalStore,
            batchStore: this.deps.batchStore,
            recallStore: this.deps.recallStore,
            agentsDir: this.deps.agentsDir,
            proposals,
            assertSessionReadable: this.deps.assertSessionReadable ?? (() => undefined),
            sessionPathResolver: this.deps.sessionPathResolver,
            now,
          };
          const result = tool.execute(ctx, reply.args as never);
          if (reply.tool === "report_run") {
            const parsed = result as { summary: string; issues?: string[] };
            agentReport = { summary: parsed.summary, issues: parsed.issues ?? [] };
            // report_run 即结束运行（工具契约："报告整理结果并结束运行"）
            status = "completed";
            reason = "";
            history.push(`${reply.tool}: ${JSON.stringify(result)}`);
            break;
          }
          history.push(`${reply.tool}: ${JSON.stringify(result)}`);
        } catch {
          history.push("工具执行失败：参数或资源不可用。");
          malformed += 1;
          if (malformed >= 3) break;
        }
      }
    } catch {
      status = "failed";
      reason = "整理运行失败";
    }
    if (status === "deferred" && iterations >= limits.maxIterations) reason = "超过最大迭代次数";
    const completedAt = now().toISOString();
    const write = await writeMemoryRunReport({
      runId,
      agentId: this.deps.agentId,
      agentsDir: this.deps.agentsDir,
      batchIds,
      proposals,
      iterations,
      status,
      reason,
      startedAt: started.toISOString(),
      completedAt,
      tokenEstimate: estimate,
      issues: history.slice(-5),
      ...(agentReport !== undefined ? { report: agentReport } : {}),
      inputSnapshot,
    });
    const result: MemoryAgentRunResult = {
      runId, status, proposals, batchIds, iterations,
      ...(reason ? { reason } : {}),
      ...(agentReport !== undefined ? { report: agentReport } : {}),
      inputSnapshot,
      ...(write.error !== undefined ? { reportError: write.error } : {}),
    };
    // Phase 11 T5：批次终态（completed/failed/deferred，按 run 结果统一判定）
    const terminalName = status === "completed"
      ? "memory.batch.completed"
      : status === "failed"
        ? "memory.batch.failed"
        : "memory.batch.deferred";
    const terminalCode = status === "completed"
      ? "memory_batch_completed"
      : status === "failed"
        ? "memory_batch_failed"
        : "memory_batch_deferred";
    for (const batchId of batchIds) {
      instrument.activity({
        eventName: terminalName,
        status: status === "completed" ? "completed" : status === "failed" ? "failed" : "deferred",
        operationId: `batch-${this.deps.agentId}-${batchId}-${runId}`,
        actor: { kind: "scheduler", id: "memory-scheduler" },
        executor: { kind: "memory_agent", id: this.deps.agentId },
        scope: { ownerAgentId: this.deps.agentId },
        target: { kind: "memory_batch", id: batchId },
        payload: { summaryCode: terminalCode, ...(reason ? { attributes: { reason: reason.slice(0, 200) } } : {}) },
      });
    }
    return result;
  }
}
