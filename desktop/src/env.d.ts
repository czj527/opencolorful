interface DesktopShellApi {
  readonly platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  pickDirectory(): Promise<string | null>;
}

interface DesktopApiFrame {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

interface DesktopApiInvokeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly data: unknown;
  readonly base: string;
}

interface DesktopApi {
  invoke(method: string, path: string, body?: unknown): Promise<DesktopApiInvokeResult>;
  subscribeEvents(path: string, lastEventId?: string): string;
  unsubscribeEvents(subId: string): void;
  onEvent(handler: (payload: { readonly subId: string; readonly frame: DesktopApiFrame }) => void): () => void;
  /**
   * F3 flaky 回归：订阅的 SSE 断线重连成功通知（可选：旧 preload 桥无此能力时
   * renderer 静默降级为不追平）。payload.subId 为重连成功的订阅 id。
   */
  onReconnect?(handler: (payload: { readonly subId: string }) => void): () => void;
}

/** G2 T2：应用内版本更新状态（主进程 auto-update.cjs 状态机，renderer 侧同名） */
type DesktopUpdateStatus = "idle" | "unsupported" | "checking" | "available" | "none" | "downloading" | "downloaded" | "error";

interface DesktopUpdateState {
  readonly status: DesktopUpdateStatus;
  readonly currentVersion: string;
  readonly newVersion: string | null;
  readonly progressPercent: number | null;
  readonly message: string | null;
  readonly checkedAt: string | null;
}

interface DesktopUpdateApi {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): void;
  onStateChanged(handler: (state: DesktopUpdateState) => void): () => void;
}

interface Window {
  readonly desktopShell?: DesktopShellApi;
  readonly desktopApi?: DesktopApi;
  readonly desktopUpdate?: DesktopUpdateApi;
}
