import { describe, expect, it } from "vitest";

import type { NormalizedSkillManifest } from "../../../src/contracts/skill-protocol.js";
import { diagnoseReadiness } from "../../../src/runtime/skills/readiness.js";
import { normalizeSkillManifest } from "../../../src/runtime/skills/manifest.js";
import { makeEnv } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 readiness 诊断测试（plans/phase-13.md §12.1 / §18.2）
// - OS/bin/env/plugin/tool/capability 门控正反例；
// - 只诊断不授权：不检查任何 Grant。
// ═══════════════════════════════════════════════════════════════

function manifestWithRequires(requires: Record<string, unknown>): NormalizedSkillManifest {
  const normalized = normalizeSkillManifest({
    name: "gated",
    description: "门控测试",
    metadata: { opencolorful: { version: 1, requires: { ...requires } } },
  });
  if (!normalized.ok) {
    throw new Error(`manifest 构建失败：${normalized.reason}`);
  }
  return normalized.manifest;
}

const fullEnv = makeEnv({
  os: "linux",
  bins: ["git", "node"],
  env: ["PATH", "HOME", "OPENAI_API_KEY"],
  plugins: ["p1"],
  tools: ["bash"],
  capabilities: ["network"],
  skills: ["code-review"],
});

describe("diagnoseReadiness", () => {
  it("无 requires → ready", () => {
    expect(diagnoseReadiness(manifestWithRequires({}), fullEnv).readiness).toBe("ready");
  });

  it("OS 不匹配 → incompatible（skill_os_incompatible）", () => {
    const diagnosis = diagnoseReadiness(manifestWithRequires({ os: ["linux"] }), makeEnv({ os: "win32" }));
    expect(diagnosis.readiness).toBe("incompatible");
    expect(diagnosis.blockedReason).toBe("skill_os_incompatible");
    expect(diagnosis.missing).toContain("os:win32");
  });

  it("缺失必需 bin → blocked（skill_readiness_blocked）", () => {
    const diagnosis = diagnoseReadiness(manifestWithRequires({ bins: ["git", "gh"] }), fullEnv);
    expect(diagnosis.readiness).toBe("blocked");
    expect(diagnosis.blockedReason).toBe("skill_readiness_blocked");
    expect(diagnosis.missing).toContain("bin:gh");
  });

  it("缺失 env → degraded（可在会话内补齐）", () => {
    const diagnosis = diagnoseReadiness(manifestWithRequires({ env: ["MISSING_VAR"] }), fullEnv);
    expect(diagnosis.readiness).toBe("degraded");
    expect(diagnosis.degraded).toContain("env:MISSING_VAR");
  });

  it("缺失插件 → blocked", () => {
    const diagnosis = diagnoseReadiness(manifestWithRequires({ plugins: ["p1", "p2"] }), fullEnv);
    expect(diagnosis.readiness).toBe("blocked");
    expect(diagnosis.missing).toContain("plugin:p2");
  });

  it("缺失工具 → degraded", () => {
    const diagnosis = diagnoseReadiness(manifestWithRequires({ tools: ["bash", "read"] }), fullEnv);
    expect(diagnosis.readiness).toBe("degraded");
    expect(diagnosis.degraded).toContain("tool:read");
  });

  it("缺失能力 → degraded", () => {
    const diagnosis = diagnoseReadiness(manifestWithRequires({ capabilities: ["network", "filesystem"] }), fullEnv);
    expect(diagnosis.readiness).toBe("degraded");
    expect(diagnosis.degraded).toContain("capability:filesystem");
  });

  it("缺失 recommend.skills/plugins → degraded（提示不阻塞）", () => {
    const normalized = normalizeSkillManifest({
      name: "gated",
      description: "门控测试",
      metadata: { opencolorful: { version: 1, recommends: { plugins: ["p9"], skills: ["missing-skill"] } } },
    });
    if (!normalized.ok) {
      throw new Error(normalized.reason);
    }
    const diagnosis = diagnoseReadiness(normalized.manifest, fullEnv);
    expect(diagnosis.readiness).toBe("degraded");
    expect(diagnosis.degraded).toContain("recommend-plugin:p9");
    expect(diagnosis.degraded).toContain("recommend-skill:missing-skill");
  });

  it("全部满足 → ready（正例）", () => {
    const manifest = manifestWithRequires({ os: ["linux"], bins: ["git"], env: ["HOME"], plugins: ["p1"], tools: ["bash"], capabilities: ["network"] });
    expect(diagnoseReadiness(manifest, fullEnv).readiness).toBe("ready");
  });

  it("无效 manifest（null）→ incompatible", () => {
    const diagnosis = diagnoseReadiness(null, fullEnv);
    expect(diagnosis.readiness).toBe("incompatible");
    expect(diagnosis.blockedReason).toBe("skill_manifest_invalid");
  });
});
