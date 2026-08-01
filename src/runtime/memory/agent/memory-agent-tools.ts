import crypto from "node:crypto";
import path from "node:path";
import { Type, type Static } from "typebox";
import Value from "typebox/value";
import type { MemoryMutationProposal } from "../../../contracts/memory.js";
import { CreateFactProposalPayloadSchema, StrengthChangeProposalPayloadSchema, SupersedeProposalPayloadSchema, MergeProposalPayloadSchema, ForgetProposalPayloadSchema, LongtermProjectionProposalPayloadSchema } from "../../../contracts/memory.js";
import { MemoryFactStore } from "../../../storage/memory/fact-store.js";
import { MemoryEventStore } from "../../../storage/memory/event-store.js";
import { MemoryJournalStore } from "../../../storage/memory/journal-store.js";
import { MemoryBatchStore } from "../../../storage/memory/batch-store.js";
import { readSessionBranchSnapshot, sliceBranchRange, extractMessageText } from "../jsonl-branch-reader.js";
import { sanitizeSensitiveText, sanitizeToolResult } from "../../sanitize.js";

const idSchema = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ minLength: 1 })]);
const common = { evidenceRefs: Type.Array(Type.String({ minLength: 1 })), reason: Type.String(), confidence: Type.Number({ minimum: 0, maximum: 1 }) } as const;
export const ToolArgSchemas = {
  read_session_entries: Type.Object({ sessionId: Type.Optional(Type.String({ minLength: 1 })), batchId: Type.Optional(Type.String({ minLength: 1 })), sourceStartEntry: Type.Optional(Type.String({ minLength: 1 })), sourceEndEntry: Type.Optional(Type.String({ minLength: 1 })) }),
  search_memory_candidates: Type.Object({ query: Type.String({ minLength: 1 }), layer: Type.Optional(Type.Union([Type.Literal("facts"), Type.Literal("events")])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
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
export interface MemoryToolContext { agentId: string; runId: string; factStore: MemoryFactStore; eventStore: MemoryEventStore; journalStore: MemoryJournalStore; batchStore: MemoryBatchStore; agentsDir: string; proposals: MemoryMutationProposal[]; assertSessionReadable: (sessionPath: string) => void; now: () => Date; /** 会话 id → JSONL 绝对路径（文件名带时间戳前缀，不能猜测拼接） */ sessionPathResolver: (sessionId: string) => string; }
export interface MemoryAgentTool { name: MemoryToolName; description: string; argsSchema: (typeof ToolArgSchemas)[MemoryToolName]; execute: (ctx: MemoryToolContext, args: unknown) => unknown; }
function strId(x: string | number): string { return String(x); }
function proposal(ctx: MemoryToolContext, type: MemoryMutationProposal["type"], args: { payload: Record<string, unknown>; evidenceRefs: readonly string[]; reason: string; confidence: number; targetType?: MemoryMutationProposal["targetType"]; targetId?: string; previousState?: Record<string, unknown> }): string {
  const p: MemoryMutationProposal = { id: `map_${crypto.randomUUID()}`, agentId: ctx.agentId, runId: ctx.runId, type, ...(args.targetType ? { targetType: args.targetType } : {}), ...(args.targetId ? { targetId: args.targetId } : {}), payload: args.payload, ...(args.previousState ? { previousState: args.previousState } : {}), evidenceRefs: args.evidenceRefs, reason: sanitizeSensitiveText(args.reason, 1000), confidence: args.confidence, status: "pending", createdAt: ctx.now().toISOString() };
  ctx.proposals.push(p); return p.id;
}
function make<K extends MemoryToolName>(name: K, description: string, execute: (ctx: MemoryToolContext, args: Args[K]) => unknown): MemoryAgentTool { return { name, description, argsSchema: ToolArgSchemas[name], execute: execute as (ctx: MemoryToolContext, args: unknown) => unknown }; }
export const memoryAgentTools: readonly MemoryAgentTool[] = [
  make("read_session_entries", "读取封存批次限定的会话原文", (ctx, a) => { const batch = a.batchId ? ctx.batchStore.get(a.batchId) : undefined; const sessionId = a.sessionId ?? batch?.sessionId; if (!sessionId) throw new Error("必须提供 sessionId 或 batchId"); const start = a.sourceStartEntry ?? batch?.sourceStartEntry; const end = a.sourceEndEntry ?? batch?.sourceEndEntry; if (!start || !end) throw new Error("缺少原文范围"); const sessionPath = ctx.sessionPathResolver(sessionId); ctx.assertSessionReadable(sessionPath); const snapshot = readSessionBranchSnapshot(sessionPath); if (!snapshot) throw new Error("会话文件不存在"); const entries = sliceBranchRange(snapshot, start, end); if (!entries) throw new Error("原文范围不在当前分支"); return sanitizeSensitiveText(entries.map((e) => { const m = extractMessageText(e); return m ? `${m.role}: ${m.text}` : ""; }).filter(Boolean).join("\n"), 4000); }),
  make("search_memory_candidates", "只读搜索长期记忆候选", (ctx, a) => { const limit = a.limit ?? 10; const facts = a.layer !== "events" ? ctx.factStore.searchByFts(ctx.agentId, a.query, limit) : []; const events = a.layer !== "facts" ? ctx.eventStore.searchByFts(ctx.agentId, a.query, { limit }) : []; return sanitizeToolResult({ facts: facts.map((f) => ({ id: f.id, fact: f.fact, strength: f.retentionStrength, confidence: f.confidence, refs: f.sourceRefs })), events: events.map((e) => ({ id: e.id, summary: e.summary, sessionId: e.sessionId })) }, 4000); }),
  make("propose_fact", "提议创建事实", (ctx, a) => proposal(ctx, "create_fact", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact" })),
  make("propose_strength_change", "提议调整事实固化强度", (ctx, a) => { const id = strId(a.memoryId); const f = ctx.factStore.getById(Number(a.memoryId)); return proposal(ctx, "strength_change", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact", targetId: id, ...(f ? { previousState: { retentionStrength: f.retentionStrength, status: f.status, revision: f.updatedAt } } : {}) }); }),
  make("propose_supersede", "提议以新事实取代旧事实", (ctx, a) => { const id = strId(a.payload.supersededFactId); const f = ctx.factStore.getById(Number(a.payload.supersededFactId)); return proposal(ctx, "supersede", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact", targetId: id, ...(f ? { previousState: { fact: f.fact, status: f.status, revision: f.updatedAt } } : {}) }); }),
  make("propose_merge", "提议合并重复事实", (ctx, a) => proposal(ctx, "merge", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: "fact" })),
  make("propose_forget", "提议认知遗忘", (ctx, a) => proposal(ctx, "forget", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence, targetType: a.payload.targetType, targetId: a.payload.targetId })),
  make("propose_longterm_projection", "提议生成长期投影", (ctx, a) => proposal(ctx, "longterm_projection", { payload: a.payload, evidenceRefs: a.evidenceRefs, reason: a.reason, confidence: a.confidence })),
  make("report_run", "报告整理结果并结束运行", (_ctx, a) => ({ summary: sanitizeSensitiveText(a.summary, 2000), ...(a.issues ? { issues: a.issues.map((x) => sanitizeSensitiveText(x, 500)) } : {}) })),
];
export const memoryAgentToolMap = new Map<MemoryToolName, MemoryAgentTool>(memoryAgentTools.map((t) => [t.name, t]));
export function validateToolArgs(name: MemoryToolName, value: unknown): boolean { return Value.Check(ToolArgSchemas[name], value); }
