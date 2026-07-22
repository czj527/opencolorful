import { describe, expect, it } from "vitest";

import { validateProviderForm, hasProviderFormErrors } from "../features/providers/provider-form.js";
import {
  validateSessionSettings,
  hasSessionSettingsErrors,
  settingsFormFromSession,
  applySessionSettingsChange,
  type SessionSettingsFormData,
} from "../features/sessions/session-settings.js";

describe("provider form validation", () => {
  const validForm = {
    providerId: "my-provider",
    name: "My Provider",
    protocol: "openai-completions" as const,
    baseUrl: "http://localhost:8080/v1",
    modelId: "gpt-4",
    modelName: "GPT-4",
    apiKey: "sk-test-key",
    reasoning: false,
    contextWindow: 32768,
    maxTokens: 4096,
  };

  it("accepts a valid form", () => {
    const errors = validateProviderForm(validForm);
    expect(hasProviderFormErrors(errors)).toBe(false);
  });

  it("rejects maxTokens greater than contextWindow", () => {
    const errors = validateProviderForm({ ...validForm, contextWindow: 100, maxTokens: 200 });
    expect(errors.capabilities).toBeDefined();
  });

  it("rejects non-positive contextWindow", () => {
    const errors = validateProviderForm({ ...validForm, contextWindow: 0 });
    expect(errors.capabilities).toBeDefined();
  });

  it("rejects empty providerId", () => {
    const errors = validateProviderForm({ ...validForm, providerId: "" });
    expect(errors.providerId).toBeDefined();
  });

  it("rejects invalid providerId format", () => {
    const errors = validateProviderForm({ ...validForm, providerId: "INVALID ID!" });
    expect(errors.providerId).toBeDefined();
  });

  it("rejects empty name", () => {
    const errors = validateProviderForm({ ...validForm, name: "" });
    expect(errors.name).toBeDefined();
  });

  it("rejects empty baseUrl", () => {
    const errors = validateProviderForm({ ...validForm, baseUrl: "" });
    expect(errors.baseUrl).toBeDefined();
  });

  it("rejects invalid baseUrl", () => {
    const errors = validateProviderForm({ ...validForm, baseUrl: "not-a-url" });
    expect(errors.baseUrl).toBeDefined();
  });

  it("rejects non-HTTP baseUrl", () => {
    const errors = validateProviderForm({ ...validForm, baseUrl: "ftp://example.com" });
    expect(errors.baseUrl).toBeDefined();
  });

  it("rejects empty modelId", () => {
    const errors = validateProviderForm({ ...validForm, modelId: "" });
    expect(errors.modelId).toBeDefined();
  });
});

describe("session settings validation", () => {
  it("accepts off mode without workspace", () => {
    const errors = validateSessionSettings({
      toolMode: "off",
      workspaceCwd: "",
      workspaceConfirmed: false,
      thinkingLevel: "medium",
    });
    expect(hasSessionSettingsErrors(errors)).toBe(false);
  });

  it("accepts read-only mode with workspace", () => {
    const errors = validateSessionSettings({
      toolMode: "read-only",
      workspaceCwd: "/home/user/project",
      workspaceConfirmed: false,
      thinkingLevel: "medium",
    });
    expect(hasSessionSettingsErrors(errors)).toBe(false);
  });

  it("accepts all mode with workspace and confirmation", () => {
    const errors = validateSessionSettings({
      toolMode: "all",
      workspaceCwd: "/home/user/project",
      workspaceConfirmed: true,
      thinkingLevel: "medium",
    });
    expect(hasSessionSettingsErrors(errors)).toBe(false);
  });

  it("rejects all mode without workspace confirmation", () => {
    const errors = validateSessionSettings({
      toolMode: "all",
      workspaceCwd: "/home/user/project",
      workspaceConfirmed: false,
      thinkingLevel: "medium",
    });
    expect(errors.toolMode).toBeDefined();
  });

  it("rejects all mode without workspace cwd", () => {
    const errors = validateSessionSettings({
      toolMode: "all",
      workspaceCwd: "",
      workspaceConfirmed: true,
      thinkingLevel: "medium",
    });
    expect(errors.workspaceCwd).toBeDefined();
  });

  it("rejects path traversal in workspace cwd", () => {
    const errors = validateSessionSettings({
      toolMode: "all",
      workspaceCwd: "../../../etc",
      workspaceConfirmed: true,
      thinkingLevel: "medium",
    });
    expect(errors.workspaceCwd).toBeDefined();
  });

  it("accepts all thinking levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const errors = validateSessionSettings({
        toolMode: "read-only",
        workspaceCwd: "/tmp",
        workspaceConfirmed: false,
        thinkingLevel: level,
      });
      expect(hasSessionSettingsErrors(errors)).toBe(false);
    }
  });
});

describe("settingsFormFromSession", () => {
  it("builds form state from a session view", () => {
    const form = settingsFormFromSession({
      toolMode: "all",
      workspaceCwd: "/work/a",
      workspaceConfirmed: true,
      thinkingLevel: "high",
    });
    expect(form).toEqual({
      toolMode: "all",
      workspaceCwd: "/work/a",
      workspaceConfirmed: true,
      thinkingLevel: "high",
    });
  });

  it("falls back to safe defaults for unknown persisted values", () => {
    const form = settingsFormFromSession({
      toolMode: "bogus",
      workspaceCwd: null,
      workspaceConfirmed: false,
      thinkingLevel: "bogus",
    });
    expect(form.toolMode).toBe("read-only");
    expect(form.workspaceCwd).toBe("");
    expect(form.thinkingLevel).toBe("medium");
  });

  it("produces independent state per session (no cross-session leakage)", () => {
    const sessionA = settingsFormFromSession({ toolMode: "all", workspaceCwd: "/a", workspaceConfirmed: true, thinkingLevel: "max" });
    const sessionB = settingsFormFromSession({ toolMode: "read-only", workspaceCwd: "/b", workspaceConfirmed: false, thinkingLevel: "low" });
    expect(sessionA.workspaceConfirmed).toBe(true);
    expect(sessionB.workspaceConfirmed).toBe(false);
    expect(sessionA.thinkingLevel).toBe("max");
    expect(sessionB.thinkingLevel).toBe("low");
  });
});

describe("applySessionSettingsChange", () => {
  const base: SessionSettingsFormData = {
    toolMode: "read-only",
    workspaceCwd: "/work/original",
    workspaceConfirmed: false,
    thinkingLevel: "medium",
  };

  it("forces reconfirmation when switching from non-all to all", () => {
    const next = applySessionSettingsChange(
      { ...base, workspaceConfirmed: true },
      { toolMode: "all" },
      "/work/original",
    );
    expect(next.workspaceConfirmed).toBe(false);
  });

  it("clears confirmation when workspace cwd deviates from the persisted value", () => {
    const confirmedAll: SessionSettingsFormData = {
      ...base,
      toolMode: "all",
      workspaceConfirmed: true,
    };
    const next = applySessionSettingsChange(confirmedAll, { workspaceCwd: "/work/changed" }, "/work/original");
    expect(next.workspaceConfirmed).toBe(false);
  });

  it("keeps confirmation when cwd stays at the persisted value", () => {
    const confirmedAll: SessionSettingsFormData = {
      ...base,
      toolMode: "all",
      workspaceConfirmed: true,
    };
    const next = applySessionSettingsChange(confirmedAll, { thinkingLevel: "high" }, "/work/original");
    expect(next.workspaceConfirmed).toBe(true);
  });

  it("re-confirming after a cwd change is possible (user checks the box again)", () => {
    const confirmedAll: SessionSettingsFormData = {
      ...base,
      toolMode: "all",
      workspaceConfirmed: true,
    };
    let next = applySessionSettingsChange(confirmedAll, { workspaceCwd: "/work/changed" }, "/work/original");
    expect(next.workspaceConfirmed).toBe(false);
    next = applySessionSettingsChange(next, { workspaceConfirmed: true }, "/work/original");
    expect(next.workspaceConfirmed).toBe(true);
  });

  it("switching from all to read-only and back requires fresh confirmation", () => {
    const confirmedAll: SessionSettingsFormData = {
      ...base,
      toolMode: "all",
      workspaceConfirmed: true,
    };
    const toReadOnly = applySessionSettingsChange(confirmedAll, { toolMode: "read-only" }, "/work/original");
    // 切走时保留确认值以便回显，但回到 all 必须重新确认
    const backToAll = applySessionSettingsChange(toReadOnly, { toolMode: "all" }, "/work/original");
    expect(backToAll.workspaceConfirmed).toBe(false);
  });
});
