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
import { instrument } from "../observability/instrument.js";

export interface CreateSessionRequest {
  readonly title: string;
  readonly cwd: string;
  readonly agentId?: string;
  /**
   * 评审 P0（第四轮）：允许调用方预生成 id——HTTP 创建路径需要"审计先行"
   * （fail-closed），在落盘前先以精确 target 写入严格审计。
   */
  readonly id?: string;
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
    /** 归档时的可选回调（记忆系统用它触发 sealed batch 封存，fire-and-forget） */
    private readonly onArchive?: (sessionId: string) => void,
  ) {}

  create(request: CreateSessionRequest): PiSessionHandle {
    const id = request.id ?? crypto.randomUUID();
    // 有 Agent：Session 存入 agents/<id>/sessions/。无 Agent：原有全局 sessions/
    const sessionDir = request.agentId !== undefined
      ? path.join(this.paths.agents, request.agentId, "sessions")
      : this.paths.sessions;
    let session: PiSessionHandle | undefined;
    try {
      session = createPersistentSession(request.cwd, sessionDir, id);
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
      instrument.sessionCreated(id, request.agentId);
      return session;
    } catch (error) {
      const compensationErrors: unknown[] = [];
      this.active.delete(id);
      try {
        session?.dispose();
      } catch (disposeError) {
        compensationErrors.push(disposeError);
      }
      try {
        if (this.index.get(id) !== undefined) {
          this.remove(id);
        } else if (session !== undefined) {
          this.removeSessionFile(session.path);
        }
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
      if (compensationErrors.length > 0) {
        throw new AggregateError(
          [error, ...compensationErrors],
          `Session 创建失败，且补偿清理未完成: ${id}`,
        );
      }
      throw error;
    }
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
    const sessionDir = path.dirname(metadata.sessionPath);
    const session = openPersistentSession(metadata.sessionPath, sessionDir);
    if (session.id !== id) throw new Error("Session 文件身份与索引不一致");
    this.active.set(id, session);
    instrument.sessionOpened(id, metadata.agentId ?? undefined);
    return session;
  }

  continue(id: string): PiSessionHandle {
    return this.open(id);
  }

  /** 审计终态失败时的创建补偿：只删除目标 JSONL，不触碰共享会话目录。 */
  remove(id: string): void {
    const metadata = this.index.get(id);
    if (metadata === undefined) return;
    const active = this.active.get(id);
    active?.dispose();
    this.active.delete(id);
    this.removeSessionFile(metadata.sessionPath);
    this.index.remove(id);
    if (this.index.get(id) !== undefined) {
      throw new Error(`Session 补偿后索引仍存在: ${id}`);
    }
  }

  private removeSessionFile(sessionPath: string): void {
    this.assertSessionPath(sessionPath);
    try {
      fs.rmSync(sessionPath, { force: true, maxRetries: 5, retryDelay: 20 });
    } catch (error) {
      throw new Error(`Session 文件删除失败: ${sessionPath}`, { cause: error });
    }
    if (fs.existsSync(sessionPath)) {
      throw new Error(`Session 补偿后文件仍存在: ${sessionPath}`);
    }
  }

  getView(id: string): SessionView {
    const metadata = this.index.get(id);
    if (!metadata) throw new Error(`Session 不存在: ${id}`);
    return this.toView(metadata);
  }

  archive(id: string): SessionView {
    const current = this.getView(id);
    const archived = this.index.archive(id);
    try {
      this.onArchive?.(id);
    } catch {
      // 封存触发失败不阻塞归档本身
    }
    instrument.sessionArchived(id, archived.agentId ?? undefined);
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

  private isPathWithinRoot(sessionPath: string, root: string): boolean {
    const resolved = path.resolve(sessionPath);
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolved);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private assertSessionPath(sessionPath: string): void {
    if (this.isPathWithinRoot(sessionPath, this.paths.sessions)) return;
    if (this.isPathWithinRoot(sessionPath, this.paths.agents)) return;
    throw new Error("Session 路径不在受控目录内");
  }
}
