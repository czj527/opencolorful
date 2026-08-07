import { describe, expect, it } from "vitest";

import type { ParentContinuationOutcome } from "../../src/runtime/subagents/mailbox/parent-session-port.js";
import {
  SessionRuntimeParentSessionPort,
  type ParentSessionRuntimeFacade,
} from "../../src/runtime/subagents/runtime/parent-session-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 T5：父 SessionRuntime 适配器测试（plans/phase-14.md §14.2 / §T5 交付 2）
//
// 覆盖：
// - "空闲且可运行"判定（无 in-flight prompt/steer、无未消费 abort、
//   未归档/删除）；
// - startContinuation 三种终态语义：triggered / interrupted（用户打断）/
//   rejected（未触发，可重试）；
// - 用户消息优先（noteUserMessage 中止 in-flight continuation，不插队）；
// - 同一 Session 至多一个并发 continuation（内部 guard）；
// - prompt 槽被用户消息抢占 → rejected/parent_session_busy。
// ═══════════════════════════════════════════════════════════════

/** SessionRuntime 公共 API 窄面的 Faux 实现（结构兼容） */
class FakeRuntime implements ParentSessionRuntimeFacade {
  readonly sessionId = "sess-main";
  /** 模拟用户消息已占用 prompt 槽（activeStream 非空） */
  userBusy = false;
  readonly prompts: string[] = [];
  readonly abortedStreams: string[] = [];
  private current: { streamId: string; resolve: () => void } | null = null;
  private seq = 0;

  activeStream(): string | undefined {
    if (this.current !== null) return this.current.streamId;
    if (this.userBusy) return "stream-user-active";
    return undefined;
  }

  prompt(text: string): { streamId: string; completed: Promise<void> } {
    if (this.current !== null || this.userBusy) {
      throw new Error("Session 已有运行中的 Prompt");
    }
    this.seq += 1;
    const streamId = `stream-c${this.seq}`;
    this.prompts.push(text);
    let resolve = (): void => undefined;
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    this.current = { streamId, resolve };
    return { streamId, completed };
  }

  abort(streamId: string): void {
    this.abortedStreams.push(streamId);
  }

  /** 测试：让当前 continuation 结束（模拟模型 Turn 正常完成/被 abort 后 settle） */
  finishCurrent(): void {
    const current = this.current;
    this.current = null;
    current?.resolve();
  }
}

function createPort(options: { getSessionState?: () => "active" | "archived" | "deleted" } = {}): {
  runtime: FakeRuntime;
  port: SessionRuntimeParentSessionPort;
} {
  const runtime = new FakeRuntime();
  const port = new SessionRuntimeParentSessionPort({
    runtime,
    ownerAgentId: "agent-a",
    ...(options.getSessionState !== undefined ? { getSessionState: options.getSessionState } : {}),
  });
  return { runtime, port };
}

function outcomeOf(result: ParentContinuationOutcome): string {
  return result.status === "rejected" ? `rejected:${result.reasonCode}` : result.status;
}

describe("父 Session 空闲且可运行判定（§T5 交付 2）", () => {
  it("空闲（无 in-flight、无 abort pending、未归档）→ 可运行", () => {
    const { port } = createPort();
    expect(port.getStatus()).toBe("idle");
    expect(port.isIdleAndRunnable()).toBe(true);
  });

  it("用户消息占用 prompt 槽（in-flight prompt/steer）→ busy，不可运行", () => {
    const { runtime, port } = createPort();
    runtime.userBusy = true;
    expect(port.getStatus()).toBe("busy");
    expect(port.isIdleAndRunnable()).toBe(false);
  });

  it("用户 stop（未消费 abort）→ 不可运行；下一条用户消息消费后恢复", async () => {
    const { port } = createPort();
    port.noteUserAbort();
    expect(port.isIdleAndRunnable()).toBe(false);
    const outcome = await port.startContinuation({ text: "t", operationId: "op-1" });
    expect(outcomeOf(outcome)).toBe("rejected:parent_session_abort_pending");
    port.noteUserMessage(); // 用户新消息消费 abort
    expect(port.isIdleAndRunnable()).toBe(true);
  });

  it("父 Session archived/deleted → 不可运行", () => {
    const { port } = createPort({ getSessionState: () => "archived" });
    expect(port.getStatus()).toBe("archived");
    expect(port.isIdleAndRunnable()).toBe(false);
    const { port: deleted } = createPort({ getSessionState: () => "deleted" });
    expect(deleted.getStatus()).toBe("deleted");
    expect(deleted.isIdleAndRunnable()).toBe(false);
  });
});

describe("startContinuation 终态语义", () => {
  it("正常完成 → triggered；输入透传给 SessionRuntime.prompt（复用注入路径）", async () => {
    const { runtime, port } = createPort();
    const promise = port.startContinuation({ text: "【Subagent 通知】…", operationId: "op-1" });
    expect(runtime.prompts).toEqual(["【Subagent 通知】…"]);
    runtime.finishCurrent();
    await expect(promise).resolves.toEqual({ status: "triggered" });
  });

  it("用户打断（noteUserMessage 抢占）→ interrupted，且 abort 了 in-flight stream", async () => {
    const { runtime, port } = createPort();
    const promise = port.startContinuation({ text: "t", operationId: "op-1" });
    port.noteUserMessage(); // 用户消息优先，continuation 不插队
    expect(runtime.abortedStreams).toHaveLength(1);
    runtime.finishCurrent();
    const outcome = await promise;
    expect(outcome.status).toBe("interrupted"); // 终态语义：已触发一次，不重复触发
  });

  it("prompt 槽被用户消息占用（竞态）→ rejected/parent_session_busy，未触发", async () => {
    const { runtime, port } = createPort();
    runtime.userBusy = true;
    const outcome = await port.startContinuation({ text: "t", operationId: "op-1" });
    expect(outcomeOf(outcome)).toBe("rejected:parent_session_busy");
    expect(runtime.prompts).toHaveLength(0);
  });

  it("同一 Session 至多一个并发 continuation：第二个被拒绝", async () => {
    const { runtime, port } = createPort();
    const first = port.startContinuation({ text: "t1", operationId: "op-1" });
    const second = await port.startContinuation({ text: "t2", operationId: "op-2" });
    expect(outcomeOf(second)).toBe("rejected:parent_continuation_in_flight");
    runtime.finishCurrent();
    await expect(first).resolves.toEqual({ status: "triggered" });
    // 结束后可再次触发
    const third = port.startContinuation({ text: "t3", operationId: "op-3" });
    runtime.finishCurrent();
    await expect(third).resolves.toEqual({ status: "triggered" });
  });
});

describe("用户事件订阅（协调器接线）", () => {
  it("noteUserTurnEnd → onTurnEnd；noteUserAbort → onUserInterrupt", () => {
    const { port } = createPort();
    const turnEnds: number[] = [];
    const interrupts: number[] = [];
    const unsubscribe = port.subscribe({ onTurnEnd: () => turnEnds.push(1), onUserInterrupt: () => interrupts.push(1) });
    port.noteUserTurnEnd();
    port.noteUserTurnEnd();
    port.noteUserAbort();
    expect(turnEnds).toHaveLength(2);
    expect(interrupts).toHaveLength(1);
    unsubscribe();
    port.noteUserTurnEnd();
    expect(turnEnds).toHaveLength(2);
  });
});
