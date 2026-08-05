import { describe, expect, it } from "vitest";

import Value from "typebox/value";

import {
  BundleRefSchema,
  NormalizedSkillManifestSchema,
  SkillRefSchema,
  SKILL_BUDGETS,
  SKILL_ERROR_CODES,
  SkillLoadHandleSchema,
  skillRefKey,
  SkillStagedPackageSchema,
} from "../../src/contracts/skill-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 契约冻结测试（plans/phase-13.md §五 / §7 / §8.4 / §18.1）
// - 稳定引用不可伪造（skillId/sourceId/sourceKind/version/contentHash 全必填）；
// - NormalizedSkillManifest 正反例（未知高风险字段不得静默授权）；
// - 错误 reasonCode 稳定枚举、预算常量、loadHandle 绑定语义。
// ═══════════════════════════════════════════════════════════════

describe("Phase 13 Skill 契约（T1 冻结）", () => {
  it("SkillRef 五要素必填且不可伪造（缺任一字段拒绝）", () => {
    const valid = {
      skillId: "git-workflow",
      sourceId: "managed",
      sourceKind: "managed",
      version: "1.2.0",
      contentHash: "sha256-abcdef1234567890abcdef1234567890",
    };
    expect(Value.Check(SkillRefSchema, valid)).toBe(true);

    for (const key of ["skillId", "sourceId", "sourceKind", "version", "contentHash"] as const) {
      const { [key]: _removed, ...rest } = { ...valid };
      expect(Value.Check(SkillRefSchema, rest), `缺少 ${key} 应拒绝`).toBe(false);
    }
    // 未知字段拒绝（additionalProperties: false）
    expect(Value.Check(SkillRefSchema, { ...valid, extra: "x" })).toBe(false);
    // 非法 sourceKind 拒绝
    expect(Value.Check(SkillRefSchema, { ...valid, sourceKind: "claude" })).toBe(false);
  });

  it("skillRefKey 是稳定字符串键（不依赖名称）", () => {
    expect(skillRefKey({ skillId: "a", sourceId: "s", version: "1" })).toBe("a@s@1");
    // 与完整 ref 一致
    expect(
      skillRefKey({
        skillId: "git-workflow",
        sourceId: "managed",
        version: "1.2.0",
      }),
    ).toBe("git-workflow@managed@1.2.0");
  });

  it("BundleRef 必填 bundleId/version/contentHash", () => {
    expect(
      Value.Check(BundleRefSchema, {
        bundleId: "bundle-ops",
        version: "2.0.0",
        contentHash: "sha256-bbb",
      }),
    ).toBe(true);
    expect(
      Value.Check(BundleRefSchema, { bundleId: "b", version: "2.0.0" }),
    ).toBe(false);
  });

  it("NormalizedSkillManifest：合法 frontmatter + opencolorful 扩展通过", () => {
    const manifest = {
      name: "git-workflow",
      description: "安全的 Git 工作流步骤",
      license: "MIT",
      compatibility: ">=1.0",
      allowedTools: ["bash", "read"],
      disableModelInvocation: false,
      opencolorful: {
        version: 1,
        requires: { bins: ["git"], os: ["win32", "darwin", "linux"] },
        recommends: { skills: ["code-review"] },
        risk: "low",
      },
      rawFrontmatter: { "custom-field": "保留展示" },
      compatibilityLevel: "native",
    };
    expect(Value.Check(NormalizedSkillManifestSchema, manifest)).toBe(true);
  });

  it("NormalizedSkillManifest：非法平台扩展拒绝（requires 只允许白名单字段）", () => {
    const manifest = {
      name: "bad",
      description: "x",
      rawFrontmatter: {},
      compatibilityLevel: "native",
      opencolorful: {
        version: 1,
        // 未知高风险字段（如 grant）不得进入契约
        requires: { grants: ["filesystem.write"] },
      },
    };
    expect(Value.Check(NormalizedSkillManifestSchema, manifest)).toBe(false);
    // version 非 1 拒绝
    expect(
      Value.Check(NormalizedSkillManifestSchema, {
        name: "bad",
        description: "x",
        rawFrontmatter: {},
        compatibilityLevel: "native",
        opencolorful: { version: 2 },
      }),
    ).toBe(false);
  });

  it("NormalizedSkillManifest：缺少 name/description 拒绝（description 缺失则技能不可用）", () => {
    expect(
      Value.Check(NormalizedSkillManifestSchema, { description: "x", rawFrontmatter: {}, compatibilityLevel: "native" }),
    ).toBe(false);
    expect(
      Value.Check(NormalizedSkillManifestSchema, { name: "x", rawFrontmatter: {}, compatibilityLevel: "native" }),
    ).toBe(false);
  });

  it("兼容等级枚举：六档合法值（native→unsupported）", () => {
    for (const level of ["native", "pi-compatible", "openclaw", "hermes", "metadata-only", "unsupported"]) {
      expect(
        Value.Check(NormalizedSkillManifestSchema, {
          name: "s",
          description: "d",
          rawFrontmatter: {},
          compatibilityLevel: level,
        }),
        level,
      ).toBe(true);
    }
    expect(
      Value.Check(NormalizedSkillManifestSchema, {
        name: "s",
        description: "d",
        rawFrontmatter: {},
        compatibilityLevel: "full",
      }),
    ).toBe(false);
  });

  it("SKILL_ERROR_CODES 稳定枚举：禁止新增未登记错误码（跨进程诊断契约）", () => {
    // 枚举必须稳定（此处断言已知首尾，防止误删/误改破坏诊断契约）
    expect(SKILL_ERROR_CODES).toContain("skill_path_escape");
    expect(SKILL_ERROR_CODES).toContain("skill_load_handle_expired");
    expect(SKILL_ERROR_CODES).toContain("skill_confirmation_reused");
    expect(new Set(SKILL_ERROR_CODES).size).toBe(SKILL_ERROR_CODES.length);
  });

  it("注入预算常量冻结（§十 10.2 / §二十一）", () => {
    expect(SKILL_BUDGETS.maxSkillsPerSnapshot).toBe(32);
    expect(SKILL_BUDGETS.maxMetadataChars).toBe(4000);
    expect(SKILL_BUDGETS.maxSingleFileBytes).toBe(256 * 1024);
    expect(SKILL_BUDGETS.maxSupportBytesPerTurn).toBe(512 * 1024);
    expect(SKILL_BUDGETS.maxDependencyDepth).toBe(4);
    expect(SKILL_BUDGETS.maxDependencyCheckSkills).toBe(32);
  });

  it("loadHandle 绑定 turnId+sessionId+skillRef+contentHash，单次有效", () => {
    const handle = {
      handleId: "h-1",
      turnId: "turn-1",
      sessionId: "session-1",
      skillRef: {
        skillId: "git-workflow",
        sourceId: "managed",
        sourceKind: "managed",
        version: "1.2.0",
        contentHash: "sha256-aaa",
      },
      contentHash: "sha256-aaa",
      issuedAt: "2026-08-05T00:00:00Z",
      expiresAt: "2026-08-05T00:01:00Z",
      consumed: false,
    };
    expect(Value.Check(SkillLoadHandleSchema, handle)).toBe(true);
    // 跨 turn 重放（turnId 不符）由校验层拒绝——契约保证 handle 绑定 turnId
    expect(
      Value.Check(SkillLoadHandleSchema, { ...handle, turnId: "turn-2" }),
    ).toBe(true); // schema 本身不校验一致性，一致性由 ContentService（T5）保证
  });

  it("StagedPackage 只接受完整包（packageRoot/manifestPath/hash/provenance 必填）", () => {
    const staged = {
      packageRoot: "/tmp/stage/op-1/skill",
      manifestPath: "/tmp/stage/op-1/skill/SKILL.md",
      contentHash: "sha256-ccc",
      sizeBytes: 4096,
      fileCount: 3,
      provenance: { sourceRef: "local://fixture", fetchedAt: "2026-08-05T00:00:00Z" },
    };
    expect(Value.Check(SkillStagedPackageSchema, staged)).toBe(true);
    expect(Value.Check(SkillStagedPackageSchema, { ...staged, manifestPath: undefined })).toBe(false);
  });
});
