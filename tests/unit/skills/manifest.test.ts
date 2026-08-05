import { describe, expect, it } from "vitest";

import { normalizeSkillManifest, slugifySkillId } from "../../../src/runtime/skills/manifest.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 Manifest 标准化与兼容等级测试（plans/phase-13.md §8.4 / §18.1）
// ═══════════════════════════════════════════════════════════════

describe("normalizeSkillManifest：基础字段", () => {
  it("最小合法 manifest → pi-compatible", () => {
    const result = normalizeSkillManifest({ name: "git-workflow", description: "安全 Git 流程" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe("git-workflow");
      expect(result.manifest.compatibilityLevel).toBe("pi-compatible");
      expect(result.manifest.rawFrontmatter).toEqual({});
    }
  });

  it("缺少 name/description → 拒绝（skill_manifest_invalid）", () => {
    expect(normalizeSkillManifest({ name: "x" }).ok).toBe(false);
    expect(normalizeSkillManifest({ description: "d" }).ok).toBe(false);
    expect(normalizeSkillManifest({}).ok).toBe(false);
  });

  it("未知字段保留 rawFrontmatter（不授权）", () => {
    const result = normalizeSkillManifest({
      name: "a",
      description: "d",
      "custom-field": { nested: [1, 2] },
      version: "1.0.0",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.rawFrontmatter["custom-field"]).toEqual({ nested: [1, 2] });
      expect(result.manifest.rawFrontmatter["version"]).toBe("1.0.0");
      expect(result.manifest.rawFrontmatter["name"]).toBeUndefined();
    }
  });

  it("allowed-tools 字符串与列表都解析进 manifest（不产生授权）", () => {
    const single = normalizeSkillManifest({ name: "a", description: "d", "allowed-tools": "bash" });
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.manifest.allowedTools).toEqual(["bash"]);
    }
    const list = normalizeSkillManifest({ name: "a", description: "d", "allowed-tools": ["bash", "read"] });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.manifest.allowedTools).toEqual(["bash", "read"]);
    }
  });

  it("disable-model-invocation 布尔与字符串", () => {
    const yes = normalizeSkillManifest({ name: "a", description: "d", "disable-model-invocation": true });
    expect(yes.ok && yes.manifest.disableModelInvocation).toBe(true);
    const yesString = normalizeSkillManifest({ name: "a", description: "d", "disable-model-invocation": "true" });
    expect(yesString.ok && yesString.manifest.disableModelInvocation).toBe(true);
  });
});

describe("normalizeSkillManifest：opencolorful 扩展与兼容等级", () => {
  it("metadata.opencolorful version=1 → native", () => {
    const result = normalizeSkillManifest({
      name: "a",
      description: "d",
      metadata: {
        opencolorful: {
          version: 1,
          requires: { bins: ["git"], os: ["win32", "darwin", "linux"] },
          recommends: { plugins: ["p1"] },
          risk: "low",
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.compatibilityLevel).toBe("native");
      expect(result.manifest.opencolorful?.requires?.bins).toEqual(["git"]);
      expect(result.manifest.opencolorful?.risk).toBe("low");
    }
  });

  it("metadata.opencolorful version≠1 → unsupported 且需手工迁移", () => {
    const result = normalizeSkillManifest({
      name: "a",
      description: "d",
      metadata: { opencolorful: { version: 2 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.compatibilityLevel).toBe("unsupported");
      expect(result.manifest.compatibilityReport?.requiresManualMigration).toBe(true);
    }
  });

  it("opencolorful.requires 含未知高风险字段（grants）→ TypeBox 拒绝", () => {
    const result = normalizeSkillManifest({
      name: "a",
      description: "d",
      metadata: { opencolorful: { version: 1, requires: { grants: ["filesystem.write"] } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe("skill_manifest_invalid");
    }
  });

  it("OpenClaw 字段转换 → openclaw 等级，os 名称映射", () => {
    const result = normalizeSkillManifest({
      name: "a",
      description: "d",
      metadata: {
        openclaw: {
          requires: { bins: ["git"], os: ["linux", "macos", "windows"], env: ["OPENAI_API_KEY"], network: true },
          icon: "a.png",
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.compatibilityLevel).toBe("openclaw");
      expect(result.manifest.opencolorful?.requires?.bins).toEqual(["git"]);
      expect(result.manifest.opencolorful?.requires?.os).toEqual(["linux", "darwin", "win32"]);
      expect(result.manifest.opencolorful?.requires?.env).toEqual(["OPENAI_API_KEY"]);
      expect(result.manifest.compatibilityReport?.degradation).toContain("网络访问");
      expect(result.manifest.rawFrontmatter["metadata"]).toBeUndefined();
    }
  });

  it("Hermes platform/prerequisites 转换 → hermes 等级", () => {
    const result = normalizeSkillManifest({
      name: "a",
      description: "d",
      platform: ["linux", "windows"],
      prerequisites: { bins: ["python"], env: ["HOME"] },
      requires: ["foo"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.compatibilityLevel).toBe("hermes");
      expect(result.manifest.opencolorful?.requires?.os).toEqual(["linux", "win32"]);
      expect(result.manifest.opencolorful?.requires?.bins).toEqual(["python"]);
      expect(result.manifest.opencolorful?.requires?.tools).toEqual(["foo"]);
    }
  });

  it("正文为空 → metadata-only（仅元数据可用）", () => {
    const result = normalizeSkillManifest({ name: "a", description: "d" }, { body: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.compatibilityLevel).toBe("metadata-only");
      expect(result.manifest.compatibilityReport?.requiresManualMigration).toBe(true);
      expect(result.manifest.compatibilityReport?.degradation).toContain("正文为空");
    }
  });

  it("未知高风险顶层字段（permissions）→ 降级诊断 + 需人工确认", () => {
    const result = normalizeSkillManifest({ name: "a", description: "d", permissions: { shell: true } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.compatibilityLevel).toBe("pi-compatible");
      expect(result.manifest.compatibilityReport?.requiresManualMigration).toBe(true);
      expect(result.manifest.compatibilityReport?.degradation).toContain("permissions");
      expect(result.manifest.rawFrontmatter["permissions"]).toEqual({ shell: true });
    }
  });
});

describe("slugifySkillId", () => {
  it("名称 → 小写 kebab", () => {
    expect(slugifySkillId("Git Workflow")).toBe("git-workflow");
    expect(slugifySkillId("  Code  Review ")).toBe("code-review");
    expect(slugifySkillId("中文技能")).toBe("中文技能");
  });
});
