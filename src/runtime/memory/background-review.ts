// ═══════════════════════════════════════════════════════════════
// 后台复盘（切片 1.75 T14，hermes background_review 轻量版）
//
// 每轮 turn.completed 后，用工具型 LLM（completeText utility 通道）重放最近
// 对答，判断有没有值得进入长期记忆的内容；产出 remember 意图追加到
// memory_journal（actor=background_review），整理审批仍由记忆 Agent +
// MemoryPolicy 负责——本服务不直写长期库。
//
// 参考出处：references/hermes-agent/agent/background_review.py（只取记忆维度；
// fork 全 agent 模式改为单次 LLM 调用）。"Nothing to save" 是合法答案。
//
// 与 MemoryTicker 的关系：ticker 管"近期上下文传送带"（每 10 轮摘要），
// 本服务管"每轮一次的长期记忆候选发现"；两者共用 per-agent 串行 tail 与
// 降级静默模式，互不阻塞。
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

import type { PlatformEventEnvelope } from "../../contracts/events.js";
import type { EventReplayStore } from "../event-replay-store.js";
import type { SessionService } from "../session-service.js";
import type { MemoryJournalStore } from "../../storage/memory/journal-store.js";
import type { PinnedMemoryStore } from "../../storage/memory/pinned-store.js";
import { extractMessageText, readSessionBranchSnapshot } from "./jsonl-branch-reader.js";
import { instrument } from "../../observability/instrument.js";

export interface BackgroundReviewOptions {
  /** 复盘输入的最近消息条数上限（默认 12） */
  readonly maxMessages?: number;
  /** 对话摘录总字符预算（默认 4000） */
  readonly transcriptCharBudget?: number;
  /** 已有记忆快照字符上限（默认 1500） */
  readonly memorySnapshotChars?: number;
  /** 提示词中携带的最近待处理意图条数（默认 10，防重复提案） */
  readonly pendingIntentsLimit?: number;
}

export interface BackgroundReviewDeps {
  readonly replayStore: EventReplayStore;
  readonly sessionService: Pick<SessionService, "getView">;
  readonly journalStore: MemoryJournalStore;
  readonly pinnedStore: PinnedMemoryStore;
  /** agents 根目录，用于定位 <agentId>/memory/memory.md */
  readonly agentsDir: string;
  readonly sessionPathResolver: (sessionId: string) => string;
  readonly completeText: (
    agentId: string,
    req: { systemPrompt: string; prompt: string; maxTokens?: number },
  ) => Promise<string>;
  /** per-Agent 记忆设置（enabled / reviewEnabled 两个开关都取自这里） */
  readonly settingsResolver: (agentId: string) => { readonly enabled: boolean; readonly reviewEnabled: boolean };
  readonly options?: BackgroundReviewOptions;
}

export type BackgroundReviewStatus = "updated" | "skipped" | "degraded" | "failed";

export interface BackgroundReviewResult {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: BackgroundReviewStatus;
  readonly intentCount: number;
  readonly reason?: string;
}

/** 复盘产出的单条意图（LLM JSON 输出经防御式解析后的形状） */
interface ReviewIntent {
  readonly fact: string;
  readonly tags?: readonly string[];
  readonly validUntil?: string;
  readonly priority?: number;
}

const SYSTEM_PROMPT = [
  "你是记忆复盘员。每轮对话结束后，你重放最近的对答，判断有没有值得进入长期记忆的内容。",
  "",
  "值得记的（按优先级）：",
  "1. 用户的偏好与纠正（“以后别这样”“我喜欢…”这类会持续生效的要求）",
  "2. 用户的个人信息与环境事实（职业、设备、项目结构、长期约定）",
  "3. 需要长期在场的工作约定",
  "",
  "不要记的：琐碎信息、可轻易重新发现的事实、任务进度、临时状态、本轮已解决的瞬时错误。可复用的操作流程属于 skill 而非记忆。",
  "",
  "输出规则：",
  "- 只输出严格 JSON，不要输出任何其他文字：{\"intents\":[{\"fact\":\"...\",\"tags\":[\"...\"],\"priority\":1}]}",
  "- 每条 fact 是一句自包含的陈述，脱离对话上下文也能读懂；priority 1-5，5 最重要",
  "- 没有值得记的就输出 {\"intents\":[]}——这是完全合法的答案，但不要把它当默认答案",
  "- 下方“已有记忆/待处理意图”中已出现的内容不要重复提案",
].join("\n");

/** 从 LLM 输出中防御式提取意图列表；任何不合形都返回 null（调用方走降级） */
function parseReviewOutput(raw: string): readonly ReviewIntent[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const intents = (parsed as Record<string, unknown>)["intents"];
  if (!Array.isArray(intents)) return null;
  const results: ReviewIntent[] = [];
  for (const item of intents) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const fact = record["fact"];
    if (typeof fact !== "string" || fact.trim() === "") continue;
    const entry: { fact: string; tags?: string[]; validUntil?: string; priority?: number } = {
      fact: fact.trim().slice(0, 500),
    };
    if (Array.isArray(record["tags"])) {
      const tags = record["tags"].filter((t): t is string => typeof t === "string");
      if (tags.length > 0) entry.tags = tags.slice(0, 8);
    }
    if (typeof record["validUntil"] === "string" && record["validUntil"] !== "") {
      entry.validUntil = record["validUntil"];
    }
    if (typeof record["priority"] === "number" && Number.isFinite(record["priority"])) {
      entry.priority = Math.min(5, Math.max(1, Math.round(record["priority"])));
    }
    results.push(entry);
  }
  return results;
}

export class BackgroundReviewService {
  private readonly unsubscribe: () => void;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly queued = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: BackgroundReviewDeps) {
    this.unsubscribe = deps.replayStore.subscribe((event) => this.onEvent(event));
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
  }

  /** 测试/关闭前等待当前 per-agent 队列排空（与 MemoryTicker.flush 同语义） */
  async flush(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }

  private onEvent(event: PlatformEventEnvelope): void {
    if (this.stopped) return;
    if (event.type !== "turn.completed" || event.sessionId === null) return;
    const view = this.safeView(event.sessionId);
    if (!view?.agentId || view.archived) return;
    const settings = this.deps.settingsResolver(view.agentId);
    if (!settings.enabled || !settings.reviewEnabled) return;
    this.enqueue(view.agentId, event.sessionId);
  }

  private safeView(sessionId: string) {
    try {
      return this.deps.sessionService.getView(sessionId);
    } catch {
      return undefined;
    }
  }

  private enqueue(agentId: string, sessionId: string): void {
    const key = `${agentId}:${sessionId}`;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.process(agentId, sessionId);
        } finally {
          this.queued.delete(key);
        }
      });
    this.tails.set(agentId, next);
    void next.catch(() => undefined);
  }

  private async process(agentId: string, sessionId: string): Promise<BackgroundReviewResult> {
    // 后台新根 trace：per-agent tail 可能继承触发方 ALS，必须隔离（同 MemoryTicker）
    return instrument.runAsBackground(
      { operationId: `review-${agentId}-${sessionId}-${Date.now()}` },
      () => this.processInner(agentId, sessionId),
    );
  }

  private async processInner(agentId: string, sessionId: string): Promise<BackgroundReviewResult> {
    const lifecycle = instrument.startLifecycle({
      startEventName: "memory.review.started",
      actor: { kind: "scheduler", id: "background-review" },
      executor: { kind: "memory_agent", id: agentId },
      scope: { ownerAgentId: agentId, sessionId },
      operationId: `review-${agentId}-${sessionId}`,
      terminals: {
        completed: "memory.review.completed",
        degraded: "memory.review.degraded",
        failed: "memory.review.failed",
      },
    });
    const result = await this.review(agentId, sessionId);
    if (result.status === "failed") {
      lifecycle.fail(result.reason ?? "unknown");
    } else if (result.status === "degraded") {
      lifecycle.degraded(result.reason ?? "unknown");
    } else {
      lifecycle.complete({
        attributes: { intentCount: result.intentCount, ...(result.reason !== undefined ? { skipped: result.reason } : {}) },
      });
    }
    return result;
  }

  private async review(agentId: string, sessionId: string): Promise<BackgroundReviewResult> {
    const base = { sessionId, agentId, intentCount: 0 };
    const options = this.deps.options ?? {};
    const maxMessages = options.maxMessages ?? 12;
    const transcriptBudget = options.transcriptCharBudget ?? 4000;
    const snapshotChars = options.memorySnapshotChars ?? 1500;
    const pendingLimit = options.pendingIntentsLimit ?? 10;

    // ── 读会话快照 ──
    let sessionPath: string;
    try {
      sessionPath = this.deps.sessionPathResolver(sessionId);
    } catch {
      return { ...base, status: "skipped", reason: "session 未登记" };
    }
    const snapshot = readSessionBranchSnapshot(sessionPath);
    if (snapshot === null) return { ...base, status: "skipped", reason: "session 未持久化" };

    const texts = snapshot.entries
      .map((entry) => extractMessageText(entry))
      .filter((msg): msg is NonNullable<typeof msg> => msg !== null);
    const recent = texts.slice(-maxMessages);
    if (recent.length === 0) return { ...base, status: "skipped", reason: "无对答内容" };

    // ── 拼装输入（摘录超预算时从旧到新丢弃） ──
    const transcriptLines: string[] = [];
    let used = 0;
    for (const msg of [...recent].reverse()) {
      const line = `${msg.role === "user" ? "用户" : "助理"}: ${msg.text}`;
      if (used + line.length > transcriptBudget && transcriptLines.length > 0) break;
      transcriptLines.unshift(line);
      used += line.length;
    }

    const memorySnapshot = this.readMemorySnapshot(agentId, snapshotChars);
    const pinned = this.deps.pinnedStore.listByAgent(agentId).map((p) => p.content);
    const pending = this.deps.journalStore
      .listPending(agentId)
      .slice(-pendingLimit)
      .map((intent) => JSON.stringify(intent.payload));

    const prompt = [
      "## 已有记忆（节选）",
      memorySnapshot ?? "（空）",
      "",
      "## 置顶记忆",
      pinned.length > 0 ? pinned.join("\n") : "（空）",
      "",
      "## 待处理意图（最近）",
      pending.length > 0 ? pending.join("\n") : "（空）",
      "",
      "## 最近对答",
      transcriptLines.join("\n"),
    ].join("\n");

    // ── 工具型 LLM 调用（失败走降级，不阻塞主对话） ──
    let raw: string;
    try {
      raw = await this.deps.completeText(agentId, { systemPrompt: SYSTEM_PROMPT, prompt, maxTokens: 800 });
    } catch (cause) {
      return { ...base, status: "degraded", reason: cause instanceof Error ? cause.message : String(cause) };
    }

    const intents = parseReviewOutput(raw);
    if (intents === null) return { ...base, status: "degraded", reason: "复盘输出不是合法 JSON" };
    if (intents.length === 0) return { ...base, status: "updated" };

    for (const intent of intents) {
      const payload: Record<string, unknown> = { fact: intent.fact };
      if (intent.tags !== undefined) payload["tags"] = [...intent.tags];
      if (intent.validUntil !== undefined) payload["validUntil"] = intent.validUntil;
      this.deps.journalStore.appendIntent({
        id: crypto.randomUUID(),
        agentId,
        actor: "background_review",
        intentType: "remember",
        targetType: "fact",
        payload,
        ...(intent.priority !== undefined ? { priority: intent.priority } : {}),
      });
    }
    return { ...base, status: "updated", intentCount: intents.length };
  }

  /** 读 memory.md 快照（截断）；文件缺失返回 null */
  private readMemorySnapshot(agentId: string, budgetChars: number): string | null {
    try {
      const content = fs.readFileSync(path.join(this.deps.agentsDir, agentId, "memory", "memory.md"), "utf8").trim();
      if (content === "") return null;
      return content.length > budgetChars ? `${content.slice(0, budgetChars)}…` : content;
    } catch {
      return null;
    }
  }
}
