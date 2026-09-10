"use strict";

/**
 * 主进程 SSE 代理：订阅 Server 的 text/event-stream，解析帧后经 IPC 转发给 renderer。
 * 断线自动重连，携带 Last-Event-ID 补发；path 仅允许 /api/ 开头。
 */

class SseSubscription {
  constructor({ id, path, lastEventId, sender, onReconnect, resolveBase }) {
    this.id = id;
    this.path = path;
    this.lastEventId = lastEventId ?? null;
    this.sender = sender;
    this.onReconnect = onReconnect;
    this.resolveBase = resolveBase;
    this.closed = false;
    this.controller = null;
    this.retryMs = 1000;
    // F3 flaky 回归：连接断开（错误或服务端关流）后置位，下次连上即视为重连成功，
    // 通知 renderer 追平断线窗口内丢失的事件；首次连接不通知（历史 GET 刚装载过）
    this.reconnectPending = false;
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
        if (this.reconnectPending) {
          this.reconnectPending = false;
          this.onReconnect?.(this.id);
        }
        await this.readStream(response.body);
      } catch {
        // 主动关闭或网络错误都落入重连/退出分支
      } finally {
        this.controller = null;
        // 连接已结束（无论成败）：下一次成功建立连接即属于重连
        this.reconnectPending = true;
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
    // F3 flaky 回归：重连成功透传给 renderer（preload 的 onReconnect → ipc-source 追平）
    const onReconnect = (id) => {
      if (!webContents.isDestroyed()) {
        webContents.send("desktop:sse-reconnect", { subId: id });
      }
    };
    this.subscriptions.set(subId, new SseSubscription({
      id: subId,
      path,
      lastEventId: typeof lastEventId === "string" && lastEventId !== "" ? lastEventId : null,
      sender,
      onReconnect,
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
