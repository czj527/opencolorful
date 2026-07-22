import { describe, expect, it } from "vitest";

import { validateProviderForm, hasProviderFormErrors } from "../features/providers/provider-form.js";
import { validateSessionSettings, hasSessionSettingsErrors } from "../features/sessions/session-settings.js";

describe("provider form validation", () => {
  const validForm = {
    providerId: "my-provider",
    name: "My Provider",
    protocol: "openai-completions" as const,
    baseUrl: "http://localhost:8080/v1",
    modelId: "gpt-4",
    modelName: "GPT-4",
    apiKey: "sk-test-key",
  };

  it("accepts a valid form", () => {
    const errors = validateProviderForm(validForm);
    expect(hasProviderFormErrors(errors)).toBe(false);
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
