import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionActivityInput, ExtensionActivityResult, ExtensionObservabilityPort, TraceCarrier } from "../../src/observability/extension-port.js";
import { ContributionRegistry } from "../../src/runtime/plugins/contributions/contribution-registry.js";
import { AttachmentService } from "../../src/runtime/plugins/contributions/attachment-contribution.js";
import { CustomActivityService } from "../../src/runtime/plugins/contributions/custom-activity-contribution.js";
import { SkillBundleService } from "../../src/runtime/plugins/contributions/skill-bundle.js";
import { EffectivePolicy } from "../../src/runtime/plugins/grants/effective-policy.js";
import {
  bindAgent,
  cleanupT5,
  createT5Env,
  grantCapabilities,
  installPlugin,
  queryActivity,
  type T5Env,
} from "./plugin-t5-helper.js";

// ═══════════════════════════════════════════════════════════════
// T5 Attachment / Custom Activity / Skill Bundle（plans/phase-12.md §8.8/§8.9/§8.10）
// - 附件：Schema/大小/来源/权限校验；可删除、可显示来源、可标记 stale；
// - Custom Activity：只能 routine，不能生成 Audit/notable/milestone；
// - Skill Bundle：只登记不激活。
// ═══════════════════════════════════════════════════════════════

const PLUGIN = "example.attach";
const AGENT = "agent-a";

class MockPort implements ExtensionObservabilityPort {
  readonly calls: Array<{ eventName: string; summaryCode: string; attributes?: Record<string, unknown> }> = [];
  private readonly accept: boolean;

  constructor(accept = true) {
    this.accept = accept;
  }

  diagnostic(): void {
    // no-op
  }

  activity(input: ExtensionActivityInput): ExtensionActivityResult {
    this.calls.push({
      eventName: input.eventName,
      summaryCode: input.summaryCode,
      ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
    });
    return this.accept ? { kind: "accepted", eventId: "mock-event-1" } : { kind: "rejected", reason: "mock rejected" };
  }

  traceCarrier(): TraceCarrier | undefined {
    return undefined;
  }

  close(): void {
    // no-op
  }
}

function installAttachmentPlugin(env: T5Env) {
  installPlugin(env, {
    pluginId: PLUGIN,
    version: "1.0.0",
    permissions: [{ capability: "activity.emit" }],
    contributions: {
      "context-attachment": [
        { id: "file", name: "File", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
      ],
      "custom-activity": [
        { id: "stats", name: "Stats", eventNamespace: "plugin.example.stats", payloadSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } },
      ],
      "skill-bundle": [{ id: "skills", name: "Skills", skillsDir: "skills" }],
    },
  });
}

afterEach(() => {
  cleanupT5();
});

describe("AttachmentService：登记与校验", () => {
  it("listTypes/getType 可查询登记的附件类型", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    await env.hostApi.activate(PLUGIN);
    expect(env.hostApi.attachments.listTypes()).toHaveLength(1);
    expect(env.hostApi.attachments.getType(PLUGIN, "file")?.name).toBe("File");
  });

  it("validateAttachment：Schema 校验失败 → invalid-schema", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const result = env.hostApi.attachments.validateAttachment({
      pluginId: PLUGIN,
      typeId: "file",
      value: { name: 42 },
      source: "user",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-schema");
    }
  });

  it("validateAttachment：来源不允许 → invalid-source", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const result = env.hostApi.attachments.validateAttachment({
      pluginId: PLUGIN,
      typeId: "file",
      value: { name: "x" },
      source: "malicious",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-source");
    }
  });

  it("validateAttachment：未登记类型 → unknown-type", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const result = env.hostApi.attachments.validateAttachment({
      pluginId: PLUGIN,
      typeId: "missing",
      value: { name: "x" },
      source: "user",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown-type");
    }
  });

  it("attach/detach/markStale/listActive 生命周期", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const attachment = env.hostApi.attachments.attach({
      pluginId: PLUGIN,
      typeId: "file",
      value: { name: "report.pdf" },
      source: "user",
      agentId: AGENT,
    });
    expect(attachment.stale).toBe(false);
    expect(env.hostApi.attachments.listActive(PLUGIN)).toHaveLength(1);
    env.hostApi.attachments.markStale(PLUGIN, attachment.attachmentId);
    expect(env.hostApi.attachments.listActive(PLUGIN)).toHaveLength(0);
    expect(env.hostApi.attachments.listAll(PLUGIN)).toHaveLength(1);
    env.hostApi.attachments.detach(PLUGIN, attachment.attachmentId);
    expect(env.hostApi.attachments.listAll(PLUGIN)).toHaveLength(0);
  });

  it("projectAttachment 只返回结构化投影（不改 Prompt）", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const attachment = env.hostApi.attachments.attach({
      pluginId: PLUGIN,
      typeId: "file",
      value: { name: "report.pdf" },
      source: "user",
    });
    const projection = env.hostApi.attachments.projectAttachment(attachment);
    expect(projection.typeId).toBe("file");
    expect(projection.source).toBe("user");
    expect(projection.value).toEqual({ name: "report.pdf" });
    expect(projection.stale).toBe(false);
  });
});

describe("CustomActivityService：routine-only 与平台盖章", () => {
  it("合法 emit 经受限端口发出（端口负责平台重新盖章）", async () => {
    const port = new MockPort();
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        "custom-activity": [{ id: "stats", name: "Stats", eventNamespace: "plugin.example.stats", payloadSchema: { type: "object" } }],
      },
    });
    const service = new CustomActivityService({ registry, portFactory: () => port });
    const result = service.emit({ pluginId: PLUGIN, eventNamespace: "plugin.example.stats", action: "incremented", payload: { count: 1 } });
    expect(result.ok).toBe(true);
    expect(port.calls[0]?.eventName).toBe("plugin.example.stats.incremented");
  });

  it("未登记的 eventNamespace → unknown-event", async () => {
    const port = new MockPort();
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        "custom-activity": [{ id: "stats", name: "Stats", eventNamespace: "plugin.example.stats" }],
      },
    });
    const service = new CustomActivityService({ registry, portFactory: () => port });
    const result = service.emit({ pluginId: PLUGIN, eventNamespace: "plugin.other.events", action: "x", payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown-event");
    }
    expect(port.calls).toHaveLength(0);
  });

  it("payload 携带平台权威字段（actor/scope/significance/audit）→ forged-fields", async () => {
    const port = new MockPort();
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        "custom-activity": [{ id: "stats", name: "Stats", eventNamespace: "plugin.example.stats" }],
      },
    });
    const service = new CustomActivityService({ registry, portFactory: () => port });
    for (const key of ["actor", "scope", "significance", "audit", "eventId", "trace"]) {
      const result = service.emit({
        pluginId: PLUGIN,
        eventNamespace: "plugin.example.stats",
        action: "x",
        payload: { [key]: "forged" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("forged-fields");
      }
    }
    expect(port.calls).toHaveLength(0);
  });

  it("payload 不符合声明 Schema → invalid-payload", async () => {
    const port = new MockPort();
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        "custom-activity": [{ id: "stats", name: "Stats", eventNamespace: "plugin.example.stats", payloadSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } }],
      },
    });
    const service = new CustomActivityService({ registry, portFactory: () => port });
    const result = service.emit({ pluginId: PLUGIN, eventNamespace: "plugin.example.stats", action: "x", payload: { count: "not-int" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-payload");
    }
  });

  it("非法 action 段 → invalid-action", async () => {
    const port = new MockPort();
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        "custom-activity": [{ id: "stats", name: "Stats", eventNamespace: "plugin.example.stats" }],
      },
    });
    const service = new CustomActivityService({ registry, portFactory: () => port });
    const result = service.emit({ pluginId: PLUGIN, eventNamespace: "plugin.example.stats", action: "Bad Action!", payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-action");
    }
  });

  it("端口拒绝 → rejected（不吞错误）", async () => {
    const port = new MockPort(false);
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: PLUGIN,
      version: "1.0.0",
      contributions: {
        "custom-activity": [{ id: "stats", name: "Stats", eventNamespace: "plugin.example.stats" }],
      },
    });
    const service = new CustomActivityService({ registry, portFactory: () => port });
    const result = service.emit({ pluginId: PLUGIN, eventNamespace: "plugin.example.stats", action: "x", payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rejected");
    }
  });

  it("Custom Activity 不产生 Audit（事件目录无自定义事件登记）", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    grantCapabilities(env, PLUGIN, ["activity.emit"]);
    bindAgent(env, AGENT, PLUGIN);
    await env.hostApi.activate(PLUGIN);
    // 真实端口要求事件在目录且 extension-allowed → 自定义事件当前返回 rejected
    const result = env.hostApi.customActivity.emit({
      pluginId: PLUGIN,
      eventNamespace: "plugin.example.stats",
      action: "incremented",
      payload: { count: 1 },
    });
    expect(result.ok).toBe(false); // 目录未登记扩展事件（T10 接线）
    const audits = env.db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_name LIKE 'plugin.example%'").get() as { c: number };
    expect(audits.c).toBe(0);
  });
});

describe("SkillBundleService：inventory-only", () => {
  it("只登记不激活；UI 显示等待技能系统支持", async () => {
    const env = createT5Env();
    installAttachmentPlugin(env);
    await env.hostApi.activate(PLUGIN);
    const skills = env.hostApi.skills.list(PLUGIN);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.skillsDir).toBe("skills");
    expect(env.hostApi.skills.isActivated()).toBe(false);
    expect(env.hostApi.skills.statusText()).toBe("等待技能系统支持");
    expect(env.hostApi.skills.listAll()).toHaveLength(1);
  });

  it("未声明 skill-bundle 的插件返回空列表", async () => {
    const env = createT5Env();
    installPlugin(env, { pluginId: "example.no-skill", version: "1.0.0", contributions: {} });
    await env.hostApi.activate("example.no-skill");
    expect(env.hostApi.skills.list("example.no-skill")).toEqual([]);
  });
});
