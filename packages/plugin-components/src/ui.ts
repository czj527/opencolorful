// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 iframe UI SDK — Surface 组件声明（plans/phase-12.md §8.5）
//
// 本阶段提供类型声明、文档与受控资产路由 URL 解析：
// - Surface 组件由插件以独立 iframe 资源提供（CSP + Surface Session +
//   Host 能力校验由宿主执行）；插件静态资源经受控资产路由
//   `GET /api/plugins/:id/assets/<相对路径>` 托管（路径穿越防护由 Server 校验）；
// - defineSurfaceComponent 返回注册描述（含可用的资产 URL 或 null），
//   调用不抛错；宿主可将 assetUrl 直接作为 iframe src 渲染；
// - useHostApi 的真实 iframe 桥（postMessage 宿主通道）由后续阶段接入，
//   当前返回降级句柄：调用本身不抛异常，句柄方法以拒绝的 Promise
//   携带明确的 PluginComponentsNotImplementedError（见下方实现）。
// ═══════════════════════════════════════════════════════════════

import type { HostCapability, SurfaceContext, SurfaceHostApi } from "./host.js";

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
  /**
   * 静态资源入口（相对插件版本目录，与 Manifest SurfaceContribution.entry
   * 一致，例如 `ui/settings.html`）；受控资产路由按此拼接 URL。
   */
  readonly entry: string;
  /** 宿主 API base URL（可选）；提供时注册描述携带可直接使用的 assetUrl */
  readonly apiUrl?: string;
  /** 需要的 Host 能力（宿主按此授权，未授权调用被拒） */
  readonly hostCapabilities?: readonly HostCapability[];
  readonly component: SurfaceComponent;
}

/** defineSurfaceComponent 的返回描述：宿主据此渲染 Surface iframe。 */
export interface SurfaceComponentRegistration {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly kind: SurfaceContext["kind"];
  /** 静态资源入口（相对插件版本目录） */
  readonly entry: string;
  readonly hostCapabilities: readonly HostCapability[];
  readonly component: SurfaceComponent;
  /**
   * 受控资产路由完整 URL（提供 apiUrl 时）；未提供 apiUrl 时为 null，
   * 宿主应使用 resolveSurfaceAssetUrl 自行拼接。
   */
  readonly assetUrl: string | null;
  /** 桥状态：当前为降级声明，宿主可直接将 assetUrl 作为 iframe src 渲染 */
  readonly bridge: "unimplemented";
}

/**
 * 拼接插件 Surface 资产的受控路由 URL。
 *
 * 约定：`GET /api/plugins/:id/assets/<相对路径>`（服务插件版本目录内文件，
 * 路径穿越防护由 Server 校验）。entry 按 `/` 分段逐段 encodeURIComponent，
 * pluginId 整体 encodeURIComponent；apiUrl 尾部斜杠会被归一化，
 * 传空串时返回站内相对路径（`/api/plugins/...`），可直接用作 iframe src。
 */
export function resolveSurfaceAssetUrl(apiUrl: string, pluginId: string, entry: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  const segments = entry
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/api/plugins/${encodeURIComponent(pluginId)}/assets/${segments}`;
}

/**
 * 声明一个 Surface 组件。返回注册描述（含资产 URL），调用不抛错；
 * 真实 iframe 桥（postMessage 宿主通道）在后续阶段接入，宿主当前可将
 * 返回的 assetUrl 直接作为 iframe src 渲染插件静态资源。
 */
export function defineSurfaceComponent(options: DefineSurfaceComponentOptions): SurfaceComponentRegistration {
  return {
    pluginId: options.pluginId,
    surfaceId: options.surfaceId,
    kind: options.kind,
    entry: options.entry,
    hostCapabilities: options.hostCapabilities ?? [],
    component: options.component,
    assetUrl:
      options.apiUrl !== undefined
        ? resolveSurfaceAssetUrl(options.apiUrl, options.pluginId, options.entry)
        : null,
    bridge: "unimplemented",
  };
}

/** 降级句柄的统一拒绝：携带桥未接线的明确说明（异步拒绝，非同步抛错）。 */
function unimplementedHostCall(method: string): Promise<never> {
  return Promise.reject(
    new PluginComponentsNotImplementedError(
      `useHostApi().${method}：iframe 桥（postMessage 宿主通道）尚未接线（后续阶段）。` +
        "Surface 静态资源经受控资产路由 GET /api/plugins/:id/assets/<相对路径> 托管；" +
        "当前请以纯静态 HTML 渲染，宿主能力调用在桥接入后可用。",
    ),
  );
}

/**
 * 获取 Surface 侧 Host API 句柄。真实桥（postMessage 宿主通道）未实现，
 * 本函数返回降级句柄：调用本身不抛异常；句柄的每个方法返回拒绝的
 * Promise，携带 PluginComponentsNotImplementedError 并说明资产路由约定。
 */
export function useHostApi(): SurfaceHostApi {
  return {
    getTheme: () => unimplementedHostCall("getTheme"),
    showToast: () => unimplementedHostCall("showToast"),
    readClipboard: () => unimplementedHostCall("readClipboard"),
    writeClipboard: () => unimplementedHostCall("writeClipboard"),
    openResource: () => unimplementedHostCall("openResource"),
    pickResource: () => unimplementedHostCall("pickResource"),
    openExternal: () => unimplementedHostCall("openExternal"),
    navigate: () => unimplementedHostCall("navigate"),
  };
}
