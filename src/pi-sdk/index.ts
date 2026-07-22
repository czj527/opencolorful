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
import type { AssistantMessage } from "@earendil-works/pi-ai";

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
import { registerSessionManager } from "./session-manager-registry.js";

export { assertPiSdkVersion, EXPECTED_PI_SDK_VERSION, getPiSdkVersion } from "./version.js";
export { createPiModelRuntime } from "./model-runtime.js";
export { createPiAgentSession, createPiFauxAgentSession } from "./agent-session.js";
export type {
  OfflineCompletionResult,
  PiCredentialInfo,
  PiCredentialStore,
  PiAgentEvent,
  PiAgentSessionHandle,
  PiAgentSessionOptions,
  PiFauxAgentOptions,
  PiModelRuntimeHandle,
  PiModelSummary,
  PiProviderDefinition,
  PiResolvedModel,
  PiSessionHandle,
  WorkspaceToolMode,
} from "./types.js";

export function createInMemorySession(cwd: string): PiSessionHandle {
  const manager = SessionManager.inMemory(cwd);
  return wrapSessionManager(manager);
}

export function createPersistentSession(
  cwd: string,
  sessionDir: string,
  id: string,
): PiSessionHandle {
  return wrapSessionManager(SessionManager.create(cwd, sessionDir, { id }));
}

export function openPersistentSession(
  sessionPath: string,
  sessionDir: string,
  cwd?: string,
): PiSessionHandle {
  return wrapSessionManager(SessionManager.open(sessionPath, sessionDir, cwd));
}

function wrapSessionManager(manager: SessionManager): PiSessionHandle {
  const getMessages = (): string[] =>
    manager
      .getBranch()
      .filter((entry) => entry.type === "message")
      .flatMap((entry) => {
        const message = entry.message;
        if (message.role !== "user" && message.role !== "assistant") return [];
        if (typeof message.content === "string") return [message.content];
        return [
          ...message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text),
        ];
      });
  const getModel = (): { providerId: string; modelId: string } | null => {
    const modelEntry = [...manager.getBranch()].reverse().find((entry) => {
      return entry.type === "model_change" || (entry.type === "message" && entry.message.role === "assistant");
    });
    if (!modelEntry) return null;
    if (modelEntry.type === "model_change") {
      return { providerId: modelEntry.provider, modelId: modelEntry.modelId };
    }
    if (modelEntry.type === "message" && modelEntry.message.role === "assistant") {
      return { providerId: modelEntry.message.provider, modelId: modelEntry.message.model };
    }
    return null;
  };
  const handle: PiSessionHandle = {
    get id() {
      return manager.getSessionId();
    },
    get path() {
      return manager.getSessionFile() ?? "";
    },
    get persisted() {
      return manager.isPersisted();
    },
    get entryCount() {
      return manager.getEntries().length;
    },
    get messages() {
      return getMessages();
    },
    get model() {
      return getModel();
    },
    appendUserMessage(content: string) {
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
    },
    appendAssistantMessage(content: string) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      manager.appendMessage(message);
    },
    selectModel(providerId: string, modelId: string) {
      manager.appendModelChange(providerId, modelId);
    },
    setTitle(title: string) {
      manager.appendSessionInfo(title);
    },
    dispose() {
      manager.getEntries();
    },
  };
  registerSessionManager(handle, manager);
  return handle;
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
