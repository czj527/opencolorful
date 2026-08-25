import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * 原生文件夹选择结果。
 * - path: 用户选择的绝对路径；取消时为 null
 * - cancelled: 用户取消选择
 */
export interface PickDirectoryResult {
  readonly path: string | null;
  readonly cancelled: boolean;
}

/**
 * 平台文件夹选择器抽象。Windows 调原生 FolderBrowserDialog，
 * macOS/Linux 本阶段返回不支持（前端回退手工输入）。
 *
 * 实现符合 server-first 架构，不引入 Electron。
 */
export interface FolderPicker {
  pickDirectory(): Promise<PickDirectoryResult>;
}

/**
 * Windows 原生文件夹选择。通过 PowerShell 调用
 * System.Windows.Forms.FolderBrowserDialog，在用户桌面会话中显示。
 * -STA 确保单线程公寓（GUI 弹窗要求）。
 */
const WINDOWS_PICK_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$fb = New-Object System.Windows.Forms.FolderBrowserDialog
$fb.Description = '选择工作目录'
$fb.ShowNewFolderButton = $true
$result = $fb.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $fb.SelectedPath
} else {
  Write-Output ''
}
`.trim();

/**
 * spawn 函数的宽松类型，便于测试注入 fake。
 * 真实用 child_process.spawn（通过 cast 适配）。
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: unknown,
) => ChildProcess;

export class WindowsFolderPicker implements FolderPicker {
  // spawnFn 可注入便于测试 mock；默认用真实 child_process.spawn
  constructor(private readonly spawnFn: SpawnFn = spawn as unknown as SpawnFn) {}

  async pickDirectory(): Promise<PickDirectoryResult> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_PICK_SCRIPT],
        { windowsHide: false },
      );

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (data: Buffer | string) => {
        stdout += typeof data === "string" ? data : data.toString("utf8");
      });
      proc.stderr?.on("data", (data: Buffer | string) => {
        stderr += typeof data === "string" ? data : data.toString("utf8");
      });

      proc.on("error", (err) => {
        reject(new Error(`PowerShell 启动失败: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`PowerShell 退出码 ${code}: ${stderr.trim() || "无错误输出"}`),
          );
        }
        // PowerShell 输出可能含 BOM 或换行，trim 处理
        const trimmed = stdout.trim();
        if (!trimmed) {
          return resolve({ path: null, cancelled: true });
        }
        // 路径校验：必须是绝对路径、不允许 ..
        // 输出一定来自 Windows PowerShell，用 win32 语义判定，
        // 与宿主平台无关（否则 Linux CI 上 C:\ 会被误判为非绝对路径）。
        if (!path.win32.isAbsolute(trimmed)) {
          return reject(new Error(`返回非绝对路径: ${trimmed}`));
        }
        if (trimmed.includes("..")) {
          return reject(new Error(`路径不允许包含 ..: ${trimmed}`));
        }
        resolve({ path: trimmed, cancelled: false });
      });
    });
  }
}

/**
 * macOS/Linux 不支持原生目录选择（本阶段不要求实现）。
 * 调用时抛错，前端回退手工输入。
 */
export class UnsupportedFolderPicker implements FolderPicker {
  constructor(private readonly platform: string) {}

  async pickDirectory(): Promise<PickDirectoryResult> {
    throw new Error(
      `平台 ${this.platform} 暂不支持原生目录选择，请手工输入路径`,
    );
  }
}

/**
 * 根据当前进程平台创建合适的 FolderPicker。
 */
export function createFolderPicker(): FolderPicker {
  const platform = process.platform;
  if (platform === "win32") {
    return new WindowsFolderPicker();
  }
  return new UnsupportedFolderPicker(platform);
}
