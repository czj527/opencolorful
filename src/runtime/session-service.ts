import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import {
  branchTo,
  createPersistentSession,
  forkSessionToNewSession,
  getBranchEntries,
  getLeafEntryId,
  getSessionTree,
  openPersistentSession,
  resolveEntry,
  type PiForkResult,
  type PiMessageEntry,
  type PiSessionHandle,
  type PiSessionTreeNode,
  type PiSessionTreeEntry,
} from "../pi-sdk/index.js";
import { PiSessionTreeError } from "../pi-sdk/index.js";
import type {
  SessionBranchSummary,
  SessionEntriesView,
  SessionEntryView,
  SessionTreeView,
} from "../contracts/session-branch.js";
import { SessionBranchError } from "../contracts/session-branch.js";
import type { SessionTodoItemView } from "../contracts/events.js";
import type { SessionIndex, SessionMetadata } from "../storage/session-index.js";
import type { SessionTodoStore } from "../storage/session-todos.js";
import { registerBranchHeadWriter, unregisterBranchHeadWriter } from "./session-runtime.js";
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
  /** 波次 B2：当前分支叶子条目 id（head 规则应用后的视图叶子；空会话为 null） */
  readonly currentBranchId: string | null;
  /** 波次 B2：当前分支根→叶条目视图（turnId 分组，见 getEntries） */
  readonly entries: readonly SessionEntryView[];
  /**
   * 波次 B5a：会话级 durable todo（position 顺序；从 SQLite session_todos
   * 恢复，未注入 todoStore 或无待办时为空列表）。
   */
  readonly todos: readonly SessionTodoItemView[];
}

/** 分支叶预览截断长度（B2 §4：~80 字符，只读元数据不含完整正文） */
const LEAF_PREVIEW_LIMIT = 80;

function truncatePreview(text: string): string {
  return text.length > LEAF_PREVIEW_LIMIT ? `${text.slice(0, LEAF_PREVIEW_LIMIT)}…` : text;
}

export class SessionService {
  private readonly active = new Map<string, PiSessionHandle>();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly index: SessionIndex,
    /** 归档时的可选回调（记忆系统用它触发 sealed batch 封存，fire-and-forget） */
    private readonly onArchive?: (sessionId: string) => void,
    /**
     * 波次 B5a：durable todo 存储端口（可选注入；注入后 SessionView.todos
     * 从 SQLite session_todos 加载。无 store 时视图恒为空列表）。
     */
    private readonly todoStore?: SessionTodoStore,
  ) {}

  /** 波次 B5a：会话待办视图（未注入 store 时恒为空列表；读取失败降级为空） */
  private loadTodos(sessionId: string): SessionTodoItemView[] {
    if (this.todoStore === undefined) return [];
    try {
      return this.todoStore.list(sessionId);
    } catch {
      // 待办读取失败不阻塞会话视图（重启恢复场景不因局部损坏不可用）
      return [];
    }
  }

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
      registerBranchHeadWriter(id, (sessionId, entryId) => {
        this.index.setBranchHead(sessionId, entryId);
      });
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
    // 波次 B2：分支头写入端口（幂等注册；create 直进 active 的会话也由此覆盖）
    registerBranchHeadWriter(id, (sessionId, entryId) => {
      this.index.setBranchHead(sessionId, entryId);
    });
    const active = this.active.get(id);
    if (active) return active;
    const sessionDir = path.dirname(metadata.sessionPath);
    const session = openPersistentSession(metadata.sessionPath, sessionDir);
    if (session.id !== id) throw new Error("Session 文件身份与索引不一致");
    // 波次 B2（B0 §3.2.3 冻结规则）：SessionManager 打开后应用分支头——
    // 文件序最后 entry 不是 head 的后代（head 之后没有 append）→ 移回 head；
    // 是后代（切换后发生过 append）→ 忽略 head，文件序最后 entry 胜出。
    this.applyBranchHeadRule(session, metadata);
    this.active.set(id, session);
    instrument.sessionOpened(id, metadata.agentId ?? undefined);
    return session;
  }

  continue(id: string): PiSessionHandle {
    return this.open(id);
  }

  /**
   * 波次 B2：分支头应用规则（B0 §3.2.3，只动内存叶子指针，绝不落盘）。
   * 必须在打开后、任何分支移动前调用：此时当前叶子 = 文件序最后 entry。
   */
  private applyBranchHeadRule(handle: PiSessionHandle, metadata: SessionMetadata): void {
    const head = metadata.branchHeadEntryId;
    if (head === null) return;
    const branch = getBranchEntries(handle);
    const fileLast = branch[branch.length - 1];
    if (fileLast === undefined) return;
    // head 出现在文件序最后 entry 的根→叶链上（含自身）→ 是其后代/相等 → 忽略
    if (branch.some((entry) => entry.entryId === head)) return;
    // 防御：head 条目不存在（append-only 下不应发生）→ 忽略，不抛错
    if (resolveEntry(handle, head) === undefined) return;
    try {
      branchTo(handle, head);
    } catch {
      // head 应用失败保持 PI 默认叶子语义（可恢复，不阻塞打开）
    }
  }

  /**
   * 波次 B2：解析用于读取视图的会话句柄。活跃 runtime 句柄优先（避免读到
   * 半写文件）；否则临时打开只读句柄（open + 内存 branchTo 均无 I/O，绝不
   * flush/rewrite），调用方用完必须 dispose。
   */
  private resolveReadHandle(id: string): { handle: PiSessionHandle; metadata: SessionMetadata; dispose: () => void } {
    const metadata = this.index.get(id);
    if (metadata === undefined) {
      throw new SessionBranchError("not_found", `Session 不存在: ${id}`);
    }
    const active = this.active.get(id);
    if (active !== undefined) {
      return { handle: active, metadata, dispose: () => {} };
    }
    this.assertSessionPath(metadata.sessionPath);
    const fresh = openPersistentSession(metadata.sessionPath, path.dirname(metadata.sessionPath));
    this.applyBranchHeadRule(fresh, metadata);
    return { handle: fresh, metadata, dispose: () => fresh.dispose() };
  }

  /** 审计终态失败时的创建补偿：只删除目标 JSONL，不触碰共享会话目录。 */
  remove(id: string): void {
    const metadata = this.index.get(id);
    if (metadata === undefined) return;
    unregisterBranchHeadWriter(id);
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
    return this.withViewEntries(archived, current);
  }

  unarchive(id: string): SessionView {
    const current = this.getView(id);
    const restored = this.index.unarchive(id);
    return this.withViewEntries(restored, current);
  }

  /** archive/unarchive 后用归档前的实时视图补齐消息/模型/分支字段 */
  private withViewEntries(metadata: SessionMetadata, current: SessionView): SessionView {
    return {
      ...metadata,
      messages: current.messages,
      messageEntries: current.messageEntries,
      model: current.model,
      currentBranchId: current.currentBranchId,
      entries: current.entries,
      todos: current.todos,
    };
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

  renameSession(id: string, title: string): SessionView {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session title 不能为空");
    }
    if (trimmed.length > 200) {
      throw new Error("Session title 过长");
    }
    const metadata = this.index.get(id);
    if (!metadata) {
      throw new Error(`Session 不存在: ${id}`);
    }
    const session = this.open(id);
    session.setTitle(trimmed);
    session.persist();
    this.index.updateSettings(id, { title: trimmed });
    return this.getView(id);
  }

  // ── 波次 B2：分支树 / 条目视图 / Fork ────────────────────────────────

  /**
   * 分支树视图：枚举树的全部叶子（无子节点的条目）作为分支，仅保留路径上
   * 含消息条目的分支（新建会话只有 session_info 标题条目，视为空会话）。
   * currentBranchId = head 规则应用后的当前叶子（会话无任何消息时为 null）。
   */
  getTree(id: string): SessionTreeView {
    const { handle, dispose } = this.resolveReadHandle(id);
    try {
      const tree = getSessionTree(handle);
      const leaves: PiSessionTreeNode[] = [];
      const collectLeaves = (nodes: readonly PiSessionTreeNode[]): void => {
        for (const node of nodes) {
          if (node.children.length === 0) leaves.push(node);
          else collectLeaves(node.children);
        }
      };
      collectLeaves(tree);
      const currentLeafId = getLeafEntryId(handle);
      const branches: SessionBranchSummary[] = [];
      for (const leaf of leaves) {
        const branchPath = getBranchEntries(handle, leaf.entry.entryId);
        if (!branchPath.some((entry) => entry.type === "message")) continue;
        branches.push({
          branchId: leaf.entry.entryId,
          leafEntryId: leaf.entry.entryId,
          leafPreview: truncatePreview(leaf.entry.text),
          entryCount: branchPath.length,
          updatedAt: leaf.entry.timestamp,
          isCurrent: leaf.entry.entryId === currentLeafId,
        });
      }
      const currentBranchId = this.resolveViewCurrentBranchId(handle);
      return { currentBranchId, branches };
    } finally {
      dispose();
    }
  }

  /**
   * 会话视图当前分支：PI 叶子为准；全树无任何 message 条目（新建会话仅有
   * session_info 标题条目）的会话视为空 → null。getTree/getEntries/toView 共用。
   */
  private resolveViewCurrentBranchId(handle: PiSessionHandle): string | null {
    const leaf = getLeafEntryId(handle);
    if (leaf === null) return null;
    return hasAnyMessageEntry(handle) ? leaf : null;
  }

  /**
   * 分支条目视图：指定分支（缺省当前分支）的根→叶受控条目，附加
   * turnId = `turn-<userEntryId>`（user message 条目开启 turn，其后条目
   * 继承；首个 user message 之前的条目 turnId 为 null）。未知分支 → 404。
   */
  getEntries(id: string, branchId?: string): SessionEntriesView {
    const { handle, dispose } = this.resolveReadHandle(id);
    try {
      const currentBranchId = this.resolveViewCurrentBranchId(handle);
      const target = branchId ?? currentBranchId;
      if (target === null) {
        return { branchId: null, currentBranchId: null, entries: [] };
      }
      let branch: readonly PiSessionTreeEntry[];
      try {
        branch = getBranchEntries(handle, target);
      } catch (error) {
        if (error instanceof PiSessionTreeError && error.code === "entry_not_found") {
          throw new SessionBranchError("not_found", "引用的会话节点不存在，请刷新后重试");
        }
        throw error;
      }
      return { branchId: target, currentBranchId, entries: buildEntryViews(branch) };
    } finally {
      dispose();
    }
  }

  /**
   * 波次 B2：Fork 成独立会话（B0 §3.2.2）。在分离的 SessionManager 实例上
   * 执行（源会话文件与 runtime 均不受影响），新 SQLite 行记录溯源元数据。
   * 归档 → 409；空源 → 400；未知目标 → 404（busy 由路由层检查）。
   */
  forkSession(id: string, targetEntryId?: string): SessionView {
    const metadata = this.index.get(id);
    if (metadata === undefined) {
      throw new SessionBranchError("not_found", `Session 不存在: ${id}`);
    }
    if (metadata.archived) {
      throw new SessionBranchError("conflict", "会话已归档");
    }
    const { handle, dispose } = this.resolveReadHandle(id);
    let targetLeafEntryId: string | null;
    try {
      // 空会话判定：树上没有任何 message 条目（新建会话仅含 session_info 标题
      // 条目也视为空——用户视角没有可 Fork 的对话内容）
      if (!hasAnyMessageEntry(handle)) {
        throw new SessionBranchError("invalid_input", "空会话无法 Fork");
      }
      targetLeafEntryId = targetEntryId ?? getLeafEntryId(handle);
      if (targetLeafEntryId !== null && resolveEntry(handle, targetLeafEntryId) === undefined) {
        throw new SessionBranchError("not_found", "引用的会话节点不存在，请刷新后重试");
      }
    } finally {
      dispose();
    }
    // Fork 的 cwd 继承源会话工作区；未配置时退回源文件目录（PI 语义兜底）
    const forkCwd = metadata.workspaceCwd ?? path.dirname(metadata.sessionPath);
    let fork: PiForkResult;
    try {
      fork = forkSessionToNewSession(metadata.sessionPath, targetLeafEntryId, forkCwd);
    } catch (error) {
      if (error instanceof PiSessionTreeError) {
        if (error.code === "entry_not_found") {
          throw new SessionBranchError("not_found", "引用的会话节点不存在，请刷新后重试");
        }
        throw new SessionBranchError("invalid_input", "空会话无法 Fork");
      }
      throw error;
    }
    this.index.create({
      id: fork.sessionId,
      title: `${metadata.title}（Fork）`,
      sessionPath: fork.sessionPath,
      createdAt: new Date().toISOString(),
      toolMode: metadata.toolMode,
      ...(metadata.workspaceCwd !== null ? { workspaceCwd: metadata.workspaceCwd } : {}),
      workspaceConfirmed: metadata.workspaceConfirmed,
      thinkingLevel: metadata.thinkingLevel,
      agentId: metadata.agentId,
      sourceSessionId: metadata.id,
      ...(targetLeafEntryId !== null ? { sourceLeafEntryId: targetLeafEntryId } : {}),
    });
    instrument.sessionCreated(fork.sessionId, metadata.agentId ?? undefined);
    return this.getView(fork.sessionId);
  }

  closeAll(): void {
    for (const session of this.active.values()) session.dispose();
    this.active.clear();
  }

  private toView(metadata: SessionMetadata): SessionView {
    const session = this.open(metadata.id);
    const currentBranchId = this.resolveViewCurrentBranchId(session);
    const entries =
      currentBranchId === null
        ? []
        : buildEntryViews(getBranchEntries(session, currentBranchId));
    return {
      ...metadata,
      messages: session.messages,
      messageEntries: session.messageEntries,
      model: session.model,
      currentBranchId,
      entries,
      todos: this.loadTodos(metadata.id),
    };
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

/** 会话树上是否存在任何 message 条目（session_info/label 等簿记条目不算）。 */
function hasAnyMessageEntry(handle: PiSessionHandle): boolean {
  const walk = (nodes: readonly PiSessionTreeNode[]): boolean => {
    for (const node of nodes) {
      if (node.entry.type === "message") return true;
      if (walk(node.children)) return true;
    }
    return false;
  };
  return walk(getSessionTree(handle));
}

/** 把分支路径（根→叶）映射为带 turnId 分组的条目视图。
 * turnId = `turn-<userEntryId>`：user message 条目开启 turn，其后同路径条目
 * 继承；首个 user message 之前的条目 turnId = null（§3.1 确定性标识）。
 */
function buildEntryViews(branch: readonly PiSessionTreeEntry[]): SessionEntryView[] {
  let currentTurnId: string | null = null;
  return branch.map((entry) => {
    if (entry.type === "message" && entry.role === "user") {
      currentTurnId = `turn-${entry.entryId}`;
    }
    return {
      entryId: entry.entryId,
      parentId: entry.parentId,
      turnId: currentTurnId,
      type: entry.type,
      ...(entry.role !== undefined ? { role: entry.role } : {}),
      text: entry.text,
      timestamp: entry.timestamp,
      ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
    };
  });
}
