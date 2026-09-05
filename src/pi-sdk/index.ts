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
import fs from "node:fs";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type {
  HistoryToolCall,
  OfflineCompletionResult,
  PiCredentialInfo,
  PiCredentialStore,
  PiMessageEntry,
  PiModelRuntimeHandle,
  PiModelSummary,
  PiProviderDefinition,
  PiSessionHandle,
  WorkspaceToolMode,
} from "./types.js";
import { registerSessionManager } from "./session-manager-registry.js";
import { flattenMessageEntries } from "./session-tree.js";

export { assertPiSdkVersion, EXPECTED_PI_SDK_VERSION, getPiSdkVersion } from "./version.js";
export { createPiModelRuntime } from "./model-runtime.js";
export { createPiAgentSession, createPiFauxAgentSession } from "./agent-session.js";
export { buildPiSkills, buildPiSkillsFromSnapshot } from "./skill-loader.js";
export type { PiSkillLoadOptions, PiSkillsLoadResult } from "./skill-loader.js";
export {
  branchTo,
  branchToRoot,
  forkSessionToNewSession,
  getBranchEntries,
  getLeafEntryId,
  getSessionTree,
  PiSessionTreeError,
  resolveEntry,
} from "./session-tree.js";
export type {
  PiForkResult,
  PiSessionEntryType,
  PiSessionTreeNode,
  PiSessionTreeEntry,
  PiSessionTreeErrorCode,
} from "./session-tree.js";
export type {
  HistoryToolCall,
  OfflineCompletionResult,
  PiCredentialInfo,
  PiCredentialStore,
  PiAgentEvent,
  PiAgentSessionHandle,
  PiAgentSessionOptions,
  PiFauxAgentOptions,
  PiMessageEntry,
  PiModelRuntimeHandle,
  PiModelSummary,
  PiProviderDefinition,
  PiResolvedModel,
  PiResourceSkills,
  PiSessionHandle,
  PluginSessionTool,
  PluginSessionToolInvokeResult,
  PluginToolTurnContext,
  SkillFileReadOutcome,
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

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function extractThinkingContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .filter(
      (block): block is { type: "thinking"; thinking: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "thinking" &&
        typeof (block as { thinking?: unknown }).thinking === "string",
    )
    .map((block) => block.thinking)
    .join("");
  return thinking || undefined;
}

function wrapSessionManager(manager: SessionManager): PiSessionHandle {
  // B1：拍平逻辑抽取到 session-tree.flattenMessageEntries 共享，保证
  // messageEntries 输出与会话树条目使用同一条拍平规则（逐字节一致）。
  const getEntries = (): PiMessageEntry[] => flattenMessageEntries(manager.getBranch());
  const getMessages = (): string[] => getEntries().map((entry) => entry.content);
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
    get messageEntries() {
      return getEntries();
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
    persist() {
      const sessionFile = manager.getSessionFile();
      if (!sessionFile || !manager.isPersisted()) return;
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      const header = manager.getHeader();
      const entries = header === null ? manager.getEntries() : [header, ...manager.getEntries()];
      fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      // PI SDK defers creating a file until an assistant message. We have now
      // deliberately flushed the same entries, so subsequent appends may use
      // the normal append path instead of attempting to create the file again.
      (manager as unknown as { flushed: boolean }).flushed = true;
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
