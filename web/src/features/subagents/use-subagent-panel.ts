// ═══════════════════════════════════════════════════════════════
// Phase 14 T8：右侧只读面板数据（plans/phase-14.md §21.2 / §17.4）
//
// 职责：
// - 打开时拉取 Thread transcript（thread + runs + 消息首页 + artifacts +
//   TaskBrief/ContextPacket 快照），消息分页 cursor 与 SSE cursor 分离；
// - 订阅 `subagent:<threadId>` 流：snapshot（初始/ reset 重建基线，整体替换）、
//   message（按 sequence 去重追加）、run（按 runId upsert）、tool（transient，
//   只走面板流）、thread（更新 Thread 状态）；
// - 断线重连由 SubagentStreamClient 管理（sinceSeq 游标 + seq 去重），
//   stale cursor → reset + snapshot 重建，UI 不重复追加；
// - Run 选择（selectedRunId）：null=全部时间线，否则按 Run 过滤消息。
// ═══════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api-client.js";
import type {
  SubagentMessagePage,
  SubagentOwnership,
  SubagentRunId,
  SubagentThreadId,
  SubagentThreadTranscript,
  SubagentToolActivityView,
} from "../../lib/types.js";
import { SubagentStreamClient } from "./subagent-stream.js";

export interface UseSubagentPanelOptions {
  readonly api: ApiClient;
  readonly threadId: SubagentThreadId | null;
  readonly ownership: SubagentOwnership | null;
  readonly enabled: boolean;
}

export interface SubagentPanelState {
  readonly transcript: SubagentThreadTranscript | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** 面板流连接状态（断线重连中时展示轻提示，不阻断历史查看） */
  readonly streamConnected: boolean;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** transient Tool 摘要（§17.2：只走面板流，不落 durable；按 toolCallId 更新） */
  readonly tools: ReadonlyMap<string, SubagentToolActivityView>;
  readonly selectedRunId: SubagentRunId | null;
  readonly selectRun: (runId: SubagentRunId | null) => void;
  readonly loadOlder: () => void;
}

export function useSubagentPanel(options: UseSubagentPanelOptions): SubagentPanelState {
  const { api, threadId, ownership, enabled } = options;

  const [transcript, setTranscript] = useState<SubagentThreadTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<SubagentRunId | null>(null);
  const [tools, setTools] = useState<ReadonlyMap<string, SubagentToolActivityView>>(new Map());

  const streamRef = useRef<SubagentStreamClient | null>(null);
  // REST 分页游标（transcript 分页 cursor；SSE 事件 cursor 由 stream 内部维护）
  const loadedSeqRef = useRef(0);
  // SSE 消息去重：sequence 集合（snapshot 重建时重置）
  const seenSequencesRef = useRef(new Set<number>());
  const transcriptRef = useRef<SubagentThreadTranscript | null>(null);
  transcriptRef.current = transcript;

  const resetState = useCallback(() => {
    setTranscript(null);
    setError(null);
    setHasOlder(false);
    setLoadingOlder(false);
    setSelectedRunId(null);
    setTools(new Map());
    loadedSeqRef.current = 0;
    seenSequencesRef.current.clear();
  }, []);

  // Thread 切换：释放旧流 + 重置 + 拉取新 transcript
  useEffect(() => {
    streamRef.current?.dispose();
    streamRef.current = null;
    setStreamConnected(false);
    resetState();
    if (threadId === null || ownership === null || !enabled) return undefined;
    const owner = ownership;
    let cancelled = false;

    setLoading(true);
    void api.getSubagentTranscript(threadId, owner, { limit: 200 })
      .then((result) => {
        if (cancelled) return;
        loadedSeqRef.current = result.nextMessageSequence;
        seenSequencesRef.current = new Set(result.messages.map((message) => message.sequence));
        setTranscript(result);
        setHasOlder(result.truncated);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Subagent 面板加载失败");
        setLoading(false);
      });

    const client = new SubagentStreamClient({
      baseUrl: "",
      threadId,
      ownership: owner,
      onEvent: (event) => {
        if (cancelled) return;
        if (event.type === "snapshot") {
          // 初始快照 / reset 重建基线：整体替换（UI 不重复追加）
          loadedSeqRef.current = event.transcript.nextMessageSequence;
          seenSequencesRef.current = new Set(event.transcript.messages.map((message) => message.sequence));
          setTranscript(event.transcript);
          setHasOlder(event.transcript.truncated);
          return;
        }
        if (event.type === "reset") {
          // stale cursor：等待随后的 snapshot 重建，无需其他动作
          return;
        }
        applyEnvelope(event.envelope.event.kind === "message"
          ? { kind: "message", message: event.envelope.event.message }
          : event.envelope.event.kind === "run"
            ? { kind: "run", run: event.envelope.event.run }
            : event.envelope.event.kind === "tool"
              ? { kind: "tool", tool: event.envelope.event.tool }
              : { kind: "thread", status: event.envelope.event.status, at: event.envelope.event.at });
      },
      onStatusChange: (status) => setStreamConnected(status === "open"),
    });
    streamRef.current = client;
    client.connect();

    return () => {
      cancelled = true;
      streamRef.current?.dispose();
      streamRef.current = null;
    };
  }, [api, threadId, ownership, enabled, resetState]);

  // 流事件应用到 transcript（message 按 sequence 去重；run 按 runId upsert；
  // tool 为 transient；thread 更新状态与最近活动时间）
  const applyEnvelope = useCallback((event: {
    readonly kind: "message" | "run" | "tool" | "thread";
    readonly message?: import("../../lib/types.js").SubagentTranscriptMessage;
    readonly run?: import("../../lib/types.js").SubagentRunRecord;
    readonly tool?: SubagentToolActivityView;
    readonly status?: import("../../lib/types.js").SubagentThreadStatus;
    readonly at?: string;
  }) => {
    const current = transcriptRef.current;
    if (event.kind === "message" && event.message !== undefined) {
      const sequence = event.message.sequence;
      if (seenSequencesRef.current.has(sequence)) return;
      seenSequencesRef.current.add(sequence);
      const next = current === null ? null : {
        ...current,
        messages: [...current.messages, event.message],
        nextMessageSequence: Math.max(current.nextMessageSequence, sequence),
        thread: {
          ...current.thread,
          lastActivityAt: event.message.createdAt > current.thread.lastActivityAt
            ? event.message.createdAt
            : current.thread.lastActivityAt,
        },
      };
      if (next !== null) setTranscript(next);
      return;
    }
    if (event.kind === "run" && event.run !== undefined) {
      if (current === null) return;
      const exists = current.runs.some((run) => run.runId === event.run!.runId);
      const runs = exists
        ? current.runs.map((run) => (run.runId === event.run!.runId ? event.run! : run))
        : [...current.runs, event.run];
      setTranscript({
        ...current,
        runs,
        thread: {
          ...current.thread,
          lastActivityAt: event.run.updatedAt > current.thread.lastActivityAt
            ? event.run.updatedAt
            : current.thread.lastActivityAt,
        },
      });
      return;
    }
    if (event.kind === "tool" && event.tool !== undefined) {
      setTools((prev) => {
        const next = new Map(prev);
        next.set(event.tool!.toolCallId, event.tool!);
        return next;
      });
      return;
    }
    if (event.kind === "thread" && current !== null && event.status !== undefined) {
      setTranscript({
        ...current,
        thread: {
          ...current.thread,
          status: event.status,
          ...(event.status === "closed" && current.thread.closedAt === null
            ? { closedAt: event.at ?? null }
            : {}),
        },
      });
    }
  }, []);

  // 分页：按 loadedSeq 续拉（与 SSE 事件 cursor 分离；重复 sequence 去重）
  const loadOlder = useCallback(() => {
    if (threadId === null || ownership === null || loadingOlder) return;
    const owner = ownership;
    setLoadingOlder(true);
    void api.getSubagentMessages(threadId, owner, { afterSequence: loadedSeqRef.current, limit: 200 })
      .then((page: SubagentMessagePage) => {
        const current = transcriptRef.current;
        if (current === null) return;
        const fresh = page.items.filter((message) => !seenSequencesRef.current.has(message.sequence));
        for (const message of page.items) seenSequencesRef.current.add(message.sequence);
        loadedSeqRef.current = page.nextSequence;
        setTranscript({
          ...current,
          messages: [...fresh, ...current.messages],
          nextMessageSequence: page.nextSequence,
          truncated: page.truncated,
        });
        setHasOlder(page.truncated);
      })
      .catch(() => {
        // 分页失败不打断面板；保留"加载更早"按钮以便重试
      })
      .finally(() => setLoadingOlder(false));
  }, [api, threadId, ownership, loadingOlder]);

  return {
    transcript,
    loading,
    error,
    streamConnected,
    hasOlder,
    loadingOlder,
    tools,
    selectedRunId,
    selectRun: setSelectedRunId,
    loadOlder,
  };
}
