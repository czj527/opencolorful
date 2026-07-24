import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import {
  createPersistentSession,
  openPersistentSession,
  type PiMessageEntry,
  type PiSessionHandle,
} from "../pi-sdk/index.js";
import type { SessionIndex, SessionMetadata } from "../storage/session-index.js";

export interface CreateSessionRequest {
  readonly title: string;
  readonly cwd: string;
  readonly agentId?: string;
}

export interface SessionView extends Omit<SessionMetadata, "model" | "provider"> {
  readonly messages: readonly string[];
  readonly messageEntries: readonly PiMessageEntry[];
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
}

export class SessionService {
  private readonly active = new Map<string, PiSessionHandle>();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly index: SessionIndex,
  ) {}

create(request: CreateSessionRequest): PiSessionHandle {
    const id = crypto.randomUUID();
    // 有 Agent：Session 存入 agents/<id>/sessions/。无 Agent：原有全局 sessions/
    const sessionDir = request.agentId !== undefined
      ? path.join(this.paths.agents, request.agentId, "sessions")
      : this.paths.sessions;
    const session = createPersistentSession(request.cwd, sessionDir, id);
    session.setTitle(request.title.trim() || "未命名会话");
    session.persist();
    this.index.create({
      id,
      title: request.title.trim() || "未命名会话",
      sessionPath: session.path,
      createdAt: new Date().toISOString(),
      toolMode: "read-only",
      workspaceCwd: request.cwd,
      agentId: request.agentId ?? null,
    });
    this.active.set(id, session);
    return session;
  }

  list(options: { readonly includeArchived?: boolean; readonly agentId?: string } = {}): SessionView[] {
    const views: SessionView[] = [];
    for (const metadata of this.index.list(options)) {
      try {
        if (options.agentId !== undefined && metadata.agentId !== options.agentId) continue;
        views.push(this.toView(metadata));
      } catch {
        if (!fs.existsSync(metadata.sessionPath)) this.index.remove(metadata.id);
        this.active.delete(metadata.id);
      }
    }
    return views;
  }

  listByAgent(agentId: string): SessionView[] {
    return this.list({ agentId });
  }

  open(id: string): PiSessionHandle {
    const metadata = this.index.get(id);
    if (!metadata) throw new Error(`Session 不存在: ${id}`);
    this.assertSessionPath(metadata.sessionPath);
    const active = this.active.get(id);
    if (active) return active;
    const session = openPersistentSession(metadata.sessionPath, this.paths.sessions);
    if (session.id !== id) throw new Error("Session 文件身份与索引不一致");
    this.active.set(id, session);
    return session;
  }

  continue(id: string): PiSessionHandle {
    return this.open(id);
  }

  getView(id: string): SessionView {
    const metadata = this.index.get(id);
    if (!metadata) throw new Error(`Session 不存在: ${id}`);
    return this.toView(metadata);
  }

  archive(id: string): SessionView {
    const current = this.getView(id);
    const archived = this.index.archive(id);
    return { ...archived, messages: current.messages, messageEntries: current.messageEntries, model: current.model };
  }

  unarchive(id: string): SessionView {
    const current = this.getView(id);
    const restored = this.index.unarchive(id);
    return { ...restored, messages: current.messages, messageEntries: current.messageEntries, model: current.model };
  }

  updateSettings(
    id: string,
    settings: {
      toolMode?: string;
      workspaceCwd?: string;
      workspaceConfirmed?: boolean;
      thinkingLevel?: string;
    },
  ): SessionView {
    this.index.updateSettings(id, settings);
    return this.getView(id);
  }

  closeAll(): void {
    for (const session of this.active.values()) session.dispose();
    this.active.clear();
  }

  private toView(metadata: SessionMetadata): SessionView {
    const session = this.open(metadata.id);
    return { ...metadata, messages: session.messages, messageEntries: session.messageEntries, model: session.model };
  }

  private assertSessionPath(sessionPath: string): void {
    const root = path.resolve(this.paths.sessions);
    const resolved = path.resolve(sessionPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Session 路径不在受控目录内");
    }
  }
}
