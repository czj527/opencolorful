import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillError } from "../../../src/runtime/skills/errors.js";
import {
  AgentSkillConfigStore,
  defaultAgentSkillConfig,
} from "../../../src/runtime/skills/agent/agent-skill-config.js";
import { tmpDir } from "./helpers.js";
import { cleanupT4Harnesses, createT4Harness } from "./t4-harness.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 Agent skills.json 读写（plans/phase-13.md §9.4 / §18.3）
// - 原子写（temp + rename）；损坏 fail-closed；旧数据迁移；schemaVersion 防线
// ═══════════════════════════════════════════════════════════════

afterEach(() => {
  cleanupT4Harnesses();
});

describe("AgentSkillConfigStore：读写与原子写", () => {
  it("缺失文件返回默认空配置（未绑定任何 Skill）", () => {
    const { configStore } = createT4Harness();
    const config = configStore.getSkillsConfig("agent-a");
    expect(config).toEqual(defaultAgentSkillConfig());
  });

  it("保存后读取一致（含 bundleBindings/directSkillRefs/overrides/learningPolicy）", () => {
    const { configStore, paths } = createT4Harness();
    const config = {
      schemaVersion: 1 as const,
      bundleBindings: [{ bundleId: "b1", version: "2", pinned: true }],
      directSkillRefs: [
        {
          skillId: "alpha",
          sourceId: "/tmp/alpha",
          sourceKind: "managed" as const,
          version: "1.0.0",
          contentHash: "sha256-abcdef",
        },
      ],
      overrides: { "alpha@/tmp/alpha@1.0.0": "explicit-only" as const },
      learningPolicy: "ask-always" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    configStore.saveSkillsConfig("agent-a", config);
    const read = configStore.getSkillsConfig("agent-a");
    expect(read).toEqual(config);
    // 文件确实落在 agents/<agentId>/skills.json
    expect(fs.existsSync(path.join(paths.agents, "agent-a", "skills.json"))).toBe(true);
    // 保存后不残留临时文件
    const entries = fs.readdirSync(path.join(paths.agents, "agent-a"));
    expect(entries.filter((entry) => entry.includes(".tmp"))).toHaveLength(0);
  });

  it("覆盖保存是原子替换（旧内容被完整替换，无半写状态）", () => {
    const { configStore } = createT4Harness();
    configStore.saveSkillsConfig("agent-a", {
      ...defaultAgentSkillConfig(),
      learningPolicy: "disabled",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    configStore.saveSkillsConfig("agent-a", {
      ...defaultAgentSkillConfig(),
      learningPolicy: "ask-on-risk",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const read = configStore.getSkillsConfig("agent-a");
    expect(read.learningPolicy).toBe("ask-on-risk");
    expect(read.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("AgentSkillConfigStore：fail-closed 与迁移", () => {
  it("JSON 损坏 → fail-closed 抛错（不静默丢弃绑定）", () => {
    const { configStore, paths } = createT4Harness();
    fs.mkdirSync(path.join(paths.agents, "agent-b"), { recursive: true });
    fs.writeFileSync(path.join(paths.agents, "agent-b", "skills.json"), "{ not-json !!!", "utf8");
    expect(() => configStore.getSkillsConfig("agent-b")).toThrow(SkillError);
  });

  it("结构非法（directSkillRefs 缺字段）→ fail-closed 抛错", () => {
    const { configStore, paths } = createT4Harness();
    fs.mkdirSync(path.join(paths.agents, "agent-b"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.agents, "agent-b", "skills.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundleBindings: [],
        directSkillRefs: [{ skillId: "alpha" }], // 缺 sourceId/version/contentHash
        overrides: {},
        learningPolicy: "ask-on-risk",
      }),
      "utf8",
    );
    expect(() => configStore.getSkillsConfig("agent-b")).toThrow(SkillError);
  });

  it("schemaVersion 高于当前支持 → fail-closed 抛错", () => {
    const { configStore, paths } = createT4Harness();
    fs.mkdirSync(path.join(paths.agents, "agent-b"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.agents, "agent-b", "skills.json"),
      JSON.stringify({ schemaVersion: 99, bundleBindings: [], directSkillRefs: [], overrides: {}, learningPolicy: "ask-on-risk" }),
      "utf8",
    );
    expect(() => configStore.getSkillsConfig("agent-b")).toThrow(/schemaVersion/);
  });

  it("legacy 旧数据（无 schemaVersion）迁移到 v1，migratedFrom 标记", () => {
    const { configStore, paths } = createT4Harness();
    fs.mkdirSync(path.join(paths.agents, "agent-c"), { recursive: true });
    const legacy = {
      bundleBindings: [{ bundleId: "old-bundle", version: "1", pinned: true }],
      directSkillRefs: [
        {
          skillId: "old-skill",
          sourceId: "/old",
          sourceKind: "managed",
          version: "0.9.0",
          contentHash: "sha256-old",
        },
      ],
      overrides: { "old-skill@/old@0.9.0": "disabled" },
      learningPolicy: "ask-on-risk",
    };
    fs.writeFileSync(path.join(paths.agents, "agent-c", "skills.json"), JSON.stringify(legacy), "utf8");
    const migrated = configStore.getSkillsConfig("agent-c");
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.migratedFrom).toBe("legacy");
    expect(migrated.directSkillRefs).toHaveLength(1);
    expect(migrated.directSkillRefs[0]?.skillId).toBe("old-skill");
    expect(migrated.overrides["old-skill@/old@0.9.0"]).toBe("disabled");
    expect(migrated.learningPolicy).toBe("ask-on-risk");
  });

  it("保存前 TypeBox 校验：非法 selection 拒绝写入", () => {
    const { configStore } = createT4Harness();
    expect(() =>
      configStore.saveSkillsConfig("agent-d", {
        ...defaultAgentSkillConfig(),
        overrides: { "a@b@1": "shadowed" as never }, // shadowed 不允许持久化
      }),
    ).toThrow(SkillError);
  });

  it("Agent ID 非法（路径穿越尝试）→ 拒绝", () => {
    const { configStore } = createT4Harness();
    const root = tmpDir();
    expect(() => configStore.filePathFor("../escape")).toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
