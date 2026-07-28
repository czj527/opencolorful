import fs from "node:fs";
import path from "node:path";

import { Value } from "typebox/value";

import {
  AgentIdentitySchema,
  BaseColorSchema,
  decorColorFromId,
  defaultBaseColor,
  type AgentIdentity,
  type AgentIdentityPatch,
  type AgentView,
  type BaseColor,
  type BaseColorInput,
  type BaseColorPatch,
} from "../contracts/agent-identity.js";
import {
  AgentSettingsSchema,
  defaultAgentSettings,
  type AgentSettings,
  type AgentSettingsPatch,
  type AgentSettingsV2,
} from "../contracts/agent-settings.js";
import { defaultSandboxCapabilities } from "../contracts/sandbox.js";

export interface CreateAgentInput {
  readonly id: string;
  readonly name: string;
  readonly baseColor: BaseColorInput;
  readonly defaultCwd?: string | null;
}

export interface MigrationReport {
  readonly total: number;
  readonly migrated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failures: readonly MigrationFailure[];
}

interface MigrationFailure {
  readonly agentId: string;
  readonly stage: string;
  readonly error: string;
}

interface MigrationState {
  readonly identityHasType: boolean;
  readonly profileExists: boolean;
  readonly baseColorExists: boolean;
  readonly needsMigration: boolean;
}

function assertValidAgentName(name: string): void {
  const length = name.trim().length;
  if (length < 1 || length > 100) {
    throw new Error("Agent 名称长度必须为 1-100 个字符");
  }
}

export class AgentStore {
  constructor(private readonly agentsDir: string) {}

  list(): AgentView[] {
    this.ensureDir();
    const views: AgentView[] = [];
    for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".archived-")) continue;
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)) continue;

      try {
        views.push(this.load(entry.name));
      } catch {
        // 损坏的 agent 目录跳过（可能需要 migrate）
      }
    }
    return views;
  }

  load(agentId: string): AgentView {
    const identity = this.readIdentity(agentId);
    const baseColor = this.readBaseColor(agentId) ?? defaultBaseColor();
    const settings = this.readSettings(agentId) ?? defaultAgentSettings();
    const sessionCount = this.countSessions(agentId);
    const decorColor = decorColorFromId(identity.id);
    return { identity, baseColor, settings, sessionCount, decorColor };
  }

  create(input: CreateAgentInput): AgentIdentity {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.id)) {
      throw new Error("Agent ID 格式无效");
    }
    assertValidAgentName(input.name);
    const dir = this.agentDir(input.id);
    if (fs.existsSync(dir)) {
      throw new Error("Agent 已存在");
    }

    const now = new Date().toISOString();
    const identity: AgentIdentity = {
      version: 2,
      id: input.id,
      name: input.name,
      createdAt: now,
    };
    const baseColor: BaseColor = {
      version: 1,
      persona: input.baseColor.persona,
      personality: [...input.baseColor.personality],
      replyStyle: input.baseColor.replyStyle,
      innerSetting: input.baseColor.innerSetting,
      updatedAt: now,
    };

    // 原子创建：identity + base-color 同写，任一失败回滚删除整个目录
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.writeIdentity(input.id, identity);
      this.writeBaseColor(input.id, baseColor);
      if (
        input.defaultCwd !== undefined &&
        input.defaultCwd !== null &&
        input.defaultCwd.trim() !== ""
      ) {
        const settings: AgentSettingsV2 = {
          version: 2,
          defaultCwd: input.defaultCwd,
          sandbox: defaultSandboxCapabilities(),
          updatedAt: now,
        };
        this.writeSettings(input.id, settings);
      }
    } catch (error) {
      // 回滚：删除整个 agent 目录，不留半成品
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 回滚失败忽略，抛出原始错误
      }
      throw error;
    }
    return identity;
  }

  updateIdentity(agentId: string, patch: AgentIdentityPatch): AgentIdentity {
    const current = this.readIdentity(agentId);
    if (patch.name !== undefined) assertValidAgentName(patch.name);
    const next: AgentIdentity = {
      version: 2,
      id: current.id,
      name: patch.name ?? current.name,
      createdAt: current.createdAt,
    };
    this.writeIdentity(agentId, next);
    return next;
  }

  getBaseColor(agentId: string): BaseColor {
    this.readIdentity(agentId);
    return this.readBaseColor(agentId) ?? defaultBaseColor();
  }

  saveBaseColor(agentId: string, patch: BaseColorPatch): BaseColor {
    this.readIdentity(agentId);
    const current = this.readBaseColor(agentId);
    const base = current ?? defaultBaseColor();
    const next: BaseColor = {
      version: 1,
      persona: patch.persona ?? base.persona,
      personality: patch.personality ?? base.personality,
      replyStyle: patch.replyStyle ?? base.replyStyle,
      innerSetting: patch.innerSetting ?? base.innerSetting,
      updatedAt: new Date().toISOString(),
    };
    this.writeBaseColor(agentId, next);
    return next;
  }

  getSettings(agentId: string): AgentSettingsV2 {
    this.readIdentity(agentId);
    return this.readSettings(agentId) ?? defaultAgentSettings();
  }

  saveSettings(agentId: string, patch: AgentSettingsPatch): AgentSettingsV2 {
    this.readIdentity(agentId);
    const current = this.readSettings(agentId);
    const base = current ?? defaultAgentSettings();
    const next: AgentSettingsV2 = {
      version: 2,
      defaultCwd: patch.defaultCwd !== undefined ? patch.defaultCwd : base.defaultCwd,
      updatedAt: new Date().toISOString(),
    };
    // 合并 sandbox：patch 显式传入时优先，否则保留已有值或默认值
    const mergedSandbox = this.mergeSandboxCapabilities(
      patch.sandbox,
      base.sandbox,
    );
    if (mergedSandbox !== undefined) {
      next.sandbox = mergedSandbox;
    }
    this.writeSettings(agentId, next);
    return next;
  }

  archive(agentId: string): void {
    const dir = this.agentDir(agentId);
    if (!fs.existsSync(dir)) {
      throw new Error("Agent 不存在");
    }
    const archiveDir = path.join(this.agentsDir, `.archived-${agentId}`);
    fs.renameSync(dir, archiveDir);
  }

  /**
   * 迁移旧 Agent 数据到新格式。幂等、可恢复、单 agent 失败不阻塞其他。
   * 应在 Server 启动时调用一次（AgentStore 构造后）。
   *
   * 处理：
   * - 旧 identity.json（含 type 字段，version 1）→ 重写为 version 2 无 type
   * - 旧 profile.json → 读 persona/personality/replyStyle，写 base-color.json（补 innerSetting=""），删除 profile.json
   * - 缺 profile 的 Agent → 创建空白 base-color.json
   * - 已迁移的跳过
   */
  migrate(): MigrationReport {
    this.ensureDir();
    const failures: MigrationFailure[] = [];
    let migrated = 0;
    let skipped = 0;
    let total = 0;

    const entries = fs.readdirSync(this.agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".archived-")) continue;
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)) continue;
      total++;

      const agentId = entry.name;
      try {
        const state = this.collectMigrationState(agentId);
        if (!state.needsMigration) {
          skipped++;
          continue;
        }
        this.migrateAgent(agentId, state);
        migrated++;
      } catch (error) {
        failures.push({
          agentId,
          stage: "migrate",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { total, migrated, skipped, failed: failures.length, failures };
  }

  // -- private helpers ---

  private ensureDir(): void {
    fs.mkdirSync(this.agentsDir, { recursive: true });
  }

  private agentDir(agentId: string): string {
    if (agentId.includes("..") || agentId.includes("/") || agentId.includes("\\")) {
      throw new Error("Agent ID 不允许包含路径字符");
    }
    return path.join(this.agentsDir, agentId);
  }

  private identityPath(agentId: string): string {
    return path.join(this.agentDir(agentId), "identity.json");
  }

  private baseColorPath(agentId: string): string {
    return path.join(this.agentDir(agentId), "base-color.json");
  }

  private settingsPath(agentId: string): string {
    return path.join(this.agentDir(agentId), "settings.json");
  }

  private profilePath(agentId: string): string {
    return path.join(this.agentDir(agentId), "profile.json");
  }

  private readIdentity(agentId: string): AgentIdentity {
    const p = this.identityPath(agentId);
    if (!fs.existsSync(p)) throw new Error("Agent 不存在");
    const raw = this.readRawJson(p);
    if (!Value.Check(AgentIdentitySchema, raw)) {
      throw new Error("Agent identity 数据损坏（可能需要运行 migrate）");
    }
    return raw as AgentIdentity;
  }

  private writeIdentity(agentId: string, identity: AgentIdentity): void {
    this.atomicWrite(this.identityPath(agentId), identity);
  }

  private readBaseColor(agentId: string): BaseColor | null {
    const p = this.baseColorPath(agentId);
    if (!fs.existsSync(p)) return null;
    try {
      const raw = this.readRawJson(p);
      if (!Value.Check(BaseColorSchema, raw)) return null;
      return raw as BaseColor;
    } catch {
      return null;
    }
  }

  private writeBaseColor(agentId: string, baseColor: BaseColor): void {
    this.atomicWrite(this.baseColorPath(agentId), baseColor);
  }

  private readSettings(agentId: string): AgentSettingsV2 | null {
    const p = this.settingsPath(agentId);
    if (!fs.existsSync(p)) return null;
    try {
      const raw = this.readRawJson(p);
      if (!Value.Check(AgentSettingsSchema, raw)) return null;
      const settings = raw as AgentSettings;
      // v1 → v2 自动迁移：补 sandbox 默认值，升级 version，写回磁盘
      if (settings.version === 1) {
        const migrated: AgentSettingsV2 = {
          version: 2,
          defaultCwd: settings.defaultCwd,
          sandbox: defaultSandboxCapabilities(),
          updatedAt: settings.updatedAt,
        };
        this.writeSettings(agentId, migrated);
        return migrated;
      }
      return settings as AgentSettingsV2;
    } catch {
      return null;
    }
  }

  private writeSettings(agentId: string, settings: AgentSettingsV2): void {
    this.atomicWrite(this.settingsPath(agentId), settings);
  }

  /**
   * 原子写入：先写 tmp 文件，再 rename 覆盖目标。避免半写入状态。
   */
  private atomicWrite(filePath: string, data: unknown): void {
    this.atomicWriteText(filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  private atomicWriteText(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
  }

  private readRawJson(filePath: string): Record<string, unknown> {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`JSON 不是对象: ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  }

  private collectMigrationState(agentId: string): MigrationState {
    const rawIdentity = this.readRawJson(this.identityPath(agentId));
    const identityHasType = "type" in rawIdentity;
    if (!identityHasType && !Value.Check(AgentIdentitySchema, rawIdentity)) {
      throw new Error("Agent identity 数据损坏，无法迁移");
    }
    const baseColorExists = fs.existsSync(this.baseColorPath(agentId));
    const profileExists = fs.existsSync(this.profilePath(agentId));
    return {
      identityHasType,
      profileExists,
      baseColorExists,
      needsMigration: identityHasType || !baseColorExists,
    };
  }

  private migrateAgent(agentId: string, state: MigrationState): void {
    const identityPath = this.identityPath(agentId);
    const baseColorPath = this.baseColorPath(agentId);
    const profilePath = this.profilePath(agentId);
    const originalFiles = new Map<string, string | null>([
      [identityPath, fs.readFileSync(identityPath, "utf8")],
      [baseColorPath, fs.existsSync(baseColorPath) ? fs.readFileSync(baseColorPath, "utf8") : null],
      [profilePath, fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : null],
    ]);

    // 先完整读取并校验所有输出，任何准备失败都不能改写原文件。
    let newIdentity: AgentIdentity | null = null;
    if (state.identityHasType) {
      const raw = this.readRawJson(identityPath);
      const id = typeof raw.id === "string" ? raw.id : agentId;
      const name = typeof raw.name === "string" ? raw.name : "";
      const createdAt =
        typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
      newIdentity = { version: 2, id, name, createdAt };
      if (!Value.Check(AgentIdentitySchema, newIdentity)) {
        throw new Error("旧 Agent identity 无法转换为 version 2");
      }
    }

    let newBaseColor: BaseColor | null = null;
    if (!state.baseColorExists) {
      if (state.profileExists) {
        // 旧 profile.json → base-color.json，补空 innerSetting
        const profile = this.readRawJson(profilePath);
        newBaseColor = {
          version: 1,
          persona: typeof profile.persona === "string" ? profile.persona : "",
          personality: Array.isArray(profile.personality)
            ? profile.personality.filter((p): p is string => typeof p === "string")
            : [],
          replyStyle: typeof profile.replyStyle === "string" ? profile.replyStyle : "",
          innerSetting: "", // 旧 profile 无此字段，补空
          updatedAt: new Date().toISOString(),
        };
      } else {
        // 缺 profile 的 Agent → 创建空白底色
        newBaseColor = defaultBaseColor();
      }
      if (!Value.Check(BaseColorSchema, newBaseColor)) {
        throw new Error("旧 Agent profile 无法转换为 base-color");
      }
    }

    try {
      if (newBaseColor !== null) this.writeBaseColor(agentId, newBaseColor);
      if (newIdentity !== null) this.writeIdentity(agentId, newIdentity);
      if (newBaseColor !== null && state.profileExists) fs.unlinkSync(profilePath);
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const [filePath, original] of originalFiles) {
        try {
          if (original === null) {
            fs.rmSync(filePath, { force: true });
          } else {
            this.atomicWriteText(filePath, original);
          }
        } catch (rollbackError) {
          rollbackFailures.push(
            `${path.basename(filePath)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      if (rollbackFailures.length > 0) {
        const originalMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`${originalMessage}；迁移回滚失败：${rollbackFailures.join("；")}`);
      }
      throw error;
    }
  }

  private mergeSandboxCapabilities(
    patch: AgentSettingsPatch["sandbox"],
    base: AgentSettingsV2["sandbox"],
  ): AgentSettingsV2["sandbox"] {
    // patch 为 undefined → 保留已有值（不覆盖）
    if (patch === undefined) return base;
    // patch 为 null → 显式移除沙箱配置
    if (patch === null) return undefined;
    // patch 为对象 → 合并：patch 字段优先，缺失字段从 base 回退
    return {
      workspaceAccess: patch.workspaceAccess ?? base?.workspaceAccess ?? "rw",
      extraReadPaths: patch.extraReadPaths ?? base?.extraReadPaths ?? [],
      protectedPaths: patch.protectedPaths ?? base?.protectedPaths ?? [],
    };
  }

  private countSessions(agentId: string): number {
    const sessionDir = path.join(this.agentDir(agentId), "sessions");
    if (!fs.existsSync(sessionDir)) return 0;
    return fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl")).length;
  }
}
