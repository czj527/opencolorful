import {
  applyEvent,
  applyLocalUserMessage,
  createProjector,
  markPromptSent,
  snapshotOf,
  type ChatSnapshot,
  type LiveEnvelope,
} from "../../src/data/projector.js";
import type { Thread } from "../../src/mock-data.js";
import type { DesktopDataSource } from "../../src/data/source.js";
import { overrideSource } from "./override-source.js";

interface ReplaySession {
  readonly projector: ReturnType<typeof createProjector>;
  readonly handlers: Set<(snapshot: ChatSnapshot) => void>;
  played: boolean;
}

export interface ReplayChatSourceOptions {
  /** sendPrompt 收到这条文本时触发回放（其余文本透传 base mock 的演示脚本） */
  readonly content: string;
  readonly sequence: readonly LiveEnvelope[];
  readonly threadId: string;
}

/**
 * SSE 固定回放数据源（fixtures/sse/replay-sequence.ts 的驱动器）。
 *
 * 生产 MockDataSource 用时间片脚本模拟流式；本 fixture 改为按固定 Envelope
 * 序列一次性回放（与真实 SSE 样本同形状、同 projector 路径），用于确定性断言。
 * 只覆写 createThread / subscribeChat / sendPrompt 三个方法，接口形状不变。
 */
export function replayChatSource(base: DesktopDataSource, options: ReplayChatSourceOptions): DesktopDataSource {
  const sessions = new Map<string, ReplaySession>();

  function sessionFor(sessionId: string): ReplaySession {
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = {
        projector: createProjector(base.info.mode === "mock" ? "原" : "Agent"),
        handlers: new Set(),
        played: false,
      };
      sessions.set(sessionId, session);
    }
    return session;
  }

  function notify(session: ReplaySession) {
    const snapshot = snapshotOf(session.projector);
    for (const handler of session.handlers) handler(snapshot);
  }

  function play(session: ReplaySession) {
    applyLocalUserMessage(session.projector, options.content);
    const streamId = options.sequence.find((event) => event.streamId !== null)?.streamId ?? "st-fixture-replay";
    markPromptSent(session.projector, streamId);
    for (const envelope of options.sequence) applyEvent(session.projector, envelope);
    session.played = true;
    notify(session);
  }

  return overrideSource(base, {
    createThread: async (agentId: string, title: string): Promise<Thread> => {
      void title;
      return { id: options.threadId, title: options.content.slice(0, 18), preview: "", time: "", status: "active", agentId };
    },
    subscribeChat: (sessionId: string, handler: (snapshot: ChatSnapshot) => void) => {
      const session = sessionFor(sessionId);
      session.handlers.add(handler);
      handler(snapshotOf(session.projector));
      return () => {
        session.handlers.delete(handler);
      };
    },
    sendPrompt: (sessionId: string, content: string) => {
      if (content !== options.content) return base.sendPrompt(sessionId, content);
      const session = sessionFor(sessionId);
      if (session.played) return Promise.resolve();
      // 让 React 先完成 subscribeChat 挂载，再在下一个宏任务里回放，消除订阅竞态
      window.setTimeout(() => play(session), 30);
      return Promise.resolve();
    },
  });
}
