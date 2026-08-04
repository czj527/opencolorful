import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import { instrument } from "../../../observability/instrument.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import { pluginVersionDir, safeJoin } from "../paths.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Surface Contribution（plans/phase-12.md §8.5）
//
// - Page / Widget / Chat Surface 声明登记（页面/组件/聊天表面三类）；
// - 静态资源走受控 asset route：resolveAssetPath 校验资源路径必须位于
//   插件版本目录内（canonical + 目录包含判定），防符号链接/越权读取；
// - 本阶段只做登记与 asset 路径校验；iframe Host 渲染与 Surface Session
//   由 T8 Web 实现（authorizeSurface 已提供 Host capability 前置检查）。
// ═══════════════════════════════════════════════════════════════

export type SurfaceKind = "page" | "widget" | "chat-surface";

export interface SurfaceDescriptor {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly version: string;
  readonly kind: SurfaceKind;
  readonly name: string;
  readonly description?: string;
  /** 静态资源入口（相对插件版本目录） */
  readonly entry?: string;
  readonly hostCapabilities: readonly string[];
}

export interface SurfaceServiceDeps {
  readonly registry: ContributionRegistry;
  readonly policy: EffectivePolicy;
  readonly paths: RuntimePaths;
}

export class SurfaceService {
  constructor(private readonly deps: SurfaceServiceDeps) {}

  listSurfaces(kind?: SurfaceKind): SurfaceDescriptor[] {
    const result: SurfaceDescriptor[] = [];
    for (const contribution of this.deps.registry.listAll()) {
      if (contribution.kind !== "page" && contribution.kind !== "widget" && contribution.kind !== "chat-surface") {
        continue;
      }
      if (kind !== undefined && contribution.kind !== kind) {
        continue;
      }
      const descriptor = this.toDescriptor(contribution);
      if (descriptor !== undefined) {
        result.push(descriptor);
      }
    }
    return result;
  }

  getSurface(pluginId: string, surfaceId: string): SurfaceDescriptor | undefined {
    const contribution = this.deps.registry.get(pluginId, surfaceId);
    if (contribution === undefined) {
      return undefined;
    }
    if (contribution.kind !== "page" && contribution.kind !== "widget" && contribution.kind !== "chat-surface") {
      return undefined;
    }
    return this.toDescriptor(contribution);
  }

  /**
   * Surface 打开前置授权检查：ui.surface 能力经 EffectivePolicy 校验。
   * 拒绝时记录 plugin.surface.capability_denied 并返回原因。
   */
  authorizeSurface(input: {
    readonly pluginId: string;
    readonly surfaceId: string;
    readonly agentId: string;
    readonly sessionId?: string;
    readonly snapshot?: PluginExecutionSnapshot;
    readonly state?: ResolveState;
  }): { ok: true } | { ok: false; reason: string; deniedBy: string } {
    const contribution = this.deps.registry.get(input.pluginId, input.surfaceId);
    if (contribution === undefined) {
      return { ok: false, reason: "Surface 未登记", deniedBy: "registry" };
    }
    const manifestPermissions = this.deps.registry.getActive(input.pluginId)?.manifestPermissions;
    const resolution = this.deps.policy.resolveCapability({
      pluginId: input.pluginId,
      agentId: input.agentId,
      capability: "ui.surface",
      ...(manifestPermissions !== undefined ? { manifestPermissions } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    if (!resolution.allowed) {
      instrument.activity({
        eventName: "plugin.surface.capability_denied",
        actor: { kind: "plugin", id: input.pluginId },
        executor: { kind: "plugin", id: input.pluginId },
        scope: {
          pluginId: input.pluginId,
          ownerAgentId: input.agentId,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        },
        payload: {
          summaryCode: "plugin_surface_capability_denied",
          attributes: {
            pluginId: input.pluginId,
            surfaceId: input.surfaceId,
            deniedBy: resolution.deniedBy ?? "grant",
          },
        },
      });
      return { ok: false, reason: resolution.reason, deniedBy: resolution.deniedBy ?? "grant" };
    }
    return { ok: true };
  }

  /**
   * 受控 asset 路径解析：assetPath 必须是 Surface 相对资源路径，且解析后
   * 必须位于插件版本目录内（拒绝绝对路径/父目录穿越/符号链接）。
   */
  resolveAssetPath(input: {
    readonly pluginId: string;
    readonly surfaceId: string;
    readonly assetPath: string;
  }): { ok: true; path: string } | { ok: false; reason: string } {
    const surface = this.getSurface(input.pluginId, input.surfaceId);
    if (surface === undefined) {
      return { ok: false, reason: "Surface 未登记" };
    }
    const assetPath = input.assetPath;
    if (typeof assetPath !== "string" || assetPath.length === 0) {
      return { ok: false, reason: "asset 路径不能为空" };
    }
    if (path.isAbsolute(assetPath) || assetPath.includes("\\")) {
      return { ok: false, reason: "asset 路径必须相对且使用正斜杠" };
    }
    const segments = assetPath.split("/");
    if (segments.some((segment) => segment === "..")) {
      return { ok: false, reason: "asset 路径不能包含父目录穿越" };
    }
    if (segments.some((segment) => segment === "")) {
      return { ok: false, reason: "asset 路径不能包含空段" };
    }
    const versionDir = pluginVersionDir(this.deps.paths, surface.pluginId, surface.version);
    let resolved: string;
    try {
      resolved = safeJoin(versionDir, ...segments);
    } catch {
      return { ok: false, reason: "asset 路径不在插件版本目录内" };
    }
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        return { ok: false, reason: "asset 不允许是符号链接" };
      }
    } catch {
      return { ok: false, reason: "asset 文件不存在" };
    }
    return { ok: true, path: resolved };
  }

  // ── private helpers ───────────────────────────────────────────

  private toDescriptor(contribution: RegisteredContribution): SurfaceDescriptor | undefined {
    const kind = this.toSurfaceKind(contribution.kind);
    if (kind === undefined) {
      return undefined;
    }
    const descriptor: SurfaceDescriptor = {
      pluginId: contribution.pluginId,
      surfaceId: contribution.id,
      version: contribution.version,
      kind,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
      hostCapabilities: [],
    };
    const entry = contribution.spec["entry"];
    const withEntry = typeof entry === "string" && entry.length > 0 ? { ...descriptor, entry } : descriptor;
    const hostCapabilities = contribution.spec["hostCapabilities"];
    if (Array.isArray(hostCapabilities)) {
      const cleaned = hostCapabilities.filter((item): item is string => typeof item === "string");
      return { ...withEntry, hostCapabilities: cleaned };
    }
    return withEntry;
  }

  private toSurfaceKind(kind: string): SurfaceKind | undefined {
    if (kind === "page" || kind === "widget" || kind === "chat-surface") {
      return kind;
    }
    return undefined;
  }
}
