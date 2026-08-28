import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { PreferencesStore } from "../../src/config/preferences-store.js";
import {
  defaultPreferences,
  normalizePreferences,
} from "../../src/contracts/preferences.js";

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-prefs-"));
}

function tempPaths(home: string) {
  return getRuntimePaths({ OPENCOLORFUL_HOME: home });
}

describe("preferences document normalization", () => {
  it("returns version 2 defaults when value is missing entirely", () => {
    const prefs = normalizePreferences(undefined);

    expect(prefs.version).toBe(2);
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
    expect(prefs.appearance.showToolCalls).toBe(true);
    expect(prefs.appearance.showThinking).toBe(true);
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

  it("falls back to default appearance values when fields are missing or invalid", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: { model: null, thinkingLevel: "medium", toolMode: "read-only" },
      layout: {
        leftSidebarWidth: 280,
        rightSidebarWidth: 320,
        leftCollapsed: false,
        rightCollapsed: false,
        focusMode: false,
        reducedMotion: "system",
      },
      appearance: {
        theme: "dark",
        showToolCalls: "not-a-boolean",
        // showThinking 缺失
      },
    });

    expect(prefs.appearance.showToolCalls).toBe(true); // 回退默认
    expect(prefs.appearance.showThinking).toBe(true);  // 缺失字段回退默认
  });

  it("preserves explicit false values for showToolCalls and showThinking", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: { model: null, thinkingLevel: "medium", toolMode: "read-only" },
      layout: {
        leftSidebarWidth: 280,
        rightSidebarWidth: 320,
        leftCollapsed: false,
        rightCollapsed: false,
        focusMode: false,
        reducedMotion: "system",
      },
      appearance: {
        theme: "light",
        showToolCalls: false,
        showThinking: false,
      },
    });

    expect(prefs.appearance.showToolCalls).toBe(false);
    expect(prefs.appearance.showThinking).toBe(false);
    expect(prefs.appearance.theme).toBe("light");
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

  it("creates a version 1 document when the file is missing", () => {
    const paths = tempPaths(home);
    const store = new PreferencesStore(paths.preferences);

    expect(store.get()).toEqual(defaultPreferences());
    expect(JSON.parse(fs.readFileSync(paths.preferences, "utf8"))).toEqual(defaultPreferences());
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

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new PreferencesStore(paths.preferences);

    // 读取损坏文件后返回默认值，而不是抛出异常。
    expect(store.get()).toEqual(defaultPreferences());
    expect(JSON.parse(fs.readFileSync(paths.preferences, "utf8"))).toEqual(defaultPreferences());
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("偏好文件损坏"));
    warning.mockRestore();
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

  it("migrates a legacy all global default to read-only", () => {
    const paths = tempPaths(home);
    fs.mkdirSync(path.dirname(paths.preferences), { recursive: true });
    fs.writeFileSync(
      paths.preferences,
      JSON.stringify({
        ...defaultPreferences(),
        defaults: { ...defaultPreferences().defaults, toolMode: "all" },
      }),
      "utf8",
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = new PreferencesStore(paths.preferences);
    expect(store.get().defaults.toolMode).toBe("read-only");
    expect(JSON.parse(fs.readFileSync(paths.preferences, "utf8")).defaults.toolMode).toBe("read-only");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("完整工具权限"));
    warning.mockRestore();
  });
});

describe("preferences memory section (Phase 10.5)", () => {
  it("v1 preferences migrate to v2 with observability defaults (backward compatible)", () => {
    const prefs = normalizePreferences({ version: 1, defaults: { model: null, thinkingLevel: "medium", toolMode: "read-only" }, layout: { leftSidebarWidth: 280, rightSidebarWidth: 320, leftCollapsed: false, rightCollapsed: false, focusMode: false, reducedMotion: "system" }, appearance: { theme: "dark", showToolCalls: true, showThinking: true } });
    expect(prefs.version).toBe(2);
    expect(prefs.memory).toBeUndefined();
    // Phase 11：v1 → v2 迁移自动补 observability 默认段
    expect(prefs.observability?.diagnosticLevel).toBe("info");
    expect(prefs.observability?.diagnosticDiskBudgetBytes).toBe(500 * 1024 * 1024);
  });

  it("valid memory section is preserved", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: defaultPreferences().defaults,
      layout: defaultPreferences().layout,
      appearance: defaultPreferences().appearance,
      memory: { enabled: true, utilityProviderId: "openai", utilityModel: "gpt-4o-mini", deepDiveMode: "script", dailyRunTime: "04:00", minIdleMinutes: 45, weeklyReviewDay: 1, weeklyReviewTime: "04:30", turnsPerSummary: 12, injectBudgetChars: 3000, reviewEnabled: true, retentionThresholds: { mediumUp: 50, mediumDown: 40, permanentUp: 90 } },
    });
    expect(prefs.memory?.dailyRunTime).toBe("04:00");
    expect(prefs.memory?.utilityProviderId).toBe("openai");
    expect(prefs.memory?.retentionThresholds.permanentUp).toBe(90);
  });

  it("legacy memory section without reviewEnabled migrates with default true (T14)", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: defaultPreferences().defaults,
      layout: defaultPreferences().layout,
      appearance: defaultPreferences().appearance,
      memory: { enabled: true, utilityProviderId: "openai", utilityModel: null, deepDiveMode: "script", dailyRunTime: "04:00", minIdleMinutes: 45, weeklyReviewDay: 1, weeklyReviewTime: "04:30", turnsPerSummary: 12, injectBudgetChars: 3000, retentionThresholds: { mediumUp: 50, mediumDown: 40, permanentUp: 90 } },
    });
    // 缺 reviewEnabled 的旧段落不应整段回退：保留用户定制，只补新字段默认值
    expect(prefs.memory?.dailyRunTime).toBe("04:00");
    expect(prefs.memory?.reviewEnabled).toBe(true);
  });

  it("invalid memory section falls back to global defaults", () => {
    const prefs = normalizePreferences({
      version: 1,
      defaults: defaultPreferences().defaults,
      layout: defaultPreferences().layout,
      appearance: defaultPreferences().appearance,
      memory: { enabled: "maybe", deepDiveMode: "skynet" },
    });
    expect(prefs.memory?.enabled).toBe(true);
    expect(prefs.memory?.deepDiveMode).toBe("script");
    expect(prefs.memory?.dailyRunTime).toBe("03:00");
  });
});
