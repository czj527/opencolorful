// ═══════════════════════════════════════════════════════════════
// Phase 12 Dev Scenario（plans/phase-12.md §15 / §19.2）
//
// - run-scenario：tool invocation + 结果断言 + Surface 打开 + destructive 标记；
// - 场景文件位于插件 dev 运行时副本 dev/scenarios/<name>.json，schema 由
//   本模块 TypeBox 冻结（DevScenarioSchema）；
// - destructive 场景必须显式批准（runScenario approval=true 或
//   PluginDevHost.approveDestructive 先批准），否则拒绝并记录
//   plugin.dev.scenario_failed；
// - 场景执行自动记录 plugin.dev.scenario_completed / scenario_failed
//   Activity；工具调用经 DevInvoke 复用真实权限 + Trace 包装。
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";
import Value from "typebox/value";

import type { TraceContext } from "../../../contracts/observability.js";
import { instrument } from "../../../observability/instrument.js";
import { pluginVersionDir } from "../paths.js";
import type { PluginDevHost } from "./dev-host.js";
import type { PluginDevInvokeService } from "./dev-invoke.js";

// ═══════════════════════════════════════════════════════════════
// 场景 Schema（TypeBox 冻结）
// ═══════════════════════════════════════════════════════════════

export const DevScenarioInvokeExpectSchema = Type.Object(
  {
    /** 工具返回结果断言（deep-equal） */
    result: Type.Optional(Type.Unknown()),
    /** 断言该工具是否需要权限确认（riskLevel=high / 高风险能力） */
    requireConfirmation: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DevScenarioInvokeExpect = Static<typeof DevScenarioInvokeExpectSchema>;

export const DevScenarioInvokeToolStepSchema = Type.Object(
  {
    kind: Type.Literal("invoke-tool"),
    tool: Type.String({ minLength: 1, maxLength: 128 }),
    args: Type.Optional(Type.Unknown()),
    expect: Type.Optional(DevScenarioInvokeExpectSchema),
  },
  { additionalProperties: false },
);
export type DevScenarioInvokeToolStep = Static<typeof DevScenarioInvokeToolStepSchema>;

export const DevScenarioOpenSurfaceStepSchema = Type.Object(
  {
    kind: Type.Literal("open-surface"),
    surface: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type DevScenarioOpenSurfaceStep = Static<typeof DevScenarioOpenSurfaceStepSchema>;

export const DevScenarioStepSchema = Type.Union([DevScenarioInvokeToolStepSchema, DevScenarioOpenSurfaceStepSchema]);
export type DevScenarioStep = Static<typeof DevScenarioStepSchema>;

export const DevScenarioSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    /** destructive 场景需要显式批准 */
    destructive: Type.Optional(Type.Boolean()),
    steps: Type.Array(DevScenarioStepSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type DevScenario = Static<typeof DevScenarioSchema>;

// ═══════════════════════════════════════════════════════════════
// 错误与结果
// ═══════════════════════════════════════════════════════════════

export class PluginDevScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginDevScenarioError";
  }
}

export class PluginDevScenarioNotFoundError extends PluginDevScenarioError {
  constructor(pluginId: string, scenarioName: string) {
    super(`dev 场景不存在：${pluginId}/dev/scenarios/${scenarioName}.json`);
    this.name = "PluginDevScenarioNotFoundError";
  }
}

export class PluginDevScenarioApprovalRequiredError extends PluginDevScenarioError {
  constructor(pluginId: string, scenarioName: string) {
    super(`destructive 场景需要显式批准：${pluginId}/${scenarioName}（使用 approval=true 或先 approveDestructive）`);
    this.name = "PluginDevScenarioApprovalRequiredError";
  }
}

export interface PluginDevScenarioRunInput {
  readonly pluginId: string;
  readonly devRunId: string;
  readonly scenarioName: string;
  /** invoke-tool 步骤所需的 Agent scope（复用真实权限/绑定） */
  readonly agentId?: string;
  /** 覆盖步骤参数的 CLI 参数（键同名覆盖步骤 args） */
  readonly args?: Readonly<Record<string, unknown>>;
  /** destructive 场景的显式批准 */
  readonly approval?: boolean;
  readonly trace?: TraceContext;
}

export type PluginDevScenarioRunResult =
  | { readonly ok: true; readonly result: { readonly scenarioName: string; readonly stepsCompleted: number } }
  | { readonly ok: false; readonly error: string; readonly stepIndex?: number };

export interface PluginDevScenarioDeps {
  readonly host: PluginDevHost;
  readonly invoke: PluginDevInvokeService;
}

const SCENARIO_OPERATION_PREFIX = "dev-scenario";

// ═══════════════════════════════════════════════════════════════

export class PluginDevScenarioService {
  constructor(private readonly deps: PluginDevScenarioDeps) {}

  /** 读取并校验场景定义（dev 运行时副本 dev/scenarios/<name>.json）。 */
  loadScenario(pluginId: string, devRunId: string, scenarioName: string): DevScenario {
    const slot = this.deps.host.requireSlot(pluginId, devRunId);
    const versionDir = pluginVersionDir(this.deps.host.getDevPaths(), pluginId, slot.version);
    const scenarioPath = path.join(versionDir, "dev", "scenarios", `${scenarioName}.json`);
    if (!fs.existsSync(scenarioPath)) {
      throw new PluginDevScenarioNotFoundError(pluginId, scenarioName);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as unknown;
    } catch {
      throw new PluginDevScenarioError(`dev 场景文件不是合法 JSON：${scenarioName}.json`);
    }
    if (!Value.Check(DevScenarioSchema, raw)) {
      throw new PluginDevScenarioError(`dev 场景文件不符合场景 Schema：${scenarioName}.json`);
    }
    const scenario = raw as DevScenario;
    if (scenario.name !== scenarioName) {
      throw new PluginDevScenarioError(`场景文件名与场景内 name 不一致：${scenarioName} ≠ ${scenario.name}`);
    }
    return scenario;
  }

  /** 列出插件可用场景名（基于 dev 运行时副本）。 */
  listScenarios(pluginId: string): readonly string[] {
    const slot = this.deps.host.getSlot(pluginId);
    if (slot === undefined) {
      return [];
    }
    try {
      const scenariosDir = path.join(pluginVersionDir(this.deps.host.getDevPaths(), pluginId, slot.version), "dev", "scenarios");
      if (!fs.existsSync(scenariosDir)) {
        return [];
      }
      return fs
        .readdirSync(scenariosDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 运行场景：destructive 审批 → 顺序执行步骤（invoke-tool 断言 /
   * open-surface 校验）→ 终态活动（scenario_completed / scenario_failed）。
   */
  async runScenario(input: PluginDevScenarioRunInput): Promise<PluginDevScenarioRunResult> {
    const host = this.deps.host;
    const slot = host.requireSlot(input.pluginId, input.devRunId);
    const scenario = this.loadScenario(input.pluginId, input.devRunId, input.scenarioName);
    const destructive = scenario.destructive === true;

    const operationId = `${SCENARIO_OPERATION_PREFIX}-${input.pluginId}-${input.scenarioName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const trace = input.trace ?? { traceId: instrument.newTraceId(), spanId: instrument.newSpanId(), operationId };

    if (destructive && input.approval !== true && !host.hasDestructiveApproval(input.pluginId, input.devRunId, input.scenarioName)) {
      this.emitScenarioFailed({
        pluginId: input.pluginId,
        scenarioName: input.scenarioName,
        trace,
        errorCode: "destructive-approval-required",
        message: "destructive 场景需要显式批准",
      });
      return { ok: false, error: new PluginDevScenarioApprovalRequiredError(input.pluginId, input.scenarioName).message };
    }

    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index] as DevScenarioStep;
      const stepResult = await this.runStep(step, input, trace);
      if (!stepResult.ok) {
        this.emitScenarioFailed({
          pluginId: input.pluginId,
          scenarioName: input.scenarioName,
          trace,
          errorCode: stepResult.errorCode,
          message: stepResult.error,
          stepIndex: index,
        });
        return { ok: false, error: stepResult.error, stepIndex: index };
      }
    }

    instrument.activity({
      eventName: "plugin.dev.scenario_completed",
      status: "completed",
      operationId,
      actor: { kind: "user", id: "plugin-dev" },
      executor: { kind: "service", id: "plugin-dev-scenario" },
      target: { kind: "plugin", id: input.pluginId },
      scope: { pluginId: input.pluginId },
      trace,
      payload: {
        summaryCode: "plugin_dev_scenario_completed",
        attributes: {
          pluginId: input.pluginId,
          scenarioName: input.scenarioName,
          steps: scenario.steps.length,
          destructive,
          approval: destructive ? (input.approval === true || host.hasDestructiveApproval(input.pluginId, input.devRunId, input.scenarioName)) : false,
        },
      },
    });
    void slot;
    return { ok: true, result: { scenarioName: input.scenarioName, stepsCompleted: scenario.steps.length } };
  }

  // ── 内部：单步骤执行 ─────────────────────────────────────────

  private async runStep(
    step: DevScenarioStep,
    input: PluginDevScenarioRunInput,
    trace: TraceContext,
  ): Promise<{ ok: true } | { ok: false; error: string; errorCode: string }> {
    if (step.kind === "invoke-tool") {
      return this.runInvokeToolStep(step, input, trace);
    }
    return this.runOpenSurfaceStep(step, input);
  }

  private async runInvokeToolStep(
    step: DevScenarioInvokeToolStep,
    input: PluginDevScenarioRunInput,
    trace: TraceContext,
  ): Promise<{ ok: true } | { ok: false; error: string; errorCode: string }> {
    if (input.agentId === undefined) {
      return { ok: false, error: `场景步骤 invoke-tool(${step.tool}) 需要 agentId（复用真实权限/绑定）`, errorCode: "missing-agent" };
    }
    const args = { ...(isRecord(step.args) ? step.args : {}), ...(input.args ?? {}) };
    const result = await this.deps.invoke.invokeTool({
      pluginId: input.pluginId,
      devRunId: input.devRunId,
      agentId: input.agentId,
      toolName: step.tool,
      args,
      trace,
    });
    if (!result.ok) {
      return { ok: false, error: `工具调用失败（${step.tool}）：${result.error}`, errorCode: "tool-invoke-failed" };
    }

    const expect = step.expect;
    if (expect !== undefined) {
      if (expect.result !== undefined && !deepEqual(expect.result, result.result)) {
        return {
          ok: false,
          error: `工具 ${step.tool} 返回结果与断言不符`,
          errorCode: "assertion-mismatch",
        };
      }
      if (expect.requireConfirmation !== undefined) {
        const descriptor = this.deps.host.getDevHostApi().tools.getTool(`${input.pluginId}.${step.tool}`);
        const actual = descriptor?.requiresConfirmation ?? false;
        if (actual !== expect.requireConfirmation) {
          return {
            ok: false,
            error: `工具 ${step.tool} 的 requiresConfirmation 断言不符（期望 ${expect.requireConfirmation}，实际 ${actual}）`,
            errorCode: "assertion-mismatch",
          };
        }
      }
    }
    return { ok: true };
  }

  private runOpenSurfaceStep(
    step: DevScenarioOpenSurfaceStep,
    input: PluginDevScenarioRunInput,
  ): { ok: true } | { ok: false; error: string; errorCode: string } {
    const result = this.deps.invoke.describeSurface(input.pluginId, step.surface);
    if (!result.ok) {
      return { ok: false, error: `Surface 打开校验失败（${step.surface}）：${result.error}`, errorCode: "surface-not-found" };
    }
    instrument.activity({
      eventName: "plugin.surface.opened",
      actor: { kind: "user", id: "plugin-dev" },
      executor: { kind: "service", id: "plugin-dev-scenario" },
      target: { kind: "plugin", id: input.pluginId },
      scope: { pluginId: input.pluginId },
      payload: {
        summaryCode: "plugin_surface_opened",
        attributes: {
          pluginId: input.pluginId,
          surfaceId: step.surface,
          surfaceKind: result.surface.kind,
        },
      },
    });
    return { ok: true };
  }

  private emitScenarioFailed(input: {
    pluginId: string;
    scenarioName: string;
    trace: TraceContext;
    errorCode: string;
    message: string;
    stepIndex?: number;
  }): void {
    instrument.activity({
      eventName: "plugin.dev.scenario_failed",
      status: "failed",
      actor: { kind: "user", id: "plugin-dev" },
      executor: { kind: "service", id: "plugin-dev-scenario" },
      target: { kind: "plugin", id: input.pluginId },
      scope: { pluginId: input.pluginId },
      trace: input.trace,
      payload: {
        summaryCode: "plugin_dev_scenario_failed",
        attributes: {
          pluginId: input.pluginId,
          scenarioName: input.scenarioName,
          errorCode: input.errorCode,
          message: input.message.slice(0, 300),
          ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
        },
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// 模块级辅助
// ═══════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深度相等（JSON 安全值；NaN 视为相等）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!(key in recordB) || !deepEqual(recordA[key], recordB[key])) {
      return false;
    }
  }
  return true;
}
