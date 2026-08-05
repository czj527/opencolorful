import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type Static, Type } from "typebox";
import Value from "typebox/value";

import type { RuntimePaths } from "../../../config/paths.js";
import { SkillRefSchema, type SkillRef } from "../../../contracts/skill-protocol.js";
import { SkillError } from "../errors.js";
import { safeJoin } from "../path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 Agent skills.json 服务（plans/phase-13.md §9.4 / §11.6）
//
// agents/<agentId>/skills.json 是 Agent 持久绑定、Bundle 和学习策略的
// **唯一事实来源**（agent_skill_binding_index 只是可重建的查询投影）。
//
// 文件结构：
// {
//   schemaVersion: 1,
//   bundleBindings: [{ bundleId, version, pinned }],   // Bundle 版本绑定
//   directSkillRefs: SkillRef[],                       // 直接固定 SkillRef
//   overrides: { skillRefKey: selection },             // 单 Skill 选择覆盖
//   learningPolicy: "disabled" | "ask-always" | "ask-on-risk",
//   migratedFrom?: string,                             // 旧数据迁移来源标记
//   updatedAt: string
// }
//
// 硬性保证：
// - 原子写（temp + rename）；损坏 fail-closed（抛错，不静默丢弃绑定）；
// - 保存前 TypeBox 校验；schemaVersion 高于当前 → 拒绝（fail-closed）；
// - 无 schemaVersion 的旧结构按 legacy 迁移到 v1（migratedFrom 记录）；
// - Workspace Skill 不写入本文件（只有显式绑定/覆盖进入）。
// ═══════════════════════════════════════════════════════════════

export const AGENT_SKILLS_SCHEMA_VERSION = 1;

export const SKILL_LEARNING_POLICIES = ["disabled", "ask-always", "ask-on-risk"] as const;
export type SkillLearningPolicy = (typeof SKILL_LEARNING_POLICIES)[number];

export const SkillLearningPolicySchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("ask-always"),
  Type.Literal("ask-on-risk"),
]);

/** 持久化选择模式（shadowed 是解析产物，不落盘）。 */
const PERSISTED_SELECTION_SCHEMA = Type.Union([
  Type.Literal("implicit"),
  Type.Literal("explicit-only"),
  Type.Literal("disabled"),
]);

export const AgentSkillBundleBindingSchema = Type.Object(
  {
    bundleId: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    /** Bundle 绑定默认 pinned=true（固定版本语义） */
    pinned: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AgentSkillBundleBinding = Static<typeof AgentSkillBundleBindingSchema>;

export const AgentSkillConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(AGENT_SKILLS_SCHEMA_VERSION),
    bundleBindings: Type.Array(AgentSkillBundleBindingSchema, { maxItems: 256 }),
    directSkillRefs: Type.Array(SkillRefSchema, { maxItems: 512 }),
    /** skillRefKey（skillId@sourceId@version）→ 选择模式 */
    overrides: Type.Record(Type.String({ minLength: 1, maxLength: 512 }), PERSISTED_SELECTION_SCHEMA),
    learningPolicy: SkillLearningPolicySchema,
    migratedFrom: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    updatedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);
export type AgentSkillConfig = Static<typeof AgentSkillConfigSchema>;

export function defaultAgentSkillConfig(): AgentSkillConfig {
  return {
    schemaVersion: AGENT_SKILLS_SCHEMA_VERSION,
    bundleBindings: [],
    directSkillRefs: [],
    overrides: {},
    learningPolicy: "ask-on-risk",
  };
}

/** skillRefKey 基本格式校验：skillId@sourceId@version 三段非空。 */
export function isValidSkillRefKey(key: string): boolean {
  if (typeof key !== "string" || key.length < 3 || key.length > 512) {
    return false;
  }
  const parts = key.split("@");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/** overrides 只持久化三种明确选择（shadowed 是解析产物，不落盘）。 */
type PersistedSelectionValue = "implicit" | "explicit-only" | "disabled";

export class AgentSkillConfigStore {
  constructor(private readonly paths: RuntimePaths) {}

  /** agents/<agentId>/skills.json（safeJoin 防路径逃逸）。 */
  filePathFor(agentId: string): string {
    assertAgentId(agentId);
    return safeJoin(this.paths.agents, agentId, "skills.json");
  }

  /**
   * 读取 Agent 持久绑定配置。
   * - 文件缺失 → 默认空配置（未绑定任何 Skill/Bundle）；
   * - 文件存在但损坏（JSON/结构非法）→ fail-closed 抛错，不静默丢失绑定；
   * - schemaVersion 缺失/为 0 → legacy 迁移到 v1（migratedFrom 标记）。
   */
  getSkillsConfig(agentId: string): AgentSkillConfig {
    const file = this.filePathFor(agentId);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultAgentSkillConfig();
      }
      throw new SkillError("skill_operation_failed", `Agent skills.json 损坏，fail-closed 拒绝读取（${agentId}）`);
    }
    return parseAgentSkillConfig(raw, file);
  }

  /** 保存前 TypeBox 校验 + 原子写（temp + rename）。 */
  saveSkillsConfig(agentId: string, config: AgentSkillConfig): void {
    if (!Value.Check(AgentSkillConfigSchema, config)) {
      throw new SkillError("skill_operation_failed", "Agent skills.json 内容非法，拒绝写入（保存前校验失败）");
    }
    const file = this.filePathFor(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = path.join(path.dirname(file), `.skills-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      fs.renameSync(tempFile, file);
    } catch (error) {
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        // 清理失败不掩盖原错误
      }
      throw error;
    }
  }
}

// ── 解析（跨函数边界输入显式校验，fail-closed） ─────────────────

function parseAgentSkillConfig(input: unknown, file: string): AgentSkillConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SkillError("skill_operation_failed", `Agent skills.json 结构非法，fail-closed 拒绝读取（${file}）`);
  }
  const raw = input as Record<string, unknown>;
  const schemaVersion = raw["schemaVersion"];

  if (schemaVersion === undefined || schemaVersion === 0) {
    // legacy（v1 之前）：无 schemaVersion 或显式 0 → 迁移到 v1
    const migrated = migrateLegacyConfig(raw);
    if (!Value.Check(AgentSkillConfigSchema, migrated)) {
      throw new SkillError("skill_operation_failed", `Agent skills.json 旧格式迁移失败，fail-closed 拒绝读取（${file}）`);
    }
    return migrated;
  }
  if (typeof schemaVersion !== "number" || schemaVersion > AGENT_SKILLS_SCHEMA_VERSION) {
    throw new SkillError("skill_operation_failed", `Agent skills.json schemaVersion（${String(schemaVersion)}）高于当前支持（${AGENT_SKILLS_SCHEMA_VERSION}），fail-closed 拒绝读取（${file}）`);
  }
  if (!Value.Check(AgentSkillConfigSchema, input)) {
    throw new SkillError("skill_operation_failed", `Agent skills.json 内容非法，fail-closed 拒绝读取（${file}）`);
  }
  return input as AgentSkillConfig;
}

/** legacy 迁移：接受无 schemaVersion 的 { bundleBindings, directSkillRefs, overrides, learningPolicy }。 */
function migrateLegacyConfig(raw: Record<string, unknown>): AgentSkillConfig {
  const bundleBindings: unknown[] = Array.isArray(raw["bundleBindings"]) ? raw["bundleBindings"] : [];
  const directSkillRefs: unknown[] = Array.isArray(raw["directSkillRefs"]) ? raw["directSkillRefs"] : [];
  const overridesRaw = raw["overrides"];
  const overrides: Record<string, unknown> =
    typeof overridesRaw === "object" && overridesRaw !== null && !Array.isArray(overridesRaw)
      ? (overridesRaw as Record<string, unknown>)
      : {};
  const learningPolicy = raw["learningPolicy"];

  const config: AgentSkillConfig = {
    schemaVersion: AGENT_SKILLS_SCHEMA_VERSION,
    bundleBindings: bundleBindings as unknown as AgentSkillBundleBinding[],
    directSkillRefs: directSkillRefs as unknown as SkillRef[],
    overrides: overrides as unknown as Record<string, PersistedSelectionValue>,
    learningPolicy: (SKILL_LEARNING_POLICIES as readonly string[]).includes(String(learningPolicy))
      ? (learningPolicy as SkillLearningPolicy)
      : "ask-on-risk",
    migratedFrom: typeof raw["migratedFrom"] === "string" && raw["migratedFrom"].length > 0 ? String(raw["migratedFrom"]) : "legacy",
    ...(typeof raw["updatedAt"] === "string" ? { updatedAt: raw["updatedAt"] as string } : {}),
  };
  return config;
}

function assertAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.length < 1 || agentId.length > 128) {
    throw new SkillError("skill_agent_unauthorized", "Agent ID 不合法");
  }
}
