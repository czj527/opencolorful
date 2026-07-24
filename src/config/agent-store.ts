import fs from "node:fs";
import path from "node:path";

import { Value } from "typebox/value";

import {
  AgentIdentitySchema,
  AgentProfileSchema,
  defaultProfile,
  type AgentIdentity,
  type AgentProfile,
  type AgentView,
} from "../contracts/agent-identity.js";

export type AgentIdentityPatch = Partial<
  Omit<AgentIdentity, "version" | "id" | "createdAt">
>;

export type AgentProfilePatch = Partial<
  Omit<AgentProfile, "version" | "updatedAt">
>;

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
        // 损坏的 agent 目录跳过
      }
    }
    return views;
  }

  load(agentId: string): AgentView {
    const identity = this.readIdentity(agentId);
    const profile = this.readProfile(agentId);
    const sessionCount = this.countSessions(agentId);
    return { identity, profile, sessionCount };
  }

  create(identity: Omit<AgentIdentity, "version" | "createdAt">): AgentIdentity {
    const id = identity.id;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error("Agent ID 格式无效");
    }
    const dir = this.agentDir(id);
    if (fs.existsSync(dir)) {
      throw new Error("Agent 已存在");
    }

    const full: AgentIdentity = {
      version: 1,
      ...identity,
      createdAt: new Date().toISOString(),
    };

    fs.mkdirSync(dir, { recursive: true });
    this.writeIdentity(id, full);
    return full;
  }

  updateIdentity(agentId: string, patch: AgentIdentityPatch): AgentIdentity {
    const current = this.readIdentity(agentId);
    const next: AgentIdentity = {
      version: 1,
      id: current.id,
      type: patch.type ?? current.type,
      name: patch.name ?? current.name,
      createdAt: current.createdAt,
    };
    this.writeIdentity(agentId, next);
    return next;
  }

  getProfile(agentId: string): AgentProfile | null {
    return this.readProfile(agentId);
  }

  saveProfile(agentId: string, patch: AgentProfilePatch): AgentProfile {
    const current = this.readProfile(agentId);
    const base = current ?? defaultProfile();
    const next: AgentProfile = {
      version: 1,
      persona: patch.persona ?? base.persona,
      personality: patch.personality ?? base.personality,
      replyStyle: patch.replyStyle ?? base.replyStyle,
      updatedAt: new Date().toISOString(),
    };
    this.writeProfile(agentId, next);
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

  private profilePath(agentId: string): string {
    return path.join(this.agentDir(agentId), "profile.json");
  }

  private readIdentity(agentId: string): AgentIdentity {
    const p = this.identityPath(agentId);
    if (!fs.existsSync(p)) throw new Error("Agent 不存在");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Value.Check(AgentIdentitySchema, raw)) {
      throw new Error("Agent identity 数据损坏");
    }
    return raw as AgentIdentity;
  }

  private writeIdentity(agentId: string, identity: AgentIdentity): void {
    const p = this.identityPath(agentId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, p);
  }

  private readProfile(agentId: string): AgentProfile | null {
    const p = this.profilePath(agentId);
    if (!fs.existsSync(p)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!Value.Check(AgentProfileSchema, raw)) return null;
      return raw as AgentProfile;
    } catch {
      return null;
    }
  }

  private writeProfile(agentId: string, profile: AgentProfile): void {
    const p = this.profilePath(agentId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, p);
  }

  private countSessions(agentId: string): number {
    const sessionDir = path.join(this.agentDir(agentId), "sessions");
    if (!fs.existsSync(sessionDir)) return 0;
    return fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl")).length;
  }
}
