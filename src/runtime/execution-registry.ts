import crypto from "node:crypto";

export type AbortResult =
  | { readonly status: "accepted" }
  | { readonly status: "already-stopped" }
  | { readonly status: "rejected" };

export type ExecutionStartResult =
  | {
      readonly status: "accepted";
      readonly streamId: string;
      readonly completed: Promise<void>;
    }
  | { readonly status: "rejected"; readonly reason: "already-running" };

interface ExecutionRecord {
  readonly streamId: string;
  readonly controller: AbortController;
  status: "running" | "aborting" | "finished";
  readonly completed: Promise<void>;
  readonly resolve: () => void;
}

export class ExecutionRegistry {
  private readonly executions = new Map<string, ExecutionRecord>();

  start(sessionId: string, controller: AbortController): ExecutionStartResult {
    const current = this.executions.get(sessionId);
    if (current && current.status !== "finished") {
      return { status: "rejected", reason: "already-running" };
    }

    let resolve = () => {};
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const record: ExecutionRecord = {
      streamId: `stream-${crypto.randomUUID()}`,
      controller,
      status: "running",
      completed,
      resolve,
    };
    this.executions.set(sessionId, record);
    return { status: "accepted", streamId: record.streamId, completed };
  }

  abort(sessionId: string, streamId: string): AbortResult {
    const current = this.executions.get(sessionId);
    if (!current || current.streamId !== streamId) return { status: "rejected" };
    if (current.status !== "running") return { status: "already-stopped" };
    current.status = "aborting";
    current.controller.abort();
    return { status: "accepted" };
  }

  finish(sessionId: string, streamId: string): void {
    const current = this.executions.get(sessionId);
    if (!current || current.streamId !== streamId) return;
    current.status = "finished";
    current.resolve();
  }

  activeStream(sessionId: string): string | undefined {
    const current = this.executions.get(sessionId);
    return current && current.status !== "finished" ? current.streamId : undefined;
  }
}
