interface DesktopShellApi {
  readonly platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
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
}

interface Window {
  readonly desktopShell?: DesktopShellApi;
  readonly desktopApi?: DesktopApi;
}
