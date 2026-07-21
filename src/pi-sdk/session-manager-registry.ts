import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { PiSessionHandle } from "./types.js";

const sessionManagers = new WeakMap<PiSessionHandle, SessionManager>();

export function registerSessionManager(
  handle: PiSessionHandle,
  manager: SessionManager,
): void {
  sessionManagers.set(handle, manager);
}

export function getSessionManager(handle: PiSessionHandle): SessionManager {
  const manager = sessionManagers.get(handle);
  if (manager === undefined) {
    throw new Error("Session handle 不属于当前 PI SDK Adapter");
  }
  return manager;
}
