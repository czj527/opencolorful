import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { NormalizedSkillManifest } from "../../../src/contracts/skill-protocol.js";
import { openMetadataDatabase } from "../../../src/storage/database.js";
import { normalizeSkillManifest } from "../../../src/runtime/skills/manifest.js";
import { pluginAwareReadiness } from "../../../src/runtime/skills/plugin/plugin-readiness.js";
import { makeEnv } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T7 pluginAwareReadiness（plans/phase-13.md §8.2 / §13.1）
// - requires.plugins：已绑定且启用 → ready；未绑定 → degraded；
//   绑定但停用 → blocked（skill_readiness_blocked）；
// - 来源级阻断 → blocked + blockedReason 含来源诊断；
// - 只诊断不授权：不读取/不创建任何 Grant（plugin_grants 无变化）。
// ═══════════════════════════════════════════════════════════════

function manifestWithRequires(requires: Record<string, unknown>): NormalizedSkillManifest {
  const normalized = normalizeSkillManifest({
    name: "plugin-gated",
    description: "插件门控测试",
    metadata: { opencolorful: { version: 1, requires: { ...requires } } },
  });
  if (!normalized.ok) {
    throw new Error(`manifest 构建失败：${normalized.reason}`);
  }
  return normalized.manifest;
}

const baseEnv = makeEnv({ plugins: [], tools: ["bash"], capabilities: ["network"] });

describe("pluginAwareReadiness", () => {
  it("requires.plugins 已绑定且启用 → ready（不产生 missing/degraded）", () => {
    const manifest = manifestWithRequires({ plugins: ["p1", "p2"] });
    const result = pluginAwareReadiness({
      manifest,
      environment: baseEnv,
      pluginBindings: [
        { pluginId: "p1", enabled: true },
        { pluginId: "p2", enabled: true },
      ],
    });
    expect(result.readiness).toBe("ready");
    expect(result.missing).toEqual([]);
    expect(result.degraded).toEqual([]);
  });

  it("requires.plugins 未绑定 → degraded（不阻断，可会话内补齐绑定）", () => {
    const manifest = manifestWithRequires({ plugins: ["p1"] });
    const result = pluginAwareReadiness({ manifest, environment: baseEnv, pluginBindings: [] });
    expect(result.readiness).toBe("degraded");
    expect(result.degraded).toContain("plugin:p1");
    expect(result.missing).toEqual([]);
  });

  it("requires.plugins 绑定但插件停用 → blocked（skill_readiness_blocked）", () => {
    const manifest = manifestWithRequires({ plugins: ["p1"] });
    const result = pluginAwareReadiness({
      manifest,
      environment: baseEnv,
      pluginBindings: [{ pluginId: "p1", enabled: false }],
    });
    expect(result.readiness).toBe("blocked");
    expect(result.blockedReason).toBe("skill_readiness_blocked");
    expect(result.missing).toContain("plugin:p1");
  });

  it("来源级阻断（插件卸载）→ blocked + blockedReason 含来源诊断", () => {
    const manifest = manifestWithRequires({});
    const result = pluginAwareReadiness({
      manifest,
      environment: baseEnv,
      sourceBlocked: { reason: "plugin_uninstalled:plg-1" },
    });
    expect(result.readiness).toBe("blocked");
    expect(result.blockedReason).toContain("skill_readiness_blocked");
    expect(result.blockedReason).toContain("plugin_uninstalled");
    expect(result.missing).toContain("source:blocked");
  });

  it("mixed：未绑定插件 degraded，其余绑定满足 → degraded", () => {
    const manifest = manifestWithRequires({ plugins: ["p1", "p2"] });
    const result = pluginAwareReadiness({
      manifest,
      environment: baseEnv,
      pluginBindings: [{ pluginId: "p2", enabled: true }],
    });
    expect(result.readiness).toBe("degraded");
    expect(result.degraded).toContain("plugin:p1");
  });

  it("无 requires 且无绑定 → ready", () => {
    const result = pluginAwareReadiness({ manifest: manifestWithRequires({}), environment: baseEnv, pluginBindings: [] });
    expect(result.readiness).toBe("ready");
  });

  it("OS 不匹配沿用 T2 → incompatible（不因绑定存在而放宽）", () => {
    const manifest = manifestWithRequires({ os: ["linux"], plugins: ["p1"] });
    const result = pluginAwareReadiness({
      manifest,
      environment: makeEnv({ os: "win32" }),
      pluginBindings: [{ pluginId: "p1", enabled: true }],
    });
    expect(result.readiness).toBe("incompatible");
    expect(result.blockedReason).toBe("skill_os_incompatible");
  });

  it("manifest 缺失 → incompatible（skill_manifest_invalid）", () => {
    const result = pluginAwareReadiness({ manifest: null, environment: baseEnv });
    expect(result.readiness).toBe("incompatible");
  });

  it("recommends.plugins 基于真实绑定（未绑定 → degraded 提示）", () => {
    const normalized = normalizeSkillManifest({
      name: "rec",
      description: "推荐",
      metadata: { opencolorful: { version: 1, recommends: { plugins: ["p9"] } } },
    });
    if (!normalized.ok) {
      throw new Error(normalized.reason);
    }
    const result = pluginAwareReadiness({ manifest: normalized.manifest, environment: baseEnv, pluginBindings: [] });
    expect(result.readiness).toBe("degraded");
    expect(result.degraded).toContain("recommend-plugin:p9");
  });

  it("只诊断不授权：plugin_grants 表无任何变化", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocf-readiness-grants-"));
    try {
      const db = openMetadataDatabase(path.join(directory, "metadata.sqlite"));
      try {
        const countBefore = (db.prepare("SELECT COUNT(*) AS n FROM plugin_grants").get() as { n: number }).n;
        const manifest = manifestWithRequires({ plugins: ["p1"] });
        pluginAwareReadiness({
          manifest,
          environment: baseEnv,
          pluginBindings: [{ pluginId: "p1", enabled: true }],
        });
        pluginAwareReadiness({
          manifest,
          environment: baseEnv,
          pluginBindings: [{ pluginId: "p1", enabled: false }],
        });
        pluginAwareReadiness({ manifest, environment: baseEnv, sourceBlocked: { reason: "plugin_uninstalled:p1" } });
        const countAfter = (db.prepare("SELECT COUNT(*) AS n FROM plugin_grants").get() as { n: number }).n;
        expect(countAfter).toBe(countBefore);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
