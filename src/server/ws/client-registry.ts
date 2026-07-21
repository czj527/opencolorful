import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";

export class ClientRegistry {
  private readonly clients = new Map<string, WSContext<WebSocket>>();
  private readonly subscriptions = new Map<string, Set<string>>();
  
  register(clientId: string, ws: WSContext<WebSocket>): void {
    this.clients.set(clientId, ws);
    if (!this.subscriptions.has(clientId)) {
      this.subscriptions.set(clientId, new Set());
    }
  }

  remove(clientId: string): void {
    this.clients.delete(clientId);
    this.subscriptions.delete(clientId);
  }

  subscribe(clientId: string, sessionId: string): void {
    const sessions = this.subscriptions.get(clientId);
    if (sessions) {
      sessions.add(sessionId);
    }
  }

  unsubscribe(clientId: string, sessionId: string): void {
    const sessions = this.subscriptions.get(clientId);
    if (sessions) {
      sessions.delete(sessionId);
    }
  }

  isSubscribed(clientId: string, sessionId: string): boolean {
    const sessions = this.subscriptions.get(clientId);
    return sessions !== undefined && sessions.has(sessionId);
  }

  getClient(clientId: string): WSContext<WebSocket> | undefined {
    return this.clients.get(clientId);
  }

  getSubscribers(sessionId: string): string[] {
    const result: string[] = [];
    for (const [clientId, sessions] of this.subscriptions) {
      if (sessions.has(sessionId)) {
        result.push(clientId);
      }
    }
    return result;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get subscriptionCount(): number {
    let total = 0;
    for (const sessions of this.subscriptions.values()) {
      total += sessions.size;
    }
    return total;
  }
}
