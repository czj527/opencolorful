// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 插件开发辅助函数（plans/phase-12.md §15 / §19.1）
//
// - definePlugin / defineTool / defineCommand / defineRoute / defineSurface
//   / defineConfig / defineSecret / defineBackground / defineHook /
//   defineAttachment / defineActivity / defineSkillBundle：声明式构造辅助，
//   全部基于 @opencolorful/plugin-protocol 冻结 Schema 做 fail-closed 校验；
// - 插件作者可以把这些辅助函数的结果写入 manifest.json，或直接作为
//   manifest 对象使用；本包不 import Server 内部实现；
// - defineSurface 需要显式 kind（page / widget / chat-surface），同一
//   SurfaceContributionSchema 校验，kind 仅用于可读性约束。
// ═══════════════════════════════════════════════════════════════

import {
  BackgroundContributionSchema,
  CommandContributionSchema,
  ConfigContributionSchema,
  ContextAttachmentContributionSchema,
  CustomActivityContributionSchema,
  HookContributionSchema,
  ManifestV1Schema,
  RouteContributionSchema,
  SecretContributionSchema,
  SkillBundleContributionSchema,
  SurfaceContributionSchema,
  ToolContributionSchema,
  type BackgroundContribution,
  type CommandContribution,
  type ConfigContribution,
  type ContextAttachmentContribution,
  type Contributions,
  type CustomActivityContribution,
  type HookContribution,
  type ManifestCompatibility,
  type ManifestDev,
  type ManifestRuntime,
  type ManifestV1,
  type PermissionRequest,
  type PluginAuthor,
  type PluginTrust,
  type RouteContribution,
  type SecretContribution,
  type SkillBundleContribution,
  type SurfaceContribution,
  type ToolContribution,
} from "@opencolorful/plugin-protocol";

import { assertNonEmptyString, assertValidWithSchema } from "./errors.js";

// ═══════════════════════════════════════════════════════════════
// definePlugin：完整 Manifest v1 构造（默认值 + 全量 Schema 校验）
// ═══════════════════════════════════════════════════════════════

export interface PluginManifestInput {
  /** 全局稳定 id（^[a-z0-9][a-z0-9._-]{0,127}$），不可因更新改变 */
  readonly id: string;
  readonly name: string;
  /** SemVer */
  readonly version: string;
  readonly description?: string;
  readonly author?: PluginAuthor;
  readonly license?: string;
  readonly compatibility?: ManifestCompatibility;
  /** 缺省 restricted（代码运行时需显式 full-access） */
  readonly trust?: PluginTrust;
  /** 缺省 bundle（无子进程） */
  readonly runtime?: ManifestRuntime;
  readonly permissions?: readonly PermissionRequest[];
  readonly contributions?: Contributions;
  /** 非敏感配置 Schema（JSON Schema 子集）；Secret 只声明不存值 */
  readonly config?: unknown;
  readonly dev?: ManifestDev;
}

/** 当前宿主兼容范围默认值（openColorful 平台当前主版本）。 */
export const DEFAULT_COMPATIBILITY_RANGE = ">=0.1.0" as const;

export function definePlugin(input: PluginManifestInput): ManifestV1 {
  assertNonEmptyString(input.id, "插件 id");
  assertNonEmptyString(input.name, "插件 name");
  assertNonEmptyString(input.version, "插件 version");
  const manifest: ManifestV1 = {
    manifestVersion: 1,
    id: input.id,
    name: input.name,
    version: input.version,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.author !== undefined ? { author: input.author } : {}),
    ...(input.license !== undefined ? { license: input.license } : {}),
    compatibility: input.compatibility ?? { opencolorful: DEFAULT_COMPATIBILITY_RANGE, pluginApi: 1 },
    trust: input.trust ?? "restricted",
    runtime: input.runtime ?? { kind: "bundle" },
    permissions: [...(input.permissions ?? [])],
    contributions: input.contributions ?? {},
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.dev !== undefined ? { dev: input.dev } : {}),
  };
  assertValidWithSchema(ManifestV1Schema, manifest, "插件 Manifest");
  return manifest;
}

// ═══════════════════════════════════════════════════════════════
// Contribution 构造辅助（每类对应冻结 Schema 校验）
// ═══════════════════════════════════════════════════════════════

/** Surface 种类（页面 / 组件 / 聊天表面）。 */
export type SurfaceKind = "page" | "widget" | "chat-surface";

export function defineTool(input: ToolContribution): ToolContribution {
  assertNonEmptyString(input.id, "tool contribution id");
  assertNonEmptyString(input.name, "tool contribution name");
  assertValidWithSchema(ToolContributionSchema, input, "tool contribution");
  return input;
}

export function defineCommand(input: CommandContribution): CommandContribution {
  assertNonEmptyString(input.id, "command contribution id");
  assertNonEmptyString(input.name, "command contribution name");
  assertValidWithSchema(CommandContributionSchema, input, "command contribution");
  return input;
}

export function defineRoute(input: RouteContribution): RouteContribution {
  assertNonEmptyString(input.id, "route contribution id");
  assertNonEmptyString(input.name, "route contribution name");
  assertNonEmptyString(input.path, "route contribution path");
  assertValidWithSchema(RouteContributionSchema, input, "route contribution");
  return input;
}

export function defineSurface(input: SurfaceContribution, kind: SurfaceKind): SurfaceContribution {
  assertNonEmptyString(input.id, `surface(${kind}) contribution id`);
  assertNonEmptyString(input.name, `surface(${kind}) contribution name`);
  if (kind !== "page" && kind !== "widget" && kind !== "chat-surface") {
    throw new Error(`surface kind 必须是 page / widget / chat-surface：${String(kind)}`);
  }
  assertValidWithSchema(SurfaceContributionSchema, input, `surface(${kind}) contribution`);
  return input;
}

export function defineConfig(input: ConfigContribution): ConfigContribution {
  assertNonEmptyString(input.id, "config contribution id");
  assertNonEmptyString(input.name, "config contribution name");
  assertValidWithSchema(ConfigContributionSchema, input, "config contribution");
  return input;
}

export function defineSecret(input: SecretContribution): SecretContribution {
  assertNonEmptyString(input.id, "secret contribution id");
  assertNonEmptyString(input.name, "secret contribution name");
  assertNonEmptyString(input.secretName, "secret contribution secretName");
  assertValidWithSchema(SecretContributionSchema, input, "secret contribution");
  return input;
}

export function defineBackground(input: BackgroundContribution): BackgroundContribution {
  assertNonEmptyString(input.id, "background contribution id");
  assertNonEmptyString(input.name, "background contribution name");
  assertValidWithSchema(BackgroundContributionSchema, input, "background contribution");
  return input;
}

export function defineHook(input: HookContribution): HookContribution {
  assertNonEmptyString(input.id, "hook contribution id");
  assertNonEmptyString(input.name, "hook contribution name");
  assertNonEmptyString(input.point, "hook contribution point");
  assertValidWithSchema(HookContributionSchema, input, "hook contribution");
  return input;
}

export function defineAttachment(input: ContextAttachmentContribution): ContextAttachmentContribution {
  assertNonEmptyString(input.id, "context-attachment contribution id");
  assertNonEmptyString(input.name, "context-attachment contribution name");
  assertValidWithSchema(ContextAttachmentContributionSchema, input, "context-attachment contribution");
  return input;
}

export function defineActivity(input: CustomActivityContribution): CustomActivityContribution {
  assertNonEmptyString(input.id, "custom-activity contribution id");
  assertNonEmptyString(input.name, "custom-activity contribution name");
  assertNonEmptyString(input.eventNamespace, "custom-activity contribution eventNamespace");
  assertValidWithSchema(CustomActivityContributionSchema, input, "custom-activity contribution");
  return input;
}

export function defineSkillBundle(input: SkillBundleContribution): SkillBundleContribution {
  assertNonEmptyString(input.id, "skill-bundle contribution id");
  assertNonEmptyString(input.name, "skill-bundle contribution name");
  assertValidWithSchema(SkillBundleContributionSchema, input, "skill-bundle contribution");
  return input;
}
