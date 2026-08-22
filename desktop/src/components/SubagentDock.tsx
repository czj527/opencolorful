import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { DesktopDataSource, SubagentThreadCard, SubagentTranscriptView } from "../data/source.js";
import "./subagent-dock.css";

type SenderKind = "parent" | "subagent" | "system" | "other";

function senderKind(sender: string): SenderKind {
  const prefix = sender.split(":")[0];
  if (prefix === "parent_agent") return "parent";
  if (prefix === "subagent") return "subagent";
  if (prefix === "system") return "system";
  return "other";
}

/** 运行状态语义色：succeeded/completed → ok，running/进行中 → warn，失败 → err */
function statusClass(status: string | null): string {
  if (status === "succeeded" || status === "completed") return "st-ok";
  if (status === "running" || status === "open" || status === "closing") return "st-warn";
  if (status === "failed" || status === "error") return "st-err";
  return "st-muted";
}

/** thread 状态 badge：open → ok，closing → warn，closed → muted */
function threadBadgeClass(status: string): string {
  if (status === "open") return "badge-ok";
  if (status === "closing") return "badge-warn";
  return "badge-muted";
}

/** 消息 type badge */
function typeBadgeClass(type: string): string {
  if (type === "task") return "badge-ok";
  if (type === "progress") return "badge-warn";
  if (type === "result") return "badge-ok";
  return "badge-muted";
}

function formatKB(sizeBytes: number | null): string {
  if (sizeBytes === null) return "—";
  const kb = sizeBytes / 1024;
  return `${Number.isInteger(kb) ? String(kb) : kb.toFixed(1)} KB`;
}

interface SubagentDockProps {
  readonly source: DesktopDataSource;
  readonly agentId: string;
  readonly sessionId: string | null;
}

export function SubagentDock({ source, agentId, sessionId }: SubagentDockProps) {
  const [threads, setThreads] = useState<readonly SubagentThreadCard[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<SubagentTranscriptView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    if (sessionId === null) return;
    setError(null);
    setThreads(null);
    source.listSubagentThreads(agentId, sessionId)
      .then((next) => setThreads(next))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Subagent 运行记录加载失败"));
  }, [source, agentId, sessionId]);

  const loadDetail = useCallback(() => {
    if (sessionId === null || selectedId === null) return;
    setError(null);
    setTranscript(null);
    source.getSubagentTranscript(agentId, sessionId, selectedId)
      .then(setTranscript)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Subagent 详情加载失败"));
  }, [source, agentId, sessionId, selectedId]);

  useEffect(() => {
    setSelectedId(null);
    setTranscript(null);
    if (sessionId === null) return;
    loadList();
  }, [sessionId, loadList]);

  useEffect(() => {
    if (sessionId === null || selectedId === null) return;
    loadDetail();
  }, [sessionId, selectedId, loadDetail]);

  if (sessionId === null) {
    return (
      <div className="dock-panel">
        <p className="page-empty">新会话还没有 Subagent；主 Agent 可在对话中按需创建</p>
      </div>
    );
  }

  if (selectedId !== null) {
    return (
      <div className="dock-panel">
        {error !== null && (
          <div className="chat-error" role="alert">
            {error}
            <button type="button" className="inline-action" onClick={loadDetail}>重试</button>
          </div>
        )}
        {transcript === null && error === null && <p className="page-empty">正在加载详情…</p>}
        {transcript !== null && (
          <div className="subagent-dock">
            <div className="subagent-dock-top">
              <button type="button" className="subagent-back" onClick={() => setSelectedId(null)}>
                <ArrowLeft size={13} />返回列表
              </button>
              <span className="subagent-title">{transcript.title}</span>
              <button type="button" className="icon-btn" aria-label="刷新" title="刷新" onClick={loadDetail}>
                <RefreshCw size={14} />
              </button>
            </div>

            {transcript.taskObjective !== null && (
              <p className="subagent-objective">{transcript.taskObjective}</p>
            )}

            <section>
              <h3 className="subagent-section-title">Runs · {transcript.runs.length}</h3>
              <div className="subagent-runs">
                {transcript.runs.map((run) => (
                  <div className="subagent-run" key={run.runId}>
                    <div className="subagent-run-head">
                      <span className={`st-run ${statusClass(run.status)}`}>{run.status}</span>
                      <span className="subagent-run-id">{run.runId}</span>
                    </div>
                    <div className="subagent-run-stats">
                      <span>tools {run.toolCallCount}</span>
                      <span>tokens {run.totalTokens}</span>
                    </div>
                    {run.resultSummary !== null && <p className="subagent-run-summary">{run.resultSummary}</p>}
                  </div>
                ))}
                {transcript.runs.length === 0 && <p className="page-empty">暂无 Run 记录</p>}
              </div>
            </section>

            <section>
              <h3 className="subagent-section-title">消息 · {transcript.messages.length}</h3>
              <div className="subagent-messages">
                {transcript.messages.map((message) => {
                  const kind = senderKind(message.sender);
                  return (
                    <div className="subagent-msg" key={message.id}>
                      <div className="subagent-msg-head">
                        <span className={`subagent-msg-sender is-${kind}`}>{message.sender}</span>
                        <span className={`badge ${typeBadgeClass(message.type)}`}>{message.type}</span>
                      </div>
                      <p className="subagent-msg-text">{message.text}</p>
                    </div>
                  );
                })}
                {transcript.messages.length === 0 && <p className="page-empty">暂无消息</p>}
              </div>
            </section>

            <section>
              <h3 className="subagent-section-title">Artifacts · {transcript.artifacts.length}</h3>
              <div className="subagent-artifacts">
                {transcript.artifacts.map((artifact) => (
                  <div className="subagent-artifact" key={artifact.artifactId}>
                    <span className="subagent-artifact-name">{artifact.name}</span>
                    <span className="subagent-artifact-kind">{artifact.kind}</span>
                    <span className="subagent-artifact-size">{formatKB(artifact.sizeBytes)}</span>
                  </div>
                ))}
                {transcript.artifacts.length === 0 && <p className="page-empty">暂无 Artifact</p>}
              </div>
            </section>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dock-panel">
      {error !== null && (
        <div className="chat-error" role="alert">
          {error}
          <button type="button" className="inline-action" onClick={loadList}>重试</button>
        </div>
      )}
      {threads === null && error === null && <p className="page-empty">正在加载 Subagent 运行记录…</p>}
      {threads !== null && threads.length === 0 && <p className="page-empty">当前会话还没有 Subagent 运行记录</p>}
      {threads !== null && threads.length > 0 && (
        <div className="subagent-list">
          {threads.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              className="subagent-card"
              onClick={() => setSelectedId(thread.threadId)}
            >
              <span className="subagent-card-top">
                <span className="subagent-card-title">{thread.title}</span>
                <span className={`badge ${threadBadgeClass(thread.status)}`}>{thread.status}</span>
              </span>
              <span className="subagent-card-model">{thread.model}</span>
              {thread.resultSummary !== null && <span className="subagent-card-summary clamp-2">{thread.resultSummary}</span>}
              <span className="subagent-card-foot">
                <span className={`st-run ${statusClass(thread.latestRunStatus)}`}>{thread.latestRunStatus ?? "—"}</span>
                <span>{thread.artifactCount} artifact</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
