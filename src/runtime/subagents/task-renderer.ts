import Value from "typebox/value";

import {
  SubagentSteerV1Schema,
  SubagentTaskBriefV1Schema,
  type SubagentContextPacketV1,
  type SubagentSteerV1,
  type SubagentTaskBriefV1,
} from "../../contracts/subagents.js";
import { collectTypeBoxProblems } from "./delegation-policy.js";
import type { ContextResolutionSnapshot, ResourceResolution } from "./context-resolver.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T3：Task Renderer（plans/phase-14.md §9.1 / §9.3 / §11.1）
//
// 纯函数渲染，输出 string：
// - TaskBrief 渲染为固定区块 [任务目标][完成标准][交付物][可用上下文]
//   [约束][非目标][汇报规则]（Renderer 只渲染合法结构，不拼接未标记 JSON）；
// - ContextPacket 摘要与已授权引用列表渲染（含截断标记）；
// - Steer 渲染（queue/interrupt 说明、preserveCompletedWork 语义）。
//
// 本文件是 T3 独占文件（src/runtime/subagents/），不 import T2 stores。
// ═══════════════════════════════════════════════════════════════

/** TaskBrief 固定区块名（计划 §9.1 逐字；测试防漂移） */
export const TASK_BRIEF_BLOCK_NAMES = [
  "任务目标",
  "完成标准",
  "交付物",
  "可用上下文",
  "约束",
  "非目标",
  "汇报规则",
] as const;

// ── TaskBrief 渲染 ─────────────────────────────────────────────

export function renderTaskBrief(brief: SubagentTaskBriefV1): string {
  const lines: string[] = [];

  lines.push("[任务目标]");
  lines.push(brief.title);
  lines.push(brief.objective);
  lines.push("");

  lines.push("[完成标准]");
  appendNumbered(lines, brief.successCriteria);
  lines.push("");

  lines.push("[交付物]");
  appendNumbered(lines, brief.deliverables);
  lines.push("");

  lines.push("[可用上下文]");
  appendBullets(lines, brief.context);
  lines.push("");

  lines.push("[约束]");
  appendNumbered(lines, brief.constraints);
  lines.push("");

  lines.push("[非目标]");
  appendBullets(lines, brief.nonGoals);
  lines.push("");

  lines.push("[汇报规则]");
  lines.push(`- 进度汇报：${renderProgressMode(brief.reporting.progress)}`);
  lines.push(`- 证据要求：${brief.reporting.evidenceRequired ? "必须提供证据" : "证据可选"}`);
  lines.push(`- 交付物形式：${renderArtifactPreference(brief.reporting.artifactPreference)}`);

  return lines.join("\n");
}

// ── ContextPacket 渲染（摘要 + 已授权引用列表）─────────────────

export interface RenderContextPacketOptions {
  /** ContextResolver 冻结快照（引用状态/截断标记）；缺省只渲染引用列表本身 */
  readonly resolution?: ContextResolutionSnapshot;
}

export function renderContextPacket(packet: SubagentContextPacketV1, options: RenderContextPacketOptions = {}): string {
  const lines: string[] = [];
  const snapshot = options.resolution;

  lines.push("[父上下文摘要]");
  lines.push(packet.parentSummary.length > 0 ? packet.parentSummary : "（无）");
  lines.push("");

  lines.push("[用户请求]");
  lines.push(packet.userRequest);
  lines.push("");

  lines.push("[引用消息（父会话只读快照）]");
  if (packet.messageRefs.length > 0 && snapshot !== undefined) {
    for (const entry of snapshot.messageRefs) {
      lines.push(`- ${entry.ref.messageId}（${entry.bytes} 字节${entry.truncated ? "，已截断" : ""}）`);
    }
    if (snapshot.droppedMessageCount > 0) {
      lines.push(`- （另有 ${snapshot.droppedMessageCount} 条因总预算上限被丢弃）`);
    }
  } else if (packet.messageRefs.length > 0) {
    for (const ref of packet.messageRefs) {
      lines.push(`- ${ref.messageId}`);
    }
  } else {
    lines.push("（无）");
  }
  lines.push("");

  lines.push("[已授权资源]");
  if (packet.resources.length > 0 && snapshot !== undefined) {
    for (const resource of snapshot.resources) {
      lines.push(`- ${resourceLabelLine(resource)}`);
    }
  } else if (packet.resources.length > 0) {
    for (const ref of packet.resources) {
      lines.push(`- ${ref.kind}: ${summarizeResourceRef(ref)}`);
    }
  } else {
    lines.push("（无）");
  }
  if (snapshot?.truncated === true) {
    lines.push("（注：消息快照因大小上限被截断，超出部分不可用）");
  }
  lines.push("");

  lines.push("[已知事实]");
  appendBullets(lines, packet.knownFacts);
  lines.push("");

  lines.push("[未解决问题]");
  appendBullets(lines, packet.unresolvedQuestions);

  return lines.join("\n");
}

// ── Steer 渲染 ─────────────────────────────────────────────────

export function renderSteer(steer: SubagentSteerV1): string {
  const lines: string[] = [];

  lines.push("[主 Agent 纠偏]");
  lines.push(`动作：${steer.action}`);
  lines.push(`投递方式：${renderDeliveryMode(steer.deliveryMode)}`);
  lines.push(`原因：${steer.reason.length > 0 ? steer.reason : "（未说明）"}`);
  lines.push(`指令：${steer.instruction}`);
  lines.push(`保留已完成工作：${steer.preserveCompletedWork ? "是" : "否"} — ${renderPreserveSemantics(steer.preserveCompletedWork)}`);

  return lines.join("\n");
}

// ── 跨进程输入校验（spawn / steer 工具参数必须过 TypeBox）──────

export type TaskBriefValidationResult =
  | { readonly ok: true; readonly brief: SubagentTaskBriefV1 }
  | { readonly ok: false; readonly problems: readonly string[] };

export function parseTaskBrief(value: unknown): TaskBriefValidationResult {
  if (Value.Check(SubagentTaskBriefV1Schema, value)) {
    return { ok: true, brief: value };
  }
  return { ok: false, problems: collectTypeBoxProblems(SubagentTaskBriefV1Schema, value) };
}

export type SteerValidationResult =
  | { readonly ok: true; readonly steer: SubagentSteerV1 }
  | { readonly ok: false; readonly problems: readonly string[] };

export function parseSteer(value: unknown): SteerValidationResult {
  if (Value.Check(SubagentSteerV1Schema, value)) {
    // T1 经验：schema 的 map Union 破坏 Static 推导，契约显式声明手动类型
    // SubagentSteerV1 为权威；此处输入已过 TypeBox 完整校验，转换不绕过边界。
    return { ok: true, steer: value as unknown as SubagentSteerV1 };
  }
  return { ok: false, problems: collectTypeBoxProblems(SubagentSteerV1Schema, value) };
}

// ── 内部渲染辅助 ───────────────────────────────────────────────

function appendNumbered(lines: string[], items: readonly string[]): void {
  if (items.length === 0) {
    lines.push("（无）");
    return;
  }
  items.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
}

function appendBullets(lines: string[], items: readonly string[]): void {
  if (items.length === 0) {
    lines.push("（无）");
    return;
  }
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}

function renderProgressMode(mode: "milestones" | "terminal-only"): string {
  return mode === "milestones" ? "milestones（按里程碑汇报）" : "terminal-only（仅终态汇报）";
}

function renderArtifactPreference(preference: "inline" | "references" | "both"): string {
  switch (preference) {
    case "inline":
      return "inline（内联文本）";
    case "references":
      return "references（引用形式）";
    case "both":
      return "both（内联与引用）";
  }
}

function renderDeliveryMode(mode: "queue" | "interrupt"): string {
  return mode === "queue"
    ? "queue（队列投递：等待当前模型/工具处理结束后应用）"
    : "interrupt（中断投递：在安全边界内立即交付；工具不可中断时可延迟到工具终态，但必须如实返回 delayed）";
}

function renderPreserveSemantics(preserve: boolean): string {
  return preserve
    ? "在现有已完成工作的基础上调整，不得重做或丢弃已完成成果"
    : "允许放弃未完成部分，按要求调整方向，无需保留中间成果";
}

function resourceLabelLine(resource: ResourceResolution): string {
  const hash =
    resource.ref.kind === "parent_message"
      ? resource.ref.contentHash
      : resource.ref.kind === "workspace_file"
        ? resource.ref.contentHash
        : resource.ref.kind === "artifact"
          ? resource.ref.contentHash
          : resource.ref.contentHash;
  return `${resource.label}（哈希 ${hash.slice(0, 12)}）`;
}

function summarizeResourceRef(ref: SubagentContextPacketV1["resources"][number]): string {
  switch (ref.kind) {
    case "parent_message":
      return ref.messageId;
    case "workspace_file":
      return ref.relativePath;
    case "artifact":
      return ref.artifactId;
    case "skill":
      return `${ref.skillRef.skillId}@${ref.skillRef.sourceId}@${ref.skillRef.version}`;
  }
}
