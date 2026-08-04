import crypto from "node:crypto";

import Value from "typebox/value";

import type { CapabilityKind, PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import { isKnownCapability } from "../grants/capability-catalog.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";
import { checkCapabilities, recordCapabilityDenied, serializedBytes } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Context Attachment Contribution（plans/phase-12.md §8.8）
//
// - 插件定义结构化附件类型，但不能直接修改 Prompt；
// - 平台验证附件 Schema、大小、来源和当前 Session 权限；
// - 附件必须可删除、可显示来源，并在引用失效时标记 stale；
// - Context Builder 决定如何把附件投影给模型：本层只提供 projection
//   接口与默认结构化投影，不注入 Prompt。
// ═══════════════════════════════════════════════════════════════

export const ATTACHMENT_MAX_VALUE_BYTES = 256 * 1024;

/** 附件来源 allowlist（平台冻结）。 */
export const ATTACHMENT_SOURCES = ["user", "plugin", "session", "workspace", "agent"] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

export interface AttachmentTypeDescriptor {
  readonly pluginId: string;
  readonly typeId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly schema?: unknown;
}

export interface AttachedAttachment {
  readonly attachmentId: string;
  readonly pluginId: string;
  readonly typeId: string;
  readonly value: unknown;
  readonly source: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly attachedAt: string;
  readonly stale: boolean;
}

export type AttachmentValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "unknown-type" | "invalid-schema" | "too-large" | "invalid-source" | "denied"; readonly reason: string };

export interface AttachmentServiceDeps {
  readonly registry: ContributionRegistry;
  readonly policy: EffectivePolicy;
  readonly now?: () => Date;
}

export class AttachmentService {
  private readonly now: () => Date;
  private readonly attached = new Map<string, AttachedAttachment>();

  constructor(private readonly deps: AttachmentServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  listTypes(): AttachmentTypeDescriptor[] {
    const result: AttachmentTypeDescriptor[] = [];
    for (const contribution of this.deps.registry.listAll()) {
      if (contribution.kind !== "context-attachment") {
        continue;
      }
      const descriptor = this.toDescriptor(contribution);
      if (descriptor !== undefined) {
        result.push(descriptor);
      }
    }
    return result;
  }

  getType(pluginId: string, typeId: string): AttachmentTypeDescriptor | undefined {
    const contribution = this.deps.registry.get(pluginId, typeId);
    if (contribution === undefined || contribution.kind !== "context-attachment") {
      return undefined;
    }
    return this.toDescriptor(contribution);
  }

  /** 平台验证：Schema + 大小 + 来源 + 当前 Session 权限。 */
  validateAttachment(input: {
    readonly pluginId: string;
    readonly typeId: string;
    readonly value: unknown;
    readonly source: string;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly state?: ResolveState;
    readonly snapshot?: PluginExecutionSnapshot;
  }): AttachmentValidationResult {
    const contribution = this.deps.registry.get(input.pluginId, input.typeId);
    if (contribution === undefined || contribution.kind !== "context-attachment") {
      return { ok: false, code: "unknown-type", reason: "附件类型未登记" };
    }
    if (!(ATTACHMENT_SOURCES as readonly string[]).includes(input.source)) {
      return { ok: false, code: "invalid-source", reason: "附件来源不允许" };
    }
    const schema = contribution.spec["schema"];
    if (isSchemaObject(schema) && !Value.Check(schema, input.value)) {
      return { ok: false, code: "invalid-schema", reason: "附件内容不符合声明 Schema" };
    }
    if (serializedBytes(input.value) > ATTACHMENT_MAX_VALUE_BYTES) {
      return { ok: false, code: "too-large", reason: `附件超过大小限制（${ATTACHMENT_MAX_VALUE_BYTES} 字节）` };
    }

    if (input.agentId !== undefined) {
      const manifestPermissions = this.deps.registry.getActive(input.pluginId)?.manifestPermissions;
      const capabilities = contribution.requiredCapabilities.filter(
        (capability): capability is CapabilityKind => isKnownCapability(capability),
      );
      if (capabilities.length > 0) {
        const guard = checkCapabilities({
          policy: this.deps.policy,
          pluginId: input.pluginId,
          agentId: input.agentId,
          capabilities,
          manifestPermissions,
          state: input.state,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        });
        if (!guard.allowed) {
          recordCapabilityDenied({
            eventName: "plugin.sandbox.denied",
            pluginId: input.pluginId,
            contributionId: input.typeId,
            agentId: input.agentId,
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            capability: guard.capability,
            deniedBy: guard.deniedBy,
            reason: guard.reason ?? "权限不足",
          });
          return { ok: false, code: "denied", reason: guard.reason ?? "权限不足" };
        }
      }
    }
    return { ok: true };
  }

  /** 附加：验证通过后登记（内存），返回附件记录。 */
  attach(input: {
    readonly pluginId: string;
    readonly typeId: string;
    readonly value: unknown;
    readonly source: string;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly state?: ResolveState;
    readonly snapshot?: PluginExecutionSnapshot;
  }): AttachedAttachment {
    const validation = this.validateAttachment(input);
    if (!validation.ok) {
      throw new Error(`附件附加失败：${validation.reason}`);
    }
    const attachment: AttachedAttachment = {
      attachmentId: `att-${crypto.randomUUID()}`,
      pluginId: input.pluginId,
      typeId: input.typeId,
      value: input.value,
      source: input.source,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      attachedAt: this.now().toISOString(),
      stale: false,
    };
    this.attached.set(attachment.attachmentId, attachment);
    return attachment;
  }

  detach(pluginId: string, attachmentId: string): void {
    const attachment = this.attached.get(attachmentId);
    if (attachment !== undefined && attachment.pluginId === pluginId) {
      this.attached.delete(attachmentId);
    }
  }

  markStale(pluginId: string, attachmentId: string): void {
    const attachment = this.attached.get(attachmentId);
    if (attachment !== undefined && attachment.pluginId === pluginId) {
      this.attached.set(attachmentId, { ...attachment, stale: true });
    }
  }

  listActive(pluginId: string): AttachedAttachment[] {
    return [...this.attached.values()].filter((item) => item.pluginId === pluginId && !item.stale);
  }

  listAll(pluginId: string): AttachedAttachment[] {
    return [...this.attached.values()].filter((item) => item.pluginId === pluginId);
  }

  /**
   * Context Builder 投影接口：插件不能直接修改 Prompt；平台据此把附件
   * 投影给模型。默认实现返回结构化投影（type/source/value 安全摘要）。
   */
  projectAttachment(attachment: AttachedAttachment): { typeId: string; source: string; value: unknown; stale: boolean } {
    return {
      typeId: attachment.typeId,
      source: attachment.source,
      value: attachment.value,
      stale: attachment.stale,
    };
  }

  // ── private helpers ───────────────────────────────────────────

  private toDescriptor(contribution: RegisteredContribution): AttachmentTypeDescriptor | undefined {
    if (contribution.kind !== "context-attachment") {
      return undefined;
    }
    const descriptor: AttachmentTypeDescriptor = {
      pluginId: contribution.pluginId,
      typeId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
    };
    const schema = contribution.spec["schema"];
    return isSchemaObject(schema) ? { ...descriptor, schema } : descriptor;
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
