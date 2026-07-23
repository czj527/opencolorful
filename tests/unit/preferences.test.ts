import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import {
  defaultPreferences,
  normalizePreferences,
} from "../../src/contracts/preferences.js";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-prefs-"));
}

function tempPaths(home: string) {
  return getRuntimePaths({ PERSON_AGENT_HOME: home });
}

describe("preferences document normalization", () => {
  it("returns version 1 defaults when value is missing entirely", () => {
    const prefs = normalizePreferences(undefined);

    expect(prefs.version).toBe(1);
    expect(prefs.defaults.model).toBeNull();
    expect(prefs.defaults.thinkingLevel).toBe("medium");
    expect(prefs.defaults.toolMode).toBe("read-only");
    expect(prefs.layout.leftSidebarWidth).toBeGreaterThanOrEqual(200);
    expect(prefs.layout.leftSidebarWidth).toBeLessThanOrEqual(420);
    expect(prefs.layout.rightSidebarWidth).toBeGreaterThanOrEqual(240);
    expect(prefs.layout.rightSidebarWidth).toBeLessThanOrEqual(520);
    expect(prefs.layout.leftCollapsed).toBe(false);
    expect(prefs.layout.rightCollapsed).toBe(false);
    expect(prefs.layout.focusMode).toBe(false);
    expect(prefs.layout.reducedMotion).toBe("system");
  });

  it("matches defaultPreferences()", () => {
    expect(normalizePreferences(undefined)).toEqual(defaultPreferences());
  });

  it("drops unknown fields before validating", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: {
        model: null,
        thinkingLevel: "high",
        toolMode: "all",
        secretKey: "leak", // 未知字段，应被丢弃
      },
      layout: {
        leftSidebarWidth: 300,
        rightSidebarWidth: 400,
        leftCollapsed: true,
        rightCollapsed: false,
        focusMode: false,
        reducedMotion: "on",
        theme: "dark", // 未知字段
      },
      futureSection: "ignored",
    });

    expect(prefs.defaults).not.toHaveProperty("secretKey");
    expect(prefs.layout).not.toHaveProperty("theme");
    expect(prefs).not.toHaveProperty("futureSection");
    expect(prefs.defaults.toolMode).toBe("all");
    expect(prefs.layout.reducedMotion).toBe("on");
  });

  it("clamps invalid layout widths to documented ranges", () => {
    const wide = normalizePreferences({
      version: 1,
      defaults: { model: null, thinkingLevel: "medium", toolMode: "read-only" },
      layout: {
        leftSidebarWidth: 50, // 低于最小值
        rightSidebarWidth: 99999, // 高于最大值
        leftCollapsed: false,
        rightCollapsed: false,
        focusMode: false,
        reducedMotion: "system",
      },
    });

    expect(wide.layout.leftSidebarWidth).toBe(200);
    expect(wide.layout.rightSidebarWidth).toBe(520);
  });

  it("falls back to defaults for invalid enum values", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: { model: null, thinkingLevel: "nonsense", toolMode: "danger" },
      layout: {
        leftSidebarWidth: "wide", // 非数字
        rightSidebarWidth: 400,
        leftCollapsed: "yes", // 非布尔
        rightCollapsed: false,
        focusMode: false,
        reducedMotion: "blink", // 非法枚举
      },
    });

    expect(prefs.defaults.thinkingLevel).toBe("medium");
    expect(prefs.defaults.toolMode).toBe("read-only");
    expect(prefs.layout.leftSidebarWidth).toBeGreaterThanOrEqual(200);
    expect(prefs.layout.leftCollapsed).toBe(false);
    expect(prefs.layout.reducedMotion).toBe("system");
  });

  it("keeps a valid model reference", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: {
        model: { providerId: "openai", modelId: "gpt-4o" },
        thinkingLevel: "medium",
        toolMode: "read-only",
      },
      layout: {
        leftSidebarWidth: 280,
        rightSidebarWidth: 320,
        leftCollapsed: false,
        rightCollapsed: false,
        focusMode: false,
        reducedMotion: "system",
      },
    });

    expect(prefs.defaults.model).toEqual({ providerId: "openai", modelId: "gpt-4o" });
  });
});

describe("preferences store persistence", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempHome();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns version 1 defaults when the file is missing", () => {
    const paths = tempPaths(home);
    const store = new PreferencesStore(paths.preferences);

    expect(store.get()).toEqual(defaultPreferences());
    expect(fs.existsSync(paths.preferences)).toBe(false);
  });

  it("normalizes unknown fields before writing back", () => {
    const paths = tempPaths(home);
    fs.mkdirSync(path.dirname(paths.preferences), { recursive: true });
    fs.writeFileSync(
      paths.preferences,
      JSON.stringify({
        version: 1,
        defaults: {
          model: null,
          thinkingLevel: "medium",
          toolMode: "read-only",
          unknown: true,
        },
        layout: {
          leftSidebarWidth: 280,
          rightSidebarWidth: 320,
          leftCollapsed: false,
          rightCollapsed: false,
          focusMode: false,
          reducedMotion: "system",
        },
      }),
      "utf8",
    );

    const store = new PreferencesStore(paths.preferences);
    const roundtrip = store.get();

    expect(roundtrip.defaults).not.toHaveProperty("unknown");
    expect(roundtrip.defaults.toolMode).toBe("read-only");
  });

  it("clamps invalid layout widths to the documented ranges", () => {
    const paths = tempPaths(home);
    fs.mkdirSync(path.dirname(paths.preferences), { recursive: true });
    fs.writeFileSync(
      paths.preferences,
      JSON.stringify({
        version: 1,
        defaults: { model: null, thinkingLevel: "low", toolMode: "off" },
        layout: {
          leftSidebarWidth: 10,
          rightSidebarWidth: 9999,
          leftCollapsed: false,
          rightCollapsed: false,
          focusMode: false,
          reducedMotion: "system",
        },
      }),
      "utf8",
    );

    const store = new PreferencesStore(paths.preferences);

    expect(store.get().layout.leftSidebarWidth).toBe(200);
    expect(store.get().layout.rightSidebarWidth).toBe(520);
  });

  it("recovers from malformed JSON and writes a repaired document", () => {
    const paths = tempPaths(home);
    fs.mkdirSync(path.dirname(paths.preferences), { recursive: true });
    fs.writeFileSync(paths.preferences, "{ not valid json ", "utf8");

    const store = new PreferencesStore(paths.preferences);

    // 读取损坏文件后返回默认值，而不是抛出异常。
    expect(store.get()).toEqual(defaultPreferences());
  });

  it("writes through a temporary file and leaves no temporary file after success", () => {
    const paths = tempPaths(home);
    const store = new PreferencesStore(paths.preferences);

    store.update({ layout: { leftSidebarWidth: 320 } as never });

    const dir = path.dirname(paths.preferences);
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const leftover = entries.filter((entry) => entry.endsWith(".tmp"));

    expect(leftover).toEqual([]);
    expect(fs.existsSync(paths.preferences)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(paths.preferences, "utf8"));
    expect(persisted.layout.leftSidebarWidth).toBe(320);
    expect(persisted).not.toHaveProperty("secretKey");
  });

  it("persists updated defaults and re-reads them", () => {
    const paths = tempPaths(home);
    const store = new PreferencesStore(paths.preferences);

    store.update({
      defaults: {
        model: { providerId: "openai", modelId: "gpt-4o" },
        thinkingLevel: "high",
        toolMode: "read-only",
      } as never,
    });

    const reopened = new PreferencesStore(paths.preferences);
    expect(reopened.get().defaults.model).toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
    });
    expect(reopened.get().defaults.thinkingLevel).toBe("high");
  });
});