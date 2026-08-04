import Value from "typebox/value";

import type { CapabilityKind, PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import type { TraceContext } from "../../../contracts/observability.js";
import { isKnownCapability } from "../grants/capability-catalog.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import type { RuntimeHost } from "../runtimes/runtime-host.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";
import {
  assertContributionInSnapshot,
  checkCapabilities,
  recordCapabilityDenied,
  serializedBytes,
} from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Command Contribution（plans/phase-12.md §8.2）
//
// - 注册用户明确触发的命令；UI、CLI、未来桌面端共享同一命令描述；
// - 命令不自动绕过模型或工具权限：调用仍经权限交集检查与 RuntimeHost
//   （contributionKind=command，进入统一 Trace/execution 生命周期）；
// - 参数走 argumentsSchema 校验与大小限制。
// ═══════════════════════════════════════════════════════════════

export const COMMAND_MAX_ARGS_BYTES = 128 * 1024;

export interface CommandDescriptor {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly argumentsSchema?: unknown;
}

export type CommandInvokeResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code: "not-registered" | "not-in-snapshot" | "invalid-args" | "too-large" | "denied" | "not-running" | "runtime-error";
      readonly message: string;
      readonly deniedBy?: string;
      readonly reasonCode?: string;
    };

export interface CommandServiceDeps {
  readonly registry: ContributionRegistry;
  readonly policy: EffectivePolicy;
  readonly runtimeHost: RuntimeHost;
}

export class CommandService {
  constructor(private readonly deps: CommandServiceDeps) {}

  listCommands(): CommandDescriptor[] {
    const result: CommandDescriptor[] = [];
    for (const contribution of this.deps.registry.listAll()) {
      if (contribution.kind !== "command") {
        continue;
      }
      const descriptor = this.toDescriptor(contribution);
      if (descriptor !== undefined) {
        result.push(descriptor);
      }
    }
    return result;
  }

  getCommand(pluginId: string, contributionId: string): CommandDescriptor | undefined {
    const contribution = this.deps.registry.get(pluginId, contributionId);
    if (contribution === undefined || contribution.kind !== "command") {
      return undefined;
    }
    return this.toDescriptor(contribution);
  }

  /** 统一调用包装：参数校验 → 权限前置 → RuntimeHost.invoke（command）。 */
  async invoke(input: {
    readonly pluginId: string;
    readonly contributionId: string;
    readonly args?: unknown;
    readonly agentId: string;
    readonly sessionId?: string;
    readonly snapshot?: PluginExecutionSnapshot;
    readonly state?: ResolveState;
    readonly trace?: TraceContext;
    readonly signal?: AbortSignal;
  }): Promise<CommandInvokeResult> {
    const { pluginId, contributionId, agentId } = input;
    const contribution = this.deps.registry.get(pluginId, contributionId);
    if (contribution === undefined || contribution.kind !== "command") {
      return { ok: false, code: "not-registered", message: `命令未登记：${pluginId}.${contributionId}` };
    }

    const snapshotCheck = assertContributionInSnapshot({ snapshot: input.snapshot, pluginId, contributionId });
    if (!snapshotCheck.ok) {
      return { ok: false, code: "not-in-snapshot", message: snapshotCheck.reason };
    }

    const argumentsSchema = contribution.spec["argumentsSchema"];
    const args = input.args ?? {};
    if (isSchemaObject(argumentsSchema) && !Value.Check(argumentsSchema, args)) {
      return { ok: false, code: "invalid-args", message: "命令参数不符合声明 Schema" };
    }
    if (serializedBytes(args) > COMMAND_MAX_ARGS_BYTES) {
      return { ok: false, code: "too-large", message: `命令参数超过大小限制（${COMMAND_MAX_ARGS_BYTES} 字节）` };
    }

    const manifestPermissions = this.deps.registry.getActive(pluginId)?.manifestPermissions;
    const capabilities: CapabilityKind[] = [];
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
        eventName: "plugin.sandbox.denied",
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
        message: `命令 ${contributionId} 执行被拒绝：${guard.reason ?? "权限不足"}`,
        ...(guard.deniedBy !== undefined ? { deniedBy: guard.deniedBy } : {}),
        reasonCode: `capability-${guard.capability ?? "unknown"}`,
      };
    }

    const result = await this.deps.runtimeHost.invoke({
      pluginId,
      contributionKind: "command",
      contributionId,
      method: contributionId,
      params: args,
      agentId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "not-running" ? "not-running" : "runtime-error",
        message: result.message.slice(0, 400),
      };
    }
    return { ok: true, result: result.result };
  }

  // ── private helpers ───────────────────────────────────────────

  private toDescriptor(contribution: RegisteredContribution): CommandDescriptor | undefined {
    if (contribution.kind !== "command") {
      return undefined;
    }
    const descriptor: CommandDescriptor = {
      pluginId: contribution.pluginId,
      contributionId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
    };
    const argumentsSchema = contribution.spec["argumentsSchema"];
    return isSchemaObject(argumentsSchema) ? { ...descriptor, argumentsSchema } : descriptor;
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
