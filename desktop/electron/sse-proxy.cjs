"use strict";

/**
 * 主进程 SSE 代理：订阅 Server 的 text/event-stream，解析帧后经 IPC 转发给 renderer。
 * 断线自动重连，携带 Last-Event-ID 补发；path 仅允许 /api/ 开头。
 */

class SseSubscription {
  constructor({ id, path, lastEventId, sender, resolveBase }) {
    this.id = id;
    this.path = path;
    this.lastEventId = lastEventId ?? null;
    this.sender = sender;
    this.resolveBase = resolveBase;
    this.closed = false;
    this.controller = null;
    this.retryMs = 1000;
    this.loopPromise = this.loop();
  }

  async loop() {
    while (!this.closed) {
      const base = await this.resolveBase();
      if (base === null) {
        await sleep(3000);
        continue;
      }
      this.controller = new AbortController();
      try {
        const headers = { accept: "text/event-stream" };
        if (this.lastEventId !== null) headers["last-event-id"] = this.lastEventId;
        const response = await fetch(base + this.path, { headers, signal: this.controller.signal });
        if (!response.ok || response.body === null) throw new Error(`SSE HTTP ${response.status}`);
        this.retryMs = 1000;
        await this.readStream(response.body);
      } catch {
        // 主动关闭或网络错误都落入重连/退出分支
      } finally {
        this.controller = null;
      }
      if (!this.closed) {
        await sleep(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 5000);
      }
    }
  }

  async readStream(body) {
    let buffer = "";
    let frameId = null;
    let frameEvent = "message";
    let frameData = [];
    const decoder = new TextDecoder("utf-8");

    const dispatch = () => {
      if (frameData.length === 0) return;
      const frame = { id: frameId, event: frameEvent, data: frameData.join("\n") };
      if (frameId !== null) this.lastEventId = frameId;
      this.sender(this.id, frame);
      frameId = null;
      frameEvent = "message";
      frameData = [];
    };

    for await (const chunk of body) {
      if (this.closed) return;
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          dispatch();
        } else if (line.startsWith("id:")) {
          frameId = line.slice(3).trim();
        } else if (line.startsWith("event:")) {
          frameEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          frameData.push(line.slice(5).replace(/^ /, ""));
        }
        // 注释与其他字段（retry: 等）忽略
      }
    }
  }

  close() {
    this.closed = true;
    this.controller?.abort();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SseProxyManager {
  constructor(resolveBase) {
    this.resolveBase = resolveBase;
    this.subscriptions = new Map();
  }

  subscribe(webContents, subId, path, lastEventId) {
    if (typeof path !== "string" || !path.startsWith("/api/")) return;
    this.unsubscribe(subId);
    const sender = (id, frame) => {
      if (!webContents.isDestroyed()) {
        webContents.send("desktop:sse-event", { subId: id, frame });
      }
    };
    this.subscriptions.set(subId, new SseSubscription({
      id: subId,
      path,
      lastEventId: typeof lastEventId === "string" && lastEventId !== "" ? lastEventId : null,
      sender,
      resolveBase: this.resolveBase,
    }));
  }

  unsubscribe(subId) {
    const existing = this.subscriptions.get(subId);
    if (existing) {
      existing.close();
      this.subscriptions.delete(subId);
    }
  }

  disposeAll() {
    for (const sub of this.subscriptions.values()) sub.close();
    this.subscriptions.clear();
  }
}

module.exports = { SseProxyManager };
