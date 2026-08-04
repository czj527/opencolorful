// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 iframe UI SDK — Surface 组件声明（plans/phase-12.md §8.5）
//
// 本阶段只提供类型声明与文档：
// - Surface 组件由插件以独立 iframe 资源提供（CSP + Surface Session +
//   Host 能力校验由宿主执行，本包不实现真实桥）；
// - useHostApi / defineSurfaceComponent 在本阶段运行时不可用，调用即抛
//   PluginComponentsNotImplementedError（T10/后续阶段接入真实 iframe 桥）。
// ═══════════════════════════════════════════════════════════════

import type { SurfaceContext, SurfaceHostApi } from "./host.js";

export class PluginComponentsNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginComponentsNotImplementedError";
  }
}

/** Surface 组件 props：宿主注入的只读上下文 + Host API。 */
export interface SurfaceComponentProps {
  readonly context: SurfaceContext;
  readonly host: SurfaceHostApi;
}

/** Surface 组件渲染函数签名（类型声明；渲染框架由插件自选）。 */
export type SurfaceComponent = (props: SurfaceComponentProps) => unknown;

export interface DefineSurfaceComponentOptions {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly kind: SurfaceContext["kind"];
  /** 需要的 Host 能力（宿主按此授权，未授权调用被拒） */
  readonly hostCapabilities?: readonly import("./host.js").HostCapability[];
  readonly component: SurfaceComponent;
}

/**
 * 声明一个 Surface 组件。真实 iframe 桥在本阶段未实现，调用即抛错；
 * 插件作者可用此类型先完成类型级集成，后续阶段替换为真实挂载。
 */
export function defineSurfaceComponent(_options: DefineSurfaceComponentOptions): never {
  throw new PluginComponentsNotImplementedError(
    "defineSurfaceComponent：iframe 桥尚未实现（Phase 12 T10/后续阶段），当前仅提供类型声明与文档",
  );
}

/**
 * 获取 Surface 侧 Host API 句柄。真实桥未实现，调用即抛错。
 */
export function useHostApi(): SurfaceHostApi {
  throw new PluginComponentsNotImplementedError(
    "useHostApi：iframe 桥尚未实现（Phase 12 T10/后续阶段），当前仅提供类型声明与文档",
  );
}
