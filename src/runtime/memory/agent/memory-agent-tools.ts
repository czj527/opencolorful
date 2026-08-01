import crypto from "node:crypto";
import { Type, type Static } from "typebox";
import Value from "typebox/value";
import type { MemoryMutationProposal } from "../../../contracts/memory.js";
import { CreateFactProposalPayloadSchema, StrengthChangeProposalPayloadSchema, SupersedeProposalPayloadSchema, MergeProposalPayloadSchema, ForgetProposalPayloadSchema, LongtermProjectionProposalPayloadSchema } from "../../../contracts/memory.js";
import { MemoryFactStore } from "../../../storage/memory/fact-store.js";
import { MemoryEventStore } from "../../../storage/memory/event-store.js";
import { MemoryJournalStore } from "../../../storage/memory/journal-store.js";
import { MemoryBatchStore } from "../../../storage/memory/batch-store.js";
import { MemoryRecallStore } from "../../../storage/memory/recall-store.js";
import { readSessionBranchSnapshot, sliceBranchRange, extractMessageText } from "../jsonl-branch-reader.js";
import { sanitizeSensitiveText, sanitizeToolResult } from "../../sanitize.js";

const idSchema = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1 })]);
const common = { evidenceRefs: Type.Array(Type.String({ minLength: 1 })), reason: Type.String(), confidence: Type.Number({ minimum: 0, maximum: 1 }) } as const;
export const ToolArgSchemas = {
  read_session_entries: Type.Object({ sessionId: Type.Optional(Type.String({ minLength: 1 })), batchId: Type.Optional(Type.String({ minLength: 1 })), sourceStartEntry: Type.Optional(Type.String({ minLength: 1 })), sourceEndEntry: Type.Optional(Type.String({ minLength: 1 })) }),
  search_memory_candidates: Type.Object({ query: Type.String({ minLength: 1 }), layer: Type.Optional(Type.Union([Type.Literal("facts"), Type.Literal("events")])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
  get_activation_summary: Type.Object({ memoryId: Type.Optional(idSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
  propose_fact: Type.Object({ payload: CreateFactProposalPayloadSchema, ...common }),
  propose_strength_change: Type.Object({ memoryId: idSchema, payload: StrengthChangeProposalPayloadSchema, ...common }),
  propose_supersede: Type.Object({ memoryId: idSchema, payload: SupersedeProposalPayloadSchema, ...common }),
  propose_merge: Type.Object({ payload: MergeProposalPayloadSchema, ...common }),
  propose_forget: Type.Object({ payload: ForgetProposalPayloadSchema, ...common }),
  propose_longterm_projection: Type.Object({ payload: LongtermProjectionProposalPayloadSchema, ...common }),
  report_run: Type.Object({ summary: Type.String({ minLength: 1 }), issues: Type.Optional(Type.Array(Type.String())) }),
} as const;
export type MemoryToolName = keyof typeof ToolArgSchemas;
type Args = { [K in MemoryToolName]: Static<(typeof ToolArgSchemas)[K]> };
export interface MemoryToolContext { agentId: string; runId: string; factStore: MemoryFactStore; eventStore: MemoryEventStore; journalStore: MemoryJournalStore; batchStore: MemoryBatchStore; recallStore: MemoryRecallStore; agentsDir: string; proposals: MemoryMutationProposal[]; assertSessionReadable: (sessionPath: string, agentId: string) => void; now: () => Date; /** 会话 id → JSONL 绝对路径（文件名带时间戳前缀，不能猜测拼接） */ sessionPathResolver: (sessionId: string) => string; }
export interface MemoryAgentTool { name: MemoryToolName; description: string; argsSchema: (typeof ToolArgSchemas)[MemoryToolName]; execute: (ctx: MemoryToolContext, args: unknown) => unknown; }
function strId(x: string | number): string { return String(x); }
/** 目标事实必须属于当前 Agent（跨 Agent 隔离：getById 是全局查询，必须显式校验归属） */
function requireOwnFact(ctx: MemoryToolContext, memoryId: string | number): void {
  const fact = ctx.factStore.getById(Number(memoryId));
  if (fact !== undefined && fact.agentId !== ctx.agentId) throw new Error("目标事实不属于当前 Agent");
}
function proposal(ctx: MemoryToolContext, type: MemoryMutationProposal["type"], args: { payload: Record<string, unknown>; evidenceRefs: readonly string[]; reason: string; confidence: number; targetType?: MemoryMutationProposal["targetType"]; targetId?: string; previousState?: Record<string, unknown> }): string {
  const p: MemoryMutationProposal = { id: `map_${crypto.randomUUID()}`, agentId: ctx.agentId, runId: ctx.runId, type, ...(args.targetType ? { targetType: args.targetType } : {}), ...(args.targetId ? { targetId: args.targetId } : {}), payload: args.payload, ...(args.previousState ? { previousState: args.previousState } : {}), evidenceRefs: args.evidenceRefs, reason: sanitizeSensitiveText(args.reason, 1000), confidence: args.confidence, status: "pending", createdAt: ctx.now().toISOString() };
  ctx.proposals.push(p); return p.id;
}
function make<K extends MemoryToolName>(name: K, description: string, execute: (ctx: MemoryToolContext, args: Args[K]) => unknown): MemoryAgentTool { return { name, description, argsSchema: ToolArgSchemas[name], execute: execute as (ctx: MemoryToolContext, args: unknown) => unknown }; }
export const memoryAgentTools: readonly MemoryAgentTool[] = [
  // 跨 Agent 隔离：必须提供 batchId；batch 必须属于当前 Agent；只能读批次限定的会话与原文范围
  make("read_session_entries", "读取封存批次限定的会话原文", (ctx, a) => {
    const batchId = a.batchId;
    if (!batchId) throw new Error("必须提供 batchId（记忆 Agent 只允许读取封存批次限定的会话）");
    const batch = ctx.batchStore.get(batchId);
    if (!batch) throw new Error(`批次不存在: ${batchId}`);
    if (batch.agentId !== ctx.agentId) throw new Error("批次不属于当前 Agent");
    const sessionId = a.sessionId ?? batch.sessionId;
    if (sessionId !== batch.sessionId) throw new Error("仅允许读取批次限定的会话");
    if (!batch.sourceStartEntry || !batch.sourceEndEntry) throw new Error("批次缺少原文范围");
    const sessionPath = ctx.sessionPathResolver(sessionId);
    ctx.assertSessionReadable(sessionPath, ctx.agentId);
    const snapshot = readSessionBranchSnapshot(sessionPath);
    if (!snapshot) throw new Error("会话文件不存在");
    const batchEntries = sliceBranchRange(snapshot, batch.sourceStartEntry, batch.sourceEndEntry);
    if (!batchEntries) throw new Error("批次范围不在当前分支");
    let entries = batchEntries;
    const start = a.sourceStartEntry ?? batch.sourceStartEntry;
    const end = a.sourceEndEntry ?? batch.sourceEndEntry;
    if (start !== batch.sourceStartEntry || end !== batch.sourceEndEntry) {
      // 模型自选范围必须落在批次范围内（entry id 内容寻址，不能比较大小，用子集判定）
      const requested = sliceBranchRange(snapshot, start, end);
      const batchIds = new Set(batchEntries.map((entry) => entry.id));
      if (!requested || requested.some((entry) => !batchIds.has(entry.id))) throw new Error("原文范围超出批次限定");
      entries = requested;
    }
    return sanitizeSensitiveText(entries.map((e) => { const m = extractMessageText(e); return m ? `${m.role}: ${m.text}` : ""; }).filter(Boolean).join("\n"), 4000);
  }),
  make("search_memory_candidates", "只读搜索长期记忆候选", (ctx, a) => { const limit = a.limit ?? 10; const facts = a.layer !== "events" ? ctx.factStore.searchByFts(ctx.agentId, a.query, limit) : []; const events = a.layer !== "facts" ? ctx.eventStore.searchByFts(ctx.agentId, a.query, { limit }) : []; return sanitizeToolResult({ facts: facts.map((f) => ({ id: f.id, fact: f.fact, strength: f.retentionStrength, confidence: f.confidence, refs: f.sourceRefs })), events: events.map((e) => ({ id: e.id, summary: e.summary, sessionId: e.sessionId })) }, 4000); }),
  // 回忆账本聚合（事实来源）：跨日期/跨会话去重，供强度提案确定性校准
  make("get_activation_summary", "读取回忆账本聚合强度信号（跨日期/跨会话去重）", (ctx, a) => {
    const limit = a.limit ?? 20;
    const all = ctx.factStore.listByAgent(ctx.agentId, { limit: 1_000_000 });
    const memoryId = a.memoryId;
    const facts = (memoryId !== undefined ? all.filter((f) => String(f.id) === strId(memoryId)) : all).slice(0, limit);
    // 权威统计需全量账本（存储层默认 limit 100，不能截断旧日期/旧会话证据）
    const ledger = ctx.recallStore.listByAgent(ctx.agentId, { limit: 1_000_000 });
    return sanitizeToolResult({ facts: facts.map((f) => {
      const hits = ledger.filter((entry) => entry.targetType === "fact" && entry.targetId === String(f.id));
      return {
        id: f.id,
        fact: f.fact,
        retentionStrength: f.retentionStrength,
        activationStrength: f.activationStrength,
        hitDates: new Set(hits.map((h) => h.createdAt.slice(0, 10))).size,
        hitSessions: new Set(hits.map((h) => h.sessionId)).size,
        confidence: f.confidence,
      };
    }) }, 4000);
  }),
  make("propose_fact", "提议创建事实", (ctx, a) => proposal(ctx, "create_fact", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact" })),
  make("propose_strength_change", "提议调整事实固化强度", (ctx, a) => { requireOwnFact(ctx, a.memoryId); const id = strId(a.memoryId); const f = ctx.factStore.getById(Number(a.memoryId)); return proposal(ctx, "strength_change", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact", targetId: id, ...(f ? { previousState: { retentionStrength: f.retentionStrength, status: f.status, revision: f.updatedAt } } : {}) }); }),
  make("propose_supersede", "提议以新事实取代旧事实", (ctx, a) => { if (a.payload.supersededFactId !== undefined) requireOwnFact(ctx, a.payload.supersededFactId); const id = strId(a.payload.supersededFactId); const f = ctx.factStore.getById(Number(a.payload.supersededFactId)); return proposal(ctx, "supersede", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact", targetId: id, ...(f ? { previousState: { fact: f.fact, status: f.status, revision: f.updatedAt } } : {}) }); }),
  make("propose_merge", "提议合并重复事实", (ctx, a) => { for (const factId of (a.payload.factIds as unknown[] ?? [])) requireOwnFact(ctx, String(factId)); return proposal(ctx, "merge", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact" }); }),
  make("propose_forget", "提议认知遗忘", (ctx, a) => { if (a.payload.targetType === "fact") { requireOwnFact(ctx, String(a.payload.targetId)); } else if (a.payload.targetType === "event") { const evt = ctx.eventStore.getById(String(a.payload.targetId)); if (evt !== undefined && evt.agentId !== ctx.agentId) throw new Error("目标事件不属于当前 Agent"); } return proposal(ctx, "forget", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: a.payload.targetType, targetId: a.payload.targetId }); }),
  make("propose_longterm_projection", "提议生成长期投影", (ctx, a) => proposal(ctx, "longterm_projection", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence })),
  make("report_run", "报告整理结果并结束运行", (_ctx, a) => ({ summary: sanitizeSensitiveText(a.summary, 2000), ...(a.issues ? { issues: a.issues.map((x) => sanitizeSensitiveText(x, 500)) } : {}) })),
];
export const memoryAgentToolMap = new Map<MemoryToolName, MemoryAgentTool>(memoryAgentTools.map((t) => [t.name, t]));
export function validateToolArgs(name: MemoryToolName, value: unknown): boolean { return Value.Check(ToolArgSchemas[name], value); }
