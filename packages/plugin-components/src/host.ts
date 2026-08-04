// ═══════════════════════════════════════════════════════════════
// OpenColorful Phase 12 iframe UI SDK — Host 桥契约（plans/phase-12.md §8.5 / §19.1）
//
// 本阶段只提供类型/接口声明与文档，不实现真实 iframe 桥：
// - 插件 Surface（Settings Page / Widget / Chat Surface）在 iframe 中运行，
//   通过 postMessage 与宿主通信；宿主校验 CSP、Surface Session 与 Host
//   能力后放行（T8 已占位 / 后续阶段实现）；
// - Surface 不能直接调用平台 Store/spool/Audit，只能经 Host 白名单能力；
// - 所有消息携带 requestId，宿主按请求应答；插件不能自报平台权威字段
//   （actor/scope/trace/eventId 等一律由宿主盖章）。
// ═══════════════════════════════════════════════════════════════

/** Surface 种类（与 Manifest SurfaceContribution 对齐）。 */
export type SurfaceKind = "page" | "widget" | "chat-surface";

/** 宿主向 Surface 声明的可用 Host 能力（CSP/能力前置，T8 已冻结枚举）。 */
export type HostCapability =
  | "theme"
  | "toast"
  | "clipboard.read"
  | "clipboard.write"
  | "resource.open"
  | "resource.pick"
  | "external.open"
  | "navigate";

/** Surface 渲染上下文：宿主注入，只读，插件不能伪造。 */
export interface SurfaceContext {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly kind: SurfaceKind;
  /** Surface Session 一次性会话（宿主签发，过期即失效） */
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  /** 宿主主题 token（只读） */
  readonly theme: ThemeTokens;
}

/** 宿主主题 token（最小子集；Web 端扩展时由 T8 保持一致）。 */
export interface ThemeTokens {
  readonly mode: "light" | "dark";
  readonly primary: string;
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly textMuted: string;
  readonly border: string;
}

/** Surface → 宿主的请求种类。 */
export type HostRequestKind =
  | "theme.get"
  | "toast.show"
  | "clipboard.read"
  | "clipboard.write"
  | "resource.open"
  | "resource.pick"
  | "external.open"
  | "navigate";

/** Surface → 宿主请求（postMessage 载荷）。 */
export interface HostRequest {
  readonly requestId: string;
  readonly kind: HostRequestKind;
  readonly payload?: unknown;
}

/** 宿主 → Surface 应答。 */
export interface HostResponse<T = unknown> {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: string;
}

/** Surface → 宿主上行消息（请求） */
export type SurfaceBridgeMessage = HostRequest;

/** 宿主 → Surface 下行消息（应答 / 主题变更 / 资源结果） */
export type HostBridgeMessage =
  | HostResponse
  | { readonly kind: "theme.changed"; readonly theme: ThemeTokens };

/** Toast 级别。 */
export type ToastLevel = "info" | "success" | "warning" | "error";

/** Toast 显示载荷。 */
export interface ToastShowPayload {
  readonly message: string;
  readonly level?: ToastLevel;
  readonly durationMs?: number;
}

/** 外部链接打开载荷（宿主校验 scheme 白名单）。 */
export interface ExternalOpenPayload {
  readonly url: string;
}

/** 资源选择载荷（宿主经 Phase 9 权限校验后返回选择结果）。 */
export interface ResourcePickPayload {
  readonly filter?: readonly string[];
  readonly multi?: boolean;
}

/** 导航载荷（仅限插件自身 namespace 路由或宿主白名单页面）。 */
export interface NavigatePayload {
  readonly path: string;
}

/**
 * Surface 侧 Host API 类型声明：真实 iframe 桥在本阶段不实现，
 * 运行时调用会抛出 PluginComponentsNotImplementedError（见 useHostApi）。
 */
export interface SurfaceHostApi {
  /** 读取宿主主题（当前只读 token）。 */
  getTheme(): Promise<ThemeTokens>;
  /** 宿主 Toast 通知。 */
  showToast(input: ToastShowPayload): Promise<void>;
  /** 宿主剪贴板读取（需要 ui.host.clipboard）。 */
  readClipboard(): Promise<string>;
  /** 宿主剪贴板写入（需要 ui.host.clipboard）。 */
  writeClipboard(text: string): Promise<void>;
  /** 宿主资源打开（需要 resource.open）。 */
  openResource(uri: string): Promise<void>;
  /** 宿主资源选择（需要 resource.pick）。 */
  pickResource(input?: ResourcePickPayload): Promise<readonly string[]>;
  /** 宿主外部链接打开（需要 ui.host.external-open，scheme 白名单）。 */
  openExternal(input: ExternalOpenPayload): Promise<void>;
  /** 宿主导航（仅插件 namespace / 白名单路径）。 */
  navigate(input: NavigatePayload): Promise<void>;
}

/** Surface 声明：UI 资源入口 + 需要的 Host 能力。 */
export interface SurfaceDeclaration {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly version: string;
  readonly kind: SurfaceKind;
  readonly name: string;
  readonly description?: string;
  /** 静态资源入口（相对插件根），由受控 asset route 托管 */
  readonly entry: string;
  readonly hostCapabilities?: readonly HostCapability[];
}
