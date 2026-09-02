/**
 * A4a lane 本地 fixture：ONB-05 原生目录对话框桩。
 *
 * Playwright 无法驱动 OS 原生目录选择框；真链链路保持完整（渲染层 click →
 * preload desktopShell.pickDirectory → IPC desktop:pick-directory → main 进程
 * dialog.showOpenDialog），仅在 main 进程内把 dialog.showOpenDialog 替换为
 * 固定返回值（选择/取消两种），与 main.cjs 的既有 handler 同对象（require("electron")）。
 * 这是 OS 对话框自动化不可达部分的最小替代，不改变应用侧任何代码路径。
 */
import type { ElectronApplication } from "@playwright/test";

export interface OpenDialogStubResult {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export async function stubPickDialog(
  app: ElectronApplication,
  result: OpenDialogStubResult,
): Promise<void> {
  await app.evaluate((electron, stubResult) => {
    const dialog = (electron as { dialog: { showOpenDialog: unknown } }).dialog;
    (dialog as { showOpenDialog: (window: unknown, options: unknown) => Promise<unknown> }).showOpenDialog =
      async () => stubResult;
  }, { canceled: result.canceled, filePaths: [...result.filePaths] });
}
