// ═══════════════════════════════════════════════════════════════
// Phase 14 T8：面板时间线与各只读视图（plans/phase-14.md §21.2 / §17.1）
//
// - Transcript timeline：TaskBrief、可见 assistant 文本（text parts）、
//   Tool/Plugin/Skill 行为（transient 流事件）、主 Agent Steer、input_required、
//   终态 Result；未知 future 消息/事件使用通用行，不使页面崩溃（§21.2）；
// - Tool 视图（§17.2）：脱敏摘要——工具名 / 输入输出摘要 / 状态 / 时长；
// - Steer 视图（§9.3）：主 Agent 纠偏列表——动作 / 指令 / 原因 / 是否保留已完成工作；
// - Result/Artifact 视图（§7.3）：disposition / summary / criteria / artifacts 列表。
// 不展示隐藏推理、系统提示或未脱敏的工具参数（§二）。
// ═══════════════════════════════════════════════════════════════

import { useState } from "react";
import { CheckCircle2, FileText, HelpCircle, MessageSquare, Navigation, XCircle } from "lucide-react";
import type {
  SubagentArtifactRecord,
  SubagentResultV1,
  SubagentSteerV1,
  SubagentTaskBriefV1,
  SubagentToolActivityView,
  SubagentTranscriptMessage,
} from "../../lib/types.js";
import {
  formatClock,
  formatDurationMs,
  shortHash,
  subagentResultDispositionText,
} from "./subagent-format.js";
import styles from "./SubagentPanel.module.css";

export const SUBAGENT_STEER_SCHEMA = "subagent.steer.v1";
export const SUBAGENT_RESULT_SCHEMA = "subagent.result.v1";
export const SUBAGENT_TASK_BRIEF_SCHEMA = "subagent.task_brief.v1";
export const SUBAGENT_CONTEXT_PACKET_SCHEMA = "subagent.context_packet.v1";

/** 从消息 parts 提取指定 schema 的 data value（跨进程输入按形状防御性解析） */
function dataValueOf(message: SubagentTranscriptMessage, schema: string): unknown {
  for (const part of message.parts) {
    if (part.kind === "data" && part.schema === schema) return part.value;
  }
  return undefined;
}

function textOf(message: SubagentTranscriptMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("\n");
}

function isSteer(value: unknown): value is SubagentSteerV1 {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<SubagentSteerV1>;
  return (
    typeof candidate.instruction === "string" &&
    typeof candidate.reason === "string" &&
    typeof candidate.preserveCompletedWork === "boolean" &&
    typeof candidate.action === "string"
  );
}

function isResult(value: unknown): value is SubagentResultV1 {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<SubagentResultV1>;
  return (
    typeof candidate.disposition === "string" &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.criteria)
  );
}

// ─── TaskBrief（§9.1 平台 Renderer 区块）─────────────────────────

function SectionList({ title, items }: { readonly title: string; readonly items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.briefSection}>
      <div className={styles.briefSectionTitle}>{title}</div>
      <ul className={styles.briefList}>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function TaskBriefBlock({ brief }: { readonly brief: SubagentTaskBriefV1 }) {
  return (
    <div className={styles.timelineBlock} data-testid="subagent-task-brief">
      <div className={styles.timelineBlockTitle}>任务简报</div>
      <div className={styles.briefObjective}>{brief.objective}</div>
      <SectionList title="[完成标准]" items={brief.successCriteria} />
      <SectionList title="[交付物]" items={brief.deliverables} />
      <SectionList title="[可用上下文]" items={brief.context} />
      <SectionList title="[约束]" items={brief.constraints} />
      <SectionList title="[非目标]" items={brief.nonGoals} />
      <div className={styles.briefMeta}>
        执行模式 {brief.executionMode} · 汇报 {brief.reporting.progress}
      </div>
    </div>
  );
}

// ─── Steer 视图（§9.3 主 Agent 纠偏）─────────────────────────────

export function SteerRow({ message }: { readonly message: SubagentTranscriptMessage }) {
  const rawSteer = dataValueOf(message, SUBAGENT_STEER_SCHEMA);
  const steer = isSteer(rawSteer) ? rawSteer : null;
  return (
    <div className={`${styles.timelineBlock} ${styles.steerBlock}`} data-testid={`steer-${message.sequence}`}>
      <div className={styles.timelineBlockTitle}>
        <Navigation size={12} aria-hidden="true" /> 主 Agent 纠偏
        <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
      </div>
      {steer !== null && (
        <div className={styles.steerMeta}>
          动作 {steer.action} · 投递 {steer.deliveryMode}
          {steer.preserveCompletedWork ? " · 保留已完成工作" : " · 不保留已完成工作"}
        </div>
      )}
      <div className={styles.steerInstruction}>
        {steer !== null ? steer.instruction : textOf(message)}
      </div>
      {steer !== null && steer.reason.length > 0 && (
        <div className={styles.steerReason}>原因：{steer.reason}</div>
      )}
    </div>
  );
}

// ─── Result 视图（§7.3 disposition / summary / criteria）─────────

export function ResultBlock({ message }: { readonly message: SubagentTranscriptMessage }) {
  const rawResult = dataValueOf(message, SUBAGENT_RESULT_SCHEMA);
  const result = isResult(rawResult) ? rawResult : null;
  return (
    <div className={`${styles.timelineBlock} ${styles.resultBlock}`} data-testid={`result-${message.sequence}`}>
      <div className={styles.timelineBlockTitle}>
        <CheckCircle2 size={12} aria-hidden="true" /> 结果
        <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
      </div>
      {result !== null ? (
        <>
          <div className={styles.resultDisposition}>
            {subagentResultDispositionText(result.disposition)}
            {result.recommendedNextAction !== undefined && (
              <span className={styles.resultNextAction}>建议下一步：{result.recommendedNextAction}</span>
            )}
          </div>
          <div className={styles.resultSummary}>{result.summary}</div>
          {result.criteria.length > 0 && (
            <ul className={styles.criteriaList}>
              {result.criteria.map((criterion, index) => (
                <li key={index} className={styles.criterionRow}>
                  <span className={`${styles.criterionStatus} ${styles[`criterionStatus-${criterion.status}`] ?? ""}`}>
                    {criterion.status}
                  </span>
                  <span>{criterion.criterion}</span>
                </li>
              ))}
            </ul>
          )}
          {result.unresolvedIssues.length > 0 && (
            <div className={styles.unresolved}>
              未解决问题：
              <ul>
                {result.unresolvedIssues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className={styles.resultSummary}>{textOf(message)}</div>
      )}
    </div>
  );
}

// ─── Tool 视图（§17.2 脱敏摘要）──────────────────────────────────

const TOOL_STATUS_TEXT: Readonly<Record<SubagentToolActivityView["status"], string>> = {
  started: "已开始",
  completed: "已完成",
  failed: "失败",
  denied: "已拒绝",
};

export function ToolSummaryRow({ tool }: { readonly tool: SubagentToolActivityView }) {
  return (
    <div className={`${styles.timelineBlock} ${styles.toolBlock}`} data-testid={`tool-${tool.toolCallId}`}>
      <div className={styles.toolHeader}>
        <span className={styles.toolName}>
          <FileText size={12} aria-hidden="true" /> {tool.toolName}
        </span>
        <span className={`${styles.toolStatus} ${styles[`toolStatus-${tool.status}`] ?? ""}`}>
          {TOOL_STATUS_TEXT[tool.status] ?? tool.status}
        </span>
        <span className={styles.timelineTime}>
          {tool.durationMs !== undefined && tool.durationMs !== null
            ? formatDurationMs(tool.durationMs)
            : formatClock(tool.startedAt)}
        </span>
      </div>
      {tool.inputSummary !== undefined && tool.inputSummary !== null && tool.inputSummary.length > 0 && (
        <div className={styles.toolSummary}>
          <span className={styles.toolSummaryLabel}>输入</span>
          <span>{tool.inputSummary}</span>
        </div>
      )}
      {tool.outputSummary !== undefined && tool.outputSummary !== null && tool.outputSummary.length > 0 && (
        <div className={styles.toolSummary}>
          <span className={styles.toolSummaryLabel}>输出</span>
          <span>{tool.outputSummary}</span>
        </div>
      )}
      {tool.reasonCode !== undefined && tool.reasonCode !== null && (
        <div className={styles.toolReason}>原因：{tool.reasonCode}</div>
      )}
    </div>
  );
}

// ─── 单条消息行（TaskBrief/assistant 文本/Steer/input_required/Result）─

/** 大段输出折叠并按需加载（§21.2）：超过阈值显示前段 + 展开/收起 */
const MESSAGE_COLLAPSE_CHARS = 2_000;

function ExpandableText({ text, testId }: { readonly text: string; readonly testId?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= MESSAGE_COLLAPSE_CHARS) {
    return <div className={styles.messageText}>{text}</div>;
  }
  return (
    <div className={styles.messageText} data-testid={testId}>
      {expanded ? text : `${text.slice(0, MESSAGE_COLLAPSE_CHARS)}…`}
      <button
        type="button"
        className={styles.expandToggle}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? "收起" : "展开全文"}
      </button>
    </div>
  );
}

function MessageRow({ message }: { readonly message: SubagentTranscriptMessage }) {
  switch (message.messageType) {
    case "task":
      return (
        <div className={styles.timelineBlock} data-testid={`message-${message.sequence}`}>
          <div className={styles.timelineBlockTitle}>
            <MessageSquare size={12} aria-hidden="true" /> 任务委派
            <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
          </div>
          <ExpandableText text={textOf(message)} />
        </div>
      );
    case "progress":
      return (
        <div className={styles.timelineBlock} data-testid={`message-${message.sequence}`}>
          <div className={styles.timelineBlockTitle}>
            <MessageSquare size={12} aria-hidden="true" /> 进展
            <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
          </div>
          <ExpandableText text={textOf(message)} />
        </div>
      );
    case "steer":
      return <SteerRow message={message} />;
    case "input_required":
      return (
        <div className={`${styles.timelineBlock} ${styles.inputBlock}`} data-testid={`input-required-${message.sequence}`}>
          <div className={styles.timelineBlockTitle}>
            <HelpCircle size={12} aria-hidden="true" /> 需要补充信息
            <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
          </div>
          <ExpandableText text={textOf(message)} />
        </div>
      );
    case "result":
      return <ResultBlock message={message} />;
    case "error":
      return (
        <div className={`${styles.timelineBlock} ${styles.errorBlock}`} data-testid={`message-${message.sequence}`}>
          <div className={styles.timelineBlockTitle}>
            <XCircle size={12} aria-hidden="true" /> 执行错误
            <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
          </div>
          <ExpandableText text={textOf(message)} />
        </div>
      );
    case "cancel":
    case "status": {
      const text = textOf(message);
      return (
        <div className={styles.timelineBlock} data-testid={`message-${message.sequence}`}>
          <div className={styles.timelineBlockTitle}>
            <MessageSquare size={12} aria-hidden="true" />
            {message.messageType === "cancel" ? "取消指令" : "状态"}
            <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
          </div>
          {text.length > 0 && <ExpandableText text={text} />}
        </div>
      );
    }
    default:
      // 未知 future 消息类型：通用行，不使页面崩溃（§21.2）
      return (
        <div className={styles.timelineBlock} data-testid={`message-${message.sequence}`}>
          <div className={styles.timelineBlockTitle}>
            <MessageSquare size={12} aria-hidden="true" /> 消息
            <span className={styles.timelineTime}>{formatClock(message.createdAt)}</span>
          </div>
          <ExpandableText text={textOf(message)} />
        </div>
      );
  }
}

export interface SubagentTimelineProps {
  readonly messages: readonly SubagentTranscriptMessage[];
  /** transient Tool 摘要（流事件，断线后不重放） */
  readonly tools: readonly SubagentToolActivityView[];
  readonly taskBrief: SubagentTaskBriefV1 | null;
}

/** 时间线：TaskBrief → 消息（含 Steer/input_required/Result）→ Tool 行为 */
export function SubagentTimeline({ messages, tools, taskBrief }: SubagentTimelineProps) {
  return (
    <div className={styles.timeline}>
      {taskBrief !== null && <TaskBriefBlock brief={taskBrief} />}
      {messages.map((message) => (
        <MessageRow key={`message-${message.messageId}`} message={message} />
      ))}
      {tools.length > 0 && (
        <div className={styles.toolSection} data-testid="tool-view">
          <div className={styles.toolSectionTitle}>工具行为</div>
          {tools.map((tool) => (
            <ToolSummaryRow key={`tool-${tool.toolCallId}`} tool={tool} />
          ))}
        </div>
      )}
      {messages.length === 0 && tools.length === 0 && taskBrief === null && (
        <div className={styles.emptyTimeline}>暂无可见内容</div>
      )}
    </div>
  );
}

// ─── Artifact 视图（§17.3 列表 + 受控下载）───────────────────────

export interface SubagentArtifactsProps {
  readonly artifacts: readonly SubagentArtifactRecord[];
  /** 受控下载 URL（HTML/SVG 强制 octet-stream；nosniff + Content-Disposition） */
  readonly contentUrl: (artifactId: SubagentArtifactRecord["artifactId"]) => string;
}

export function SubagentArtifacts({ artifacts, contentUrl }: SubagentArtifactsProps) {
  if (artifacts.length === 0) return null;
  return (
    <div className={styles.artifactsSection} data-testid="subagent-artifacts">
      <div className={styles.sectionTitle}>Artifacts（{artifacts.length}）</div>
      <ul className={styles.artifactList}>
        {artifacts.map((artifact) => (
          <li key={artifact.artifactId} className={styles.artifactRow} data-testid={`artifact-${artifact.artifactId}`}>
            <a
              className={styles.artifactLink}
              href={contentUrl(artifact.artifactId)}
              download={artifact.name}
              aria-label={`下载 ${artifact.name}`}
            >
              <FileText size={12} aria-hidden="true" /> {artifact.name}
            </a>
            <span className={styles.artifactMeta}>
              {artifact.kind} · {artifact.sizeBytes !== null ? `${Math.max(1, Math.round(artifact.sizeBytes / 1024))}KB` : "—"}
              · {shortHash(artifact.contentHash)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
