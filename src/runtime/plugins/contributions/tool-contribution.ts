import Value from "typebox/value";

import type { CapabilityKind, PluginExecutionSnapshot, ToolRiskLevel } from "../../../contracts/plugin-protocol.js";
import type { TraceContext } from "../../../contracts/observability.js";
import { instrument } from "../../../observability/instrument.js";
import { sanitizeError } from "../../../observability/safe-value.js";
import { isKnownCapability, requiresUserConfirmation } from "../grants/capability-catalog.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import type { RuntimeHost } from "../runtimes/runtime-host.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";
import {
  assertContributionInSnapshot,
  checkCapabilities,
  recordCapabilityDenied,
  redactSensitive,
  serializedBytes,
} from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Tool Contribution（plans/phase-12.md §8.1）
//
// - Agent 可见层使用稳定 namespace：pluginId.toolId，避免插件间冲突；
// - 工具调用由平台包装：权限前置（EffectivePolicy + 快照冻结状态）→
//   RuntimeHost.invoke（contributionKind=tool，自动产生 plugin.execution.*）→
//   输出 Schema/大小/脱敏校验；
// - 插件不能自行决定是否需要确认：requiresUserConfirmation 由平台目录
//   （能力族高风险）+ Manifest riskLevel 共同决定；
// - 输入只传安全脱敏摘要进日志，绝不在错误消息/属性里回显敏感值。
// ═══════════════════════════════════════════════════════════════

export const TOOL_MAX_INPUT_BYTES = 256 * 1024;
export const TOOL_MAX_OUTPUT_BYTES = 512 * 1024;

/** Agent 可见稳定 namespace：pluginId.toolId */
export function qualifiedToolName(pluginId: string, contributionId: string): string {
  return `${pluginId}.${contributionId}`;
}

export interface AgentToolDescriptor {
  readonly qualifiedName: string;
  readonly pluginId: string;
  readonly contributionId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly riskLevel: ToolRiskLevel;
  /** 平台判定：是否需要用户确认（插件不能自选） */
  readonly requiresConfirmation: boolean;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export type ToolInvokeResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code:
        | "not-registered"
        | "not-in-snapshot"
        | "invalid-input"
        | "too-large"
        | "denied"
        | "invalid-output"
        | "not-running"
        | "runtime-mismatch"
        | "runtime-error";
      readonly message: string;
      readonly deniedBy?: string;
      readonly reasonCode?: string;
    };

export interface ToolServiceDeps {
  readonly registry: ContributionRegistry;
  readonly policy: EffectivePolicy;
  readonly runtimeHost: RuntimeHost;
}

const DEFAULT_RISK_LEVEL: ToolRiskLevel = "medium";

export class ToolService {
  constructor(private readonly deps: ToolServiceDeps) {}

  /** Agent 工具目录：全部已登记 tool contribution（可见性由调用方按 Agent 过滤）。 */
  listTools(): AgentToolDescriptor[] {
    const result: AgentToolDescriptor[] = [];
    for (const contribution of this.deps.registry.listAll()) {
      if (contribution.kind !== "tool") {
        continue;
      }
      const descriptor = this.toDescriptor(contribution);
      if (descriptor !== undefined) {
        result.push(descriptor);
      }
    }
    return result;
  }

  getTool(qualifiedName: string): AgentToolDescriptor | undefined {
    const contribution = this.resolveQualifiedName(qualifiedName);
    if (contribution === undefined) {
      return undefined;
    }
    return this.toDescriptor(contribution);
  }

  /** 反解 namespace：遍历登记集合找到唯一匹配的 (pluginId, toolId)。 */
  resolveQualifiedName(qualifiedName: string): RegisteredContribution | undefined {
    for (const pluginId of this.deps.registry.listPlugins()) {
      const contribution = this.deps.registry
        .listByKind(pluginId, "tool")
        .find((item) => qualifiedToolName(item.pluginId, item.id) === qualifiedName);
      if (contribution !== undefined) {
        return contribution;
      }
    }
    return undefined;
  }

  /** 平台判定是否需要用户确认：高风险能力 或 Manifest riskLevel=high。 */
  requiresUserConfirmation(descriptor: Pick<AgentToolDescriptor, "riskLevel" | "pluginId" | "contributionId">): boolean {
    if (descriptor.riskLevel === "high") {
      return true;
    }
    const contribution = this.deps.registry.get(descriptor.pluginId, descriptor.contributionId);
    if (contribution === undefined) {
      return false;
    }
    return contribution.requiredCapabilities.some((capability) => this.isHighRiskCapability(capability));
  }

  /** 统一调用包装：权限前置 → RuntimeHost.invoke → 输出校验。 */
  async invoke(input: {
    readonly pluginId: string;
    readonly contributionId: string;
    readonly params: unknown;
    readonly agentId: string;
    readonly sessionId?: string;
    /** in-flight turn 快照（不可变） */
    readonly snapshot?: PluginExecutionSnapshot;
    readonly state?: ResolveState;
    readonly trace?: TraceContext;
    readonly signal?: AbortSignal;
  }): Promise<ToolInvokeResult> {
    const { pluginId, contributionId, agentId } = input;
    const contribution = this.deps.registry.get(pluginId, contributionId);
    if (contribution === undefined || contribution.kind !== "tool") {
      return { ok: false, code: "not-registered", message: `工具未登记：${pluginId}.${contributionId}` };
    }

    const snapshotCheck = assertContributionInSnapshot({ snapshot: input.snapshot, pluginId, contributionId });
    if (!snapshotCheck.ok) {
      return { ok: false, code: "not-in-snapshot", message: snapshotCheck.reason };
    }

    // 输入 Schema 校验（JSON Schema 子集）
    const inputSchema = contribution.spec["inputSchema"];
    if (isSchemaObject(inputSchema) && !Value.Check(inputSchema, input.params)) {
      return { ok: false, code: "invalid-input", message: "工具输入不符合声明 Schema" };
    }
    if (serializedBytes(input.params) > TOOL_MAX_INPUT_BYTES) {
      return { ok: false, code: "too-large", message: `工具输入超过大小限制（${TOOL_MAX_INPUT_BYTES} 字节）` };
    }

    // 权限前置：tool.register + requiredCapabilities 全部放行
    const manifestPermissions = this.deps.registry.getActive(pluginId)?.manifestPermissions;
    const capabilities: CapabilityKind[] = ["tool.register"];
    for (const required of contribution.requiredCapabilities) {
      if (isKnownCapability(required)) {
        capabilities.push(required);
      }
    }
    const guard = checkCapabilities({
      policy: this.deps.policy,
      pluginId,
      agentId,
      capabilities,
      manifestPermissions,
      state: input.state,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (!guard.allowed) {
      recordCapabilityDenied({
        eventName: "tool.call.denied",
        pluginId,
        contributionId,
        agentId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        capability: guard.capability,
        deniedBy: guard.deniedBy,
        reason: guard.reason ?? "权限不足",
      });
      return {
        ok: false,
        code: "denied",
        message: `工具 ${contributionId} 调用被拒绝：${guard.reason ?? "权限不足"}`,
        ...(guard.deniedBy !== undefined ? { deniedBy: guard.deniedBy } : {}),
        reasonCode: `capability-${guard.capability ?? "unknown"}`,
      };
    }

    // 统一经 RuntimeHost.invoke：自动产生 plugin.execution.*（contributionKind=tool）
    // P0-2：快照冻结的实例/版本作为期望值传递——实例重启/更新后旧 turn 的
    // 调用被 RuntimeHost fail-closed 拒绝（不能中途换工具实现）；
    // P1-1：snapshot/state 随 operation 绑定，worker 嵌套 Host 请求复用冻结权限
    const result = await this.deps.runtimeHost.invoke({
      pluginId,
      contributionKind: "tool",
      contributionId,
      method: contributionId,
      params: input.params,
      agentId,
      ...(input.snapshot !== undefined
        ? {
            expectedRuntimeInstanceId: input.snapshot.runtimeInstanceId,
            expectedPluginVersion: input.snapshot.pluginVersion,
            snapshot: input.snapshot,
          }
        : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        code:
          result.code === "not-running"
            ? "not-running"
            : result.code === "runtime-instance-mismatch" || result.code === "runtime-version-mismatch"
              ? "runtime-mismatch"
              : "runtime-error",
        message: result.message.slice(0, 400),
      };
    }

    // 输出校验：Schema + 大小限制 + 脱敏摘要（完整输出不进入日志）
    const outputSchema = contribution.spec["outputSchema"];
    if (isSchemaObject(outputSchema) && !Value.Check(outputSchema, result.result)) {
      instrument.warn("plugin.tool.output_invalid", "工具输出不符合声明 Schema", {
        pluginId,
        contributionId,
      });
      return { ok: false, code: "invalid-output", message: "工具输出不符合声明 Schema" };
    }
    if (serializedBytes(result.result) > TOOL_MAX_OUTPUT_BYTES) {
      return { ok: false, code: "invalid-output", message: `工具输出超过大小限制（${TOOL_MAX_OUTPUT_BYTES} 字节）` };
    }
    // 输出脱敏摘要（仅用于安全日志/诊断，不改变返回给调用方的真实结果）
    void redactSensitive(result.result);
    return { ok: true, result: result.result };
  }

  // ── private helpers ───────────────────────────────────────────

  private toDescriptor(contribution: RegisteredContribution): AgentToolDescriptor | undefined {
    if (contribution.kind !== "tool") {
      return undefined;
    }
    const riskLevel = isRiskLevel(contribution.spec["riskLevel"])
      ? contribution.spec["riskLevel"]
      : DEFAULT_RISK_LEVEL;
    const base: AgentToolDescriptor = {
      qualifiedName: qualifiedToolName(contribution.pluginId, contribution.id),
      pluginId: contribution.pluginId,
      contributionId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
      riskLevel,
      requiresConfirmation: false,
    };
    const withConfirmation: AgentToolDescriptor = { ...base, requiresConfirmation: this.requiresUserConfirmation(base) };
    const inputSchema = contribution.spec["inputSchema"];
    const withInput = isSchemaObject(inputSchema) ? { ...withConfirmation, inputSchema } : withConfirmation;
    const outputSchema = contribution.spec["outputSchema"];
    return isSchemaObject(outputSchema) ? { ...withInput, outputSchema } : withInput;
  }

  private isHighRiskCapability(capability: string): boolean {
    if (!isKnownCapability(capability)) {
      return false;
    }
    return requiresUserConfirmation(capability);
  }
}

function isRiskLevel(value: unknown): value is ToolRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 防御性兜底：schema 校验失败时捕获并给出明确诊断（不把异常直接抛给调用方）。
export function validateContributionSchema(schema: unknown, value: unknown): boolean {
  if (!isSchemaObject(schema)) {
    return true;
  }
  try {
    return Value.Check(schema, value);
  } catch (error) {
    instrument.warn("plugin.schema_invalid", "插件声明的 Schema 无法校验", {
      message: sanitizeError(error).message.slice(0, 200),
    });
    return false;
  }
}
