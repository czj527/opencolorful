import type { AbortResult } from "./execution-registry.js";
import type { RegenerateRun, PromptRun, SessionRuntime } from "./session-runtime.js";
import type { SessionBranchesChangedReason } from "../contracts/session-branch.js";

export class PromptService {
  private readonly sessions = new Map<string, SessionRuntime>();

  register(runtime: SessionRuntime): void {
    this.sessions.set(runtime.sessionId, runtime);
  }

  prompt(sessionId: string, text: string): PromptRun {
    return this.require(sessionId).prompt(text);
  }

  /** 波次 B2：edit-and-retry 统一重生成原语（与 prompt 共享单飞与 turn 路径） */
  regenerate(sessionId: string, targetEntryId: string, text: string): Promise<RegenerateRun> {
    return this.require(sessionId).regenerate(targetEntryId, text);
  }

  /** 波次 B2：切换当前分支（叶子指针移动 + 分支头持久化 + 会话流事件） */
  switchBranch(sessionId: string, branchId: string): { branchId: string; currentBranchId: string } {
    return this.require(sessionId).switchBranch(branchId);
  }

  /**
   * 波次 B2：在源会话流上广播 branches.changed（fork 用）。runtime 未加载时
   * no-op（fork 语义：不加载源会话也可执行，事件仅对已加载流可达）。
   */
  emitBranchesChanged(sessionId: string, reason: SessionBranchesChangedReason): void {
    this.sessions.get(sessionId)?.emitBranchesChanged(reason);
  }

  abort(sessionId: string, streamId: string): AbortResult {
    return this.require(sessionId).abort(streamId);
  }

  async compact(sessionId: string): Promise<void> {
    await this.require(sessionId).compact();
  }

  hasRuntime(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isBusy(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    return runtime !== undefined && runtime.activeStream() !== undefined;
  }

  invalidate(sessionId: string): "missing" | "removed" | "busy" {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return "missing";
    if (runtime.activeStream() !== undefined) return "busy";
    runtime.dispose();
    this.sessions.delete(sessionId);
    return "removed";
  }

  abortBySession(sessionId: string): AbortResult {
    const runtime = this.require(sessionId);
    const active = runtime.activeStream();
    if (active === undefined) {
      return { status: "already-stopped" };
    }
    return runtime.abort(active);
  }

  dispose(): void {
    for (const runtime of this.sessions.values()) runtime.dispose();
    this.sessions.clear();
  }

  private require(sessionId: string): SessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Session Runtime 不存在: ${sessionId}`);
    return runtime;
  }
}
