import type { AbortResult } from "./execution-registry.js";
import type { PromptRun, SessionRuntime } from "./session-runtime.js";

export class PromptService {
  private readonly sessions = new Map<string, SessionRuntime>();

  register(runtime: SessionRuntime): void {
    this.sessions.set(runtime.sessionId, runtime);
  }

  prompt(sessionId: string, text: string): PromptRun {
    return this.require(sessionId).prompt(text);
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
