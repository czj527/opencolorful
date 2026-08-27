/**
 * 调用 Electron 原生目录选择对话框。
 *
 * 在 desktop 包装下通过 preload 暴露的 desktopShell.pickDirectory 发起 IPC；
 * 在纯浏览器 / dev 环境中不存在该能力，返回 null，调用方应回退到手动输入路径。
 */
export async function pickDirectory(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  return window.desktopShell?.pickDirectory() ?? null;
}
