// ═══════════════════════════════════════════════════════════════
// Phase 12 Dev Invoke（plans/phase-12.md §15 / §19.2）
//
// - invoke-tool：指定 Agent/Session scope 复用真实权限（EffectivePolicy）
//   + RuntimeHost 包装 + Trace；不 bypass 权限/绑定；
// - list-surfaces / describe-surface：dev 槽内已登记 Surface 的查询与
//   受控 asset 路径解析；
// - 全部操作携带 devRunId，旧运行上下文不能操作新实例（DevHost 校验）。
// ═══════════════════════════════════════════════════════════════

import type { TraceContext } from "../../../contracts/observability.js";
import type { SurfaceDescriptor } from "../contributions/surface-contribution.js";
import type { PluginDevHost } from "./dev-host.js";

export interface PluginDevInvokeDeps {
  readonly host: PluginDevHost;
}

export type PluginDevInvokeResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

export interface PluginDevInvokeToolInput {
  readonly pluginId: string;
  readonly devRunId: string;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly trace?: TraceContext;
}

export type PluginDevDescribeSurfaceResult =
  | { readonly ok: true; readonly surface: SurfaceDescriptor; readonly assetPath?: string }
  | { readonly ok: false; readonly error: string };

export class PluginDevInvokeService {
  constructor(private readonly deps: PluginDevInvokeDeps) {}

  /**
   * 调用 dev 槽插件工具：devRunId 校验 → 确保激活 → 复用真实权限 +
   * RuntimeHost 包装（plugin.execution.* 生命周期）→ 输出校验。
   */
  async invokeTool(input: PluginDevInvokeToolInput): Promise<PluginDevInvokeResult> {
    const host = this.deps.host;
    const slot = host.requireSlot(input.pluginId, input.devRunId);
    await host.ensureActivated(input.pluginId);
    void slot;

    const result = await host.getDevHostApi().tools.invoke({
      pluginId: input.pluginId,
      contributionId: input.toolName,
      params: input.args ?? {},
      agentId: input.agentId,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
    });
    if (result.ok) {
      return { ok: true, result: result.result };
    }
    return { ok: false, error: result.message };
  }

  /** 列出 dev 槽内全部已登记 Surface（page / widget / chat-surface）。 */
  listSurfaces(): SurfaceDescriptor[] {
    return this.deps.host.getDevHostApi().surfaces.listSurfaces();
  }

  /** 查询单个 Surface 及其受控 asset 路径。 */
  describeSurface(pluginId: string, surfaceId: string): PluginDevDescribeSurfaceResult {
    const surfaces = this.deps.host.getDevHostApi().surfaces;
    const descriptor = surfaces.getSurface(pluginId, surfaceId);
    if (descriptor === undefined) {
      return { ok: false, error: `Surface 未登记：${pluginId}.${surfaceId}` };
    }
    if (descriptor.entry === undefined) {
      return { ok: true, surface: descriptor };
    }
    const asset = surfaces.resolveAssetPath({ pluginId, surfaceId, assetPath: descriptor.entry });
    if (asset.ok) {
      return { ok: true, surface: descriptor, assetPath: asset.path };
    }
    return { ok: true, surface: descriptor };
  }
}
