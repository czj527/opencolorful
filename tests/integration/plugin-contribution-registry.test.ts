import { afterEach, describe, expect, it } from "vitest";

import type { Contributions } from "../../src/contracts/plugin-protocol.js";
import {
  ContributionRegistry,
  PluginContributionError,
} from "../../src/runtime/plugins/contributions/contribution-registry.js";
import { cleanupT5 } from "./plugin-t5-helper.js";

// ═══════════════════════════════════════════════════════════════
// T5 Contribution Registry（plans/phase-12.md §八 / §21.3）
// - 同一 pluginId 内 contribution id 全局唯一（跨 kind）；
// - get/list/isRegistered 查询；
// - 禁用/更新后旧 contribution 不可调用（unregister 立即失效）。
// ═══════════════════════════════════════════════════════════════

afterEach(() => {
  cleanupT5();
});

const CONTRIBUTIONS: Contributions = {
  tool: [
    { id: "echo", name: "Echo", inputSchema: { type: "object" }, riskLevel: "low" },
    { id: "fetch", name: "Fetch", requiredCapabilities: ["network.connect"], riskLevel: "high" },
  ],
  command: [{ id: "help", name: "Help", argumentsSchema: { type: "object" } }],
  route: [{ id: "hello", name: "Hello Route", path: "hello" }],
  "chat-surface": [{ id: "main", name: "Main Surface", entry: "index.html", hostCapabilities: ["theme"] }],
  background: [{ id: "worker", name: "Worker", maxConcurrency: 2, maxRetries: 1, timeoutMs: 5000 }],
  hook: [{ id: "before-msg", name: "Before Message", point: "message.before-send", behavior: "block" }],
  config: [{ id: "cfg", name: "Config", schema: { type: "object" } }],
  secret: [{ id: "api-key", name: "API Key", secretName: "apiKey", purpose: "provider credential" }],
  "context-attachment": [{ id: "file", name: "File", schema: { type: "object" } }],
  "custom-activity": [{ id: "stats", name: "Stats", eventNamespace: "plugin.example.stats" }],
  "skill-bundle": [{ id: "skills", name: "Skills", skillsDir: "skills" }],
  provider: [{ id: "search", name: "Search", kind: "search" }],
};

describe("ContributionRegistry：登记与查询", () => {
  it("register 展开全部 12 类 contribution，get/list/isRegistered 可查询", () => {
    const registry = new ContributionRegistry();
    const set = registry.register({ pluginId: "example.p", version: "1.0.0", contributions: CONTRIBUTIONS });
    expect(set.contributions.length).toBe(13);
    expect(registry.hasPlugin("example.p")).toBe(true);
    expect(registry.isRegistered("example.p", "echo")).toBe(true);
    expect(registry.get("example.p", "echo")?.kind).toBe("tool");
    expect(registry.get("example.p", "help")?.kind).toBe("command");
    expect(registry.get("example.p", "api-key")?.kind).toBe("secret");
    expect(registry.list("example.p")).toHaveLength(13);
    expect(registry.listByKind("example.p", "tool")).toHaveLength(2);
    expect(registry.listByKind("example.p", "skill-bundle")[0]?.spec["skillsDir"]).toBe("skills");
  });

  it("contribution 记录携带 requiredCapabilities 与安全摘要字段", () => {
    const registry = new ContributionRegistry();
    registry.register({ pluginId: "example.p", version: "1.0.0", contributions: CONTRIBUTIONS });
    const fetch = registry.get("example.p", "fetch");
    expect(fetch?.requiredCapabilities).toEqual(["network.connect"]);
    expect(fetch?.version).toBe("1.0.0");
    expect(fetch?.name).toBe("Fetch");
  });

  it("manifestPermissions 与 trust 被记录", () => {
    const registry = new ContributionRegistry();
    const set = registry.register({
      pluginId: "example.p",
      version: "1.0.0",
      contributions: { tool: [{ id: "echo", name: "Echo" }] },
      manifestPermissions: [{ capability: "tool.register", reason: "provide tools" }],
      trust: "full-access",
    });
    expect(set.trust).toBe("full-access");
    expect(set.manifestPermissions[0]).toEqual({ capability: "tool.register", reason: "provide tools" });
  });

  it("listAll 跨插件聚合，listPlugins 返回已登记插件", () => {
    const registry = new ContributionRegistry();
    registry.register({ pluginId: "example.a", version: "1.0.0", contributions: { tool: [{ id: "t1", name: "T1" }] } });
    registry.register({ pluginId: "example.b", version: "1.0.0", contributions: { command: [{ id: "c1", name: "C1" }] } });
    expect(registry.listPlugins()).toEqual(["example.a", "example.b"]);
    expect(registry.listAll()).toHaveLength(2);
  });

  it("未登记插件：get/list/isRegistered 均返回空", () => {
    const registry = new ContributionRegistry();
    expect(registry.get("example.missing", "x")).toBeUndefined();
    expect(registry.list("example.missing")).toEqual([]);
    expect(registry.isRegistered("example.missing", "x")).toBe(false);
    expect(registry.hasPlugin("example.missing")).toBe(false);
  });

  it("无效插件 ID 拒绝登记", () => {
    const registry = new ContributionRegistry();
    expect(() =>
      registry.register({ pluginId: "Bad Id!", version: "1.0.0", contributions: {} }),
    ).toThrow(PluginContributionError);
  });
});

describe("ContributionRegistry：唯一性与失效", () => {
  it("同一 pluginId 内跨 kind 的重复 id 拒绝登记（fail-closed）", () => {
    const registry = new ContributionRegistry();
    expect(() =>
      registry.register({
        pluginId: "example.p",
        version: "1.0.0",
        contributions: {
          tool: [{ id: "dup", name: "Tool Dup" }],
          command: [{ id: "dup", name: "Command Dup" }],
        },
      }),
    ).toThrow(/contribution id 重复/);
  });

  it("同 kind 内重复 id 拒绝登记", () => {
    const registry = new ContributionRegistry();
    expect(() =>
      registry.register({
        pluginId: "example.p",
        version: "1.0.0",
        contributions: {
          tool: [
            { id: "dup", name: "A" },
            { id: "dup", name: "B" },
          ],
        },
      }),
    ).toThrow(/contribution id 重复/);
  });

  it("缺少合法 id/name 的 contribution 拒绝登记", () => {
    const registry = new ContributionRegistry();
    expect(() =>
      registry.register({
        pluginId: "example.p",
        version: "1.0.0",
        contributions: { tool: [{ name: "no id" }] } as unknown as Contributions,
      }),
    ).toThrow(/缺少合法 id/);
    expect(() =>
      registry.register({
        pluginId: "example.p",
        version: "1.0.0",
        contributions: { tool: [{ id: "x" }] } as unknown as Contributions,
      }),
    ).toThrow(/缺少合法 name/);
  });

  it("unregister 后旧 contribution 立即不可查询（禁用/更新后不可调用）", () => {
    const registry = new ContributionRegistry();
    registry.register({ pluginId: "example.p", version: "1.0.0", contributions: { tool: [{ id: "echo", name: "Echo" }] } });
    expect(registry.isRegistered("example.p", "echo")).toBe(true);
    registry.unregister("example.p");
    expect(registry.isRegistered("example.p", "echo")).toBe(false);
    expect(registry.get("example.p", "echo")).toBeUndefined();
    expect(registry.list("example.p")).toEqual([]);
    expect(registry.hasPlugin("example.p")).toBe(false);
  });

  it("更新版本重新登记后，新版本替换旧版本（旧 id 若移除则不可再查）", () => {
    const registry = new ContributionRegistry();
    registry.register({
      pluginId: "example.p",
      version: "1.0.0",
      contributions: { tool: [{ id: "old-tool", name: "Old" }] },
    });
    registry.register({
      pluginId: "example.p",
      version: "2.0.0",
      contributions: { tool: [{ id: "new-tool", name: "New" }] },
    });
    expect(registry.get("example.p", "old-tool")).toBeUndefined();
    expect(registry.get("example.p", "new-tool")?.version).toBe("2.0.0");
    expect(registry.getActive("example.p")?.version).toBe("2.0.0");
  });
});
