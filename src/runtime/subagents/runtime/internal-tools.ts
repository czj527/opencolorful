import { Type, type Static } from "typebox";
import Value from "typebox/value";

import type { SubagentSessionToolDef } from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T4：平台内部控制工具（plans/phase-14.md §13.3）
//
// report_subagent_progress / request_parent_input / report_subagent_result
// 是平台内部控制工具，不属于 CapabilityCeiling（§13.3）：
// - 每个 Subagent Session 恒注册、不可覆盖、schema 校验；
// - Plugin 贡献同名工具在注册阶段拒绝；
// - report_subagent_result 唯一：模型两次结束仍未调用 → 终态
//   failed/subagent_result_not_reported。
// ═══════════════════════════════════════════════════════════════

export const REPORT_SUBAGENT_PROGRESS_TOOL = "report_subagent_progress";
export const REQUEST_PARENT_INPUT_TOOL = "request_parent_input";
export const REPORT_SUBAGENT_RESULT_TOOL = "report_subagent_result";

export const SUBAGENT_INTERNAL_TOOL_NAMES = [
  REPORT_SUBAGENT_PROGRESS_TOOL,
  REQUEST_PARENT_INPUT_TOOL,
  REPORT_SUBAGENT_RESULT_TOOL,
] as const;
export type SubagentInternalToolName = (typeof SUBAGENT_INTERNAL_TOOL_NAMES)[number];

/**
 * 父控制工具名（§13.5：Subagent 工具注册表完全没有；即使模型伪造 Tool Call
 * 名称到达 RuntimeHost 分发，也返回 subagent_nesting_forbidden）。
 * 与 pi-sdk/agent-session.ts 的 SUBAGENT_TOOL_NAMES 一致（runtime 不 import
 * pi-sdk，故此处独立维护；两端同为 T1 冻结工具名，不得改拼写）。
 */
export const SUBAGENT_NESTING_FORBIDDEN_TOOLS = [
  "spawn_subagent",
  "get_subagent_status",
  "inspect_subagent",
  "steer_subagent",
  "wait_subagent",
  "cancel_subagent",
  "close_subagent",
] as const;

export function isNestingForbiddenToolName(name: string): boolean {
  return (SUBAGENT_NESTING_FORBIDDEN_TOOLS as readonly string[]).includes(name);
}

export const ReportSubagentProgressArgsSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 4000 }),
    phase: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type ReportSubagentProgressArgs = Static<typeof ReportSubagentProgressArgsSchema>;

export const RequestParentInputArgsSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2000 }),
    reason: Type.String({ minLength: 0, maxLength: 1000 }),
    expectedAnswerType: Type.Union([
      Type.Literal("text"),
      Type.Literal("choice"),
      Type.Literal("resource_ref"),
    ]),
    choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 8 })),
  },
  { additionalProperties: false },
);
export type RequestParentInputArgs = Static<typeof RequestParentInputArgsSchema>;

export const ReportSubagentResultArgsSchema = Type.Object(
  {
    disposition: Type.Union([
      Type.Literal("satisfied"),
      Type.Literal("partial"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
    ]),
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    criteria: Type.Array(
      Type.Object(
        {
          criterion: Type.String({ minLength: 1, maxLength: 200 }),
          status: Type.Union([
            Type.Literal("met"),
            Type.Literal("partial"),
            Type.Literal("unmet"),
            Type.Literal("unknown"),
          ]),
          evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
    artifacts: Type.Array(
      Type.Object(
        {
          artifactId: Type.String({ minLength: 4, maxLength: 132 }),
          name: Type.String({ minLength: 1, maxLength: 256 }),
          contentHash: Type.String({ minLength: 8, maxLength: 128 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
    unresolvedIssues: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
    recommendedNextAction: Type.Union([
      Type.Literal("accept"),
      Type.Literal("steer"),
      Type.Literal("ask_user"),
      Type.Literal("restart"),
      Type.Literal("stop"),
    ]),
  },
  { additionalProperties: false },
);
export type ReportSubagentResultArgs = Static<typeof ReportSubagentResultArgsSchema>;

function tool(name: string, description: string, parameters: Record<string, unknown>): SubagentSessionToolDef {
  return { name, description, parameters };
}

/** 三个内部控制工具定义（每个 Subagent Session 恒注入） */
export function subagentInternalToolDefs(): readonly SubagentSessionToolDef[] {
  return [
    tool(
      REPORT_SUBAGENT_PROGRESS_TOOL,
      "向父 Agent 汇报阶段性进展。reporting.progress=milestones 时应在每个里程碑调用；terminal-only 时可以不调用。",
      ReportSubagentProgressArgsSchema as unknown as Record<string, unknown>,
    ),
    tool(
      REQUEST_PARENT_INPUT_TOOL,
      "向父 Agent 请求输入（澄清/选择/资源引用）。调用后本 Run 进入 waiting_for_input，父 Agent 回答后自动恢复；同一 Run 同时只能有一个未解决的请求。",
      RequestParentInputArgsSchema as unknown as Record<string, unknown>,
    ),
    tool(
      REPORT_SUBAGENT_RESULT_TOOL,
      "提交最终结构化结果。每个 Run 只能提交一次；提交后本 Run 结束。未提交结果而结束会被视为结果缺失（failed/subagent_result_not_reported）。",
      ReportSubagentResultArgsSchema as unknown as Record<string, unknown>,
    ),
  ];
}

/** 参数校验：跨进程工具输入必须过 TypeBox（未知 schema 不进入 Runtime） */
export function isSubagentInternalToolName(name: string): boolean {
  return (SUBAGENT_INTERNAL_TOOL_NAMES as readonly string[]).includes(name);
}

export function parseProgressArgs(value: unknown): ReportSubagentProgressArgs | null {
  return Value.Check(ReportSubagentProgressArgsSchema, value) ? value : null;
}

export function parseInputArgs(value: unknown): RequestParentInputArgs | null {
  return Value.Check(RequestParentInputArgsSchema, value) ? value : null;
}

export function parseResultArgs(value: unknown): ReportSubagentResultArgs | null {
  return Value.Check(ReportSubagentResultArgsSchema, value) ? value : null;
}
