import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  createCodingTools,
  createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";

import type {
  OfflineCompletionResult,
  PiCredentialInfo,
  PiCredentialStore,
  PiModelRuntimeHandle,
  PiModelSummary,
  PiProviderDefinition,
  PiSessionHandle,
  WorkspaceToolMode,
} from "./types.js";

export { assertPiSdkVersion, EXPECTED_PI_SDK_VERSION, getPiSdkVersion } from "./version.js";
export { createPiModelRuntime } from "./model-runtime.js";
export type {
  OfflineCompletionResult,
  PiCredentialInfo,
  PiCredentialStore,
  PiModelRuntimeHandle,
  PiModelSummary,
  PiProviderDefinition,
  PiSessionHandle,
  WorkspaceToolMode,
} from "./types.js";

export function createInMemorySession(cwd: string): PiSessionHandle {
  const manager = SessionManager.inMemory(cwd);
  return {
    get id() {
      return manager.getSessionId();
    },
    get persisted() {
      return manager.isPersisted();
    },
    get entryCount() {
      return manager.getEntries().length;
    },
    appendUserMessage(content: string) {
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
    },
  };
}

export function createInMemoryCredentialStore(): PiCredentialStore {
  const store = new InMemoryCredentialStore();
  return {
    async setApiKey(providerId, apiKey) {
      await store.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
    },
    async has(providerId) {
      return (await store.read(providerId)) !== undefined;
    },
    async list(): Promise<readonly PiCredentialInfo[]> {
      return store.list();
    },
    async delete(providerId) {
      await store.delete(providerId);
    },
  };
}

export function listWorkspaceToolNames(cwd: string, mode: WorkspaceToolMode): string[] {
  const tools = mode === "read-only" ? createReadOnlyTools(cwd) : createCodingTools(cwd);
  return tools.map((tool) => tool.name);
}

export async function runOfflineCompletionProbe(
  prompt: string,
  response: string,
): Promise<OfflineCompletionResult> {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(response)]);
  const message = await faux.provider
    .streamSimple(faux.getModel(), {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    })
    .result();
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return { provider: message.provider, model: message.model, text };
}
