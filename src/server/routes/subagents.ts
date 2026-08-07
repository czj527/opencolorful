import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import Value from "typebox/value";

import {
  SubagentThreadIdSchema,
  type SubagentArtifactId,
  type SubagentThreadId,
} from "../../contracts/subagents.js";
import { SubagentArtifactFileService } from "../../runtime/subagents/transcript/artifact-files.js";
import { SubagentReplayStore } from "../../runtime/subagents/transcript/replay-store.js";
import { SubagentTranscriptView, SUBAGENT_TRANSCRIPT_PAGE_MAX } from "../../runtime/subagents/transcript/transcript-view.js";
import { SubagentStoreError } from "../../runtime/subagents/stores/errors.js";
import type { SubagentOwnership } from "../../runtime/subagents/stores/types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T7：Subagent 只读 API（plans/phase-14.md §17 / §20.3）
//
// - GET  /api/subagents/threads/:threadId/transcript —— Thread transcript 投影
//   （thread + runs + 消息首页 + artifacts + TaskBrief/ContextPacket 快照；
//   消息分页 afterSequence/limit，与 SSE event cursor 分离，§17.4）；
// - GET  /api/subagents/threads/:threadId/messages —— 消息分页续拉；
// - GET  /api/subagents/threads/:threadId/artifacts —— Artifact 元数据列表；
// - GET  /api/subagents/artifacts/:artifactId/content —— 受控下载
//   （nosniff + 安全 Content-Disposition；HTML/SVG 强制 octet-stream，
//   不在同源顶层直接执行，§17.3；contentHash 校验，失败 409 +
//   subagent.artifact.integrity_failed）；
// - GET  /api/subagents/threads/:threadId/stream —— `subagent:<threadId>` SSE
//   实时流：SQLite 持久 sequence（重启严格递增），Last-Event-ID 断线重连
//   不重不漏；stale cursor → reset + 当前 Thread snapshot（§17.4）。
//
// 归属（§22.1）：所有端点要求 ?ownerAgentId=&parentSessionId=（T8 面板从
// 主对话卡片上下文携带）；不匹配抛 subagent_ownership_denied（403），
// 不存在 subagent_not_found（404）。
// ═══════════════════════════════════════════════════════════════

export interface SubagentRouteDeps {
  readonly transcriptView: SubagentTranscriptView;
  readonly artifactFiles: SubagentArtifactFileService;
  readonly replayStore: SubagentReplayStore;
  /** SSE snapshot 上限（stale reset 时发送的消息数） */
  readonly snapshotMaxMessages?: number;
}

const OWNER_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function parseOwnership(context: { req: { query(key: string): string | undefined } }): SubagentOwnership | null {
  const ownerAgentId = context.req.query("ownerAgentId");
  const parentSessionId = context.req.query("parentSessionId");
  if (ownerAgentId === undefined || parentSessionId === undefined) return null;
  if (!OWNER_ID_PATTERN.test(ownerAgentId) || !OWNER_ID_PATTERN.test(parentSessionId)) return null;
  return { ownerAgentId, parentSessionId };
}

function parseThreadId(raw: string): SubagentThreadId | null {
  if (!Value.Check(SubagentThreadIdSchema, raw)) return null;
  return raw as SubagentThreadId;
}

function parseOptionalInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** afterSequence 解析：缺省 0（从头开始）；显式值钳制 ≥ 0（分页游标，§17.4） */
function parseAfterSequence(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, 1_000_000_000) : 0;
}

function parseReplayCursor(context: { req: { header(name: string): string | undefined; query(key: string): string | undefined } }): number {
  const lastEventId = context.req.header("Last-Event-ID");
  if (lastEventId !== undefined && /^\d+$/.test(lastEventId.trim())) {
    const seq = Number(lastEventId.trim());
    if (Number.isInteger(seq) && seq >= 0) return seq;
  }
  const sinceSeq = context.req.query("sinceSeq");
  if (sinceSeq !== undefined && /^\d+$/.test(sinceSeq)) {
    const seq = Number(sinceSeq);
    if (Number.isInteger(seq) && seq >= 0) return seq;
  }
  return 0;
}

/** 归属查询参数缺失/非法 → 400；正常返回 ownership */
function requireOwnership(context: { req: { query(key: string): string | undefined } }): SubagentOwnership | null {
  return parseOwnership(context);
}

export { parseOwnership as parseSubagentOwnership };

export function registerSubagentRoutes(app: Hono, deps: SubagentRouteDeps): void {
  const snapshotMax = deps.snapshotMaxMessages ?? 200;

  // ─── transcript 投影 ───────────────────────────────────────────

  app.get("/api/subagents/threads/:threadId/transcript", (context) => {
    const threadId = parseThreadId(context.req.param("threadId"));
    if (threadId === null) {
      return context.json({ code: "INVALID_INPUT", message: "threadId 不合法" }, 400);
    }
    const ownership = requireOwnership(context);
    if (ownership === null) {
      return context.json({ code: "INVALID_INPUT", message: "缺少 ownerAgentId/parentSessionId 归属参数" }, 400);
    }
    const afterSequence = parseAfterSequence(context.req.query("afterSequence") ?? undefined);
    const limit = parseOptionalInt(context.req.query("limit") ?? undefined, 100, SUBAGENT_TRANSCRIPT_PAGE_MAX);
    try {
      const transcript = deps.transcriptView.getTranscript(threadId, ownership, { afterSequence, limit });
      return context.json(transcript);
    } catch (error) {
      return mapSubagentError(context, error);
    }
  });

  // ─── 消息分页（transcript 分页 cursor，§17.4）───────────────────

  app.get("/api/subagents/threads/:threadId/messages", (context) => {
    const threadId = parseThreadId(context.req.param("threadId"));
    if (threadId === null) {
      return context.json({ code: "INVALID_INPUT", message: "threadId 不合法" }, 400);
    }
    const ownership = requireOwnership(context);
    if (ownership === null) {
      return context.json({ code: "INVALID_INPUT", message: "缺少 ownerAgentId/parentSessionId 归属参数" }, 400);
    }
    const afterSequence = parseAfterSequence(context.req.query("afterSequence") ?? undefined);
    const limit = parseOptionalInt(context.req.query("limit") ?? undefined, 100, SUBAGENT_TRANSCRIPT_PAGE_MAX);
    try {
      const page = deps.transcriptView.listMessages(threadId, ownership, { afterSequence, limit });
      return context.json(page);
    } catch (error) {
      return mapSubagentError(context, error);
    }
  });

  // ─── Artifact 列表 ─────────────────────────────────────────────

  app.get("/api/subagents/threads/:threadId/artifacts", (context) => {
    const threadId = parseThreadId(context.req.param("threadId"));
    if (threadId === null) {
      return context.json({ code: "INVALID_INPUT", message: "threadId 不合法" }, 400);
    }
    const ownership = requireOwnership(context);
    if (ownership === null) {
      return context.json({ code: "INVALID_INPUT", message: "缺少 ownerAgentId/parentSessionId 归属参数" }, 400);
    }
    try {
      const artifacts = deps.artifactFiles.listByThread(threadId, ownership);
      return context.json({ items: artifacts });
    } catch (error) {
      return mapSubagentError(context, error);
    }
  });

  // ─── Artifact 受控下载（nosniff + Content-Disposition + 完整性）──

  app.get("/api/subagents/artifacts/:artifactId/content", (context) => {
    const raw = context.req.param("artifactId");
    if (!/^saa_[A-Za-z0-9_-]{8,128}$/.test(raw)) {
      return context.json({ code: "INVALID_INPUT", message: "artifactId 不合法" }, 400);
    }
    const artifactId = raw as SubagentArtifactId;
    const ownership = requireOwnership(context);
    if (ownership === null) {
      return context.json({ code: "INVALID_INPUT", message: "缺少 ownerAgentId/parentSessionId 归属参数" }, 400);
    }
    try {
      const { record, content } = deps.artifactFiles.readArtifactContent(artifactId, ownership);
      const mimeType = record.mimeType ?? "application/octet-stream";
      // §17.3：HTML/SVG 等主动内容不在同源顶层直接执行 → 一律 octet-stream + attachment
      const isActiveContent = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/svg)/i.test(mimeType);
      const contentType = isActiveContent ? "application/octet-stream" : mimeType;
      const fileName = safeContentDispositionName(record.name);
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(content.byteLength),
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `attachment; filename="artifact"; filename*=UTF-8''${fileName}`,
          "Cache-Control": "private, no-store",
        },
      });
    } catch (error) {
      return mapSubagentError(context, error);
    }
  });

  // ─── `subagent:<threadId>` SSE 实时流（§17.4）──────────────────

  app.get("/api/subagents/threads/:threadId/stream", (context) => {
    const threadId = parseThreadId(context.req.param("threadId"));
    if (threadId === null) {
      return context.json({ code: "INVALID_INPUT", message: "threadId 不合法" }, 400);
    }
    const ownership = requireOwnership(context);
    if (ownership === null) {
      return context.json({ code: "INVALID_INPUT", message: "缺少 ownerAgentId/parentSessionId 归属参数" }, 400);
    }
    const cursor = parseReplayCursor(context);
    // 归属预检：Thread 不存在/跨归属在连接建立前拒绝（而不是挂一个空流）
    try {
      const thread = deps.transcriptView.listThreads(ownership, 500);
      if (!thread.some((record) => record.threadId === threadId)) {
        return context.json({ code: "NOT_FOUND", message: "subagent thread 不存在" }, 404);
      }
    } catch (error) {
      return mapSubagentError(context, error);
    }

    return streamSSE(context, async (stream) => {
      const abortSignal = context.req.raw.signal;
      let aborted = false;
      let replaying = true;
      const pendingLive: Array<import("../../runtime/subagents/transcript/replay-store.js").SubagentReplayEnvelope> = [];
      const deliveredSeqs = new Set<number>();
      let writeQueue = Promise.resolve();

      const enqueue = (envelope: import("../../runtime/subagents/transcript/replay-store.js").SubagentReplayEnvelope): void => {
        if (aborted || envelope.threadId !== threadId || deliveredSeqs.has(envelope.seq)) return;
        deliveredSeqs.add(envelope.seq);
        writeQueue = writeQueue
          .then(() =>
            stream.writeSSE({
              id: String(envelope.seq),
              event: envelope.event.kind,
              data: JSON.stringify(envelope.event),
            }),
          )
          .catch(() => {
            aborted = true;
          });
      };

      abortSignal.addEventListener("abort", () => { aborted = true; }, { once: true });

      // 先订阅再读快照，避免 replay 与实时广播之间丢事件窗口（§17.4）
      const unsubscribe = deps.replayStore.subscribe((envelope) => {
        if (envelope.threadId !== threadId || aborted) return;
        if (replaying) {
          pendingLive.push(envelope);
        } else {
          enqueue(envelope);
        }
      });

      try {
        // 1. stale cursor 检查（§17.4：reset + 当前 Thread snapshot）
        const replay = deps.replayStore.getSince(threadId, cursor);
        if (replay.reset && cursor > 0) {
          await stream.writeSSE({
            event: "reset",
            data: JSON.stringify({
              reason: "stream 已截断或服务重启，请以 snapshot 重建（UI 不重复追加）",
              lastSeq: deps.replayStore.latestSeq(threadId),
            }),
          });
        }
        // 2. snapshot（cursor=0 时作为初始状态；reset 时作为重建基线）
        if (cursor === 0 || replay.reset) {
          const transcript = deps.transcriptView.getTranscript(threadId, ownership, { limit: snapshotMax });
          await stream.writeSSE({
            event: "snapshot",
            data: JSON.stringify(transcript),
          });
        }
        // 3. 环形缓冲重放（不重不漏；UI 按 seq 去重）
        for (const envelope of replay.events) enqueue(envelope);
        await writeQueue;
        replaying = false;
        for (const envelope of pendingLive) enqueue(envelope);
        pendingLive.length = 0;
        await writeQueue;
        if (aborted) return;

        // 4. 实时跟随（保持连接；断线由 EventSource 自动重连 + Last-Event-ID）
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            abortSignal.removeEventListener("abort", onAbort);
            resolve();
          };
          if (aborted) {
            onAbort();
          } else {
            abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        });
        await writeQueue;
      } finally {
        replaying = false;
        unsubscribe();
      }
    });
  });
}

/** §22.1 归属/查找错误映射（跨归属 → 403，不存在 → 404，其他 → 500 稳定码） */
function mapSubagentError(
  context: { json(body: unknown, status?: number): Response },
  error: unknown,
): Response {
  if (error instanceof SubagentStoreError) {
    if (error.code === "subagent_ownership_denied") {
      return context.json({ code: "FORBIDDEN", message: "跨 Agent/Session 归属拒绝" }, 403);
    }
    if (error.code === "subagent_not_found") {
      return context.json({ code: "NOT_FOUND", message: "资源不存在" }, 404);
    }
    if (error.code === "subagent_artifact_integrity_failed") {
      return context.json({ code: "subagent_artifact_integrity_failed", message: error.message }, 409);
    }
    return context.json({ code: error.code, message: error.message.slice(0, 500) }, 500);
  }
  return context.json({ code: "INTERNAL_ERROR", message: "subagent API 内部错误" }, 500);
}

/** Content-Disposition filename* 安全化（RFC 5987；去掉控制字符/引号/路径分隔符） */
function safeContentDispositionName(name: string): string {
  const sanitized = name
    .replace(/[\\/]/g, "_")
    .replace(/["\r\n;]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 120);
  return encodeURIComponent(sanitized || "artifact");
}
