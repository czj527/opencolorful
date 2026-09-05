/**
 * L6 真链冒烟 · Electron 应用启动器。
 *
 * 启动方式与仓库既有 dev 入口一致（desktop/package.json `start`：`electron electron/main.cjs`），
 * 非 packaged 模式 → main.cjs 加载 dist/index.html（渲染层需先 `npm run build --workspace=@opencolorful/desktop`）；
 * 后端经 OPENCOLORFUL_SERVER_URL 显式指向 fixture 启动的真实 Agent Server（main.cjs 的既有契约，
 * 与 packaged 内嵌模式互斥，见 desktop/electron/main.cjs maybeStartEmbeddedServer）。
 *
 * 隔离：每个用例独立 --user-data-dir 与 OPENCOLORFUL_HOME，主进程/渲染进程不得触碰真实用户目录。
 */
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";

import { DESKTOP_DIR, REPO_ROOT, stripCredentialEnv } from "./backend.js";

const require = createRequire(import.meta.url);

export interface LaunchAppOptions {
  readonly serverUrl: string;
  readonly homeDir: string;
  readonly userDataDir: string;
}

export async function launchApp(options: LaunchAppOptions): Promise<ElectronApplication> {
  // electron npm 包在纯 Node 环境导出可执行文件路径（root node_modules，npm workspaces 提升）
  const electronExecutable = require(path.join(REPO_ROOT, "node_modules", "electron")) as string;

  // CI（Linux runner）下 chromium 沙箱不可用，与常见 Electron CI 实践一致追加 --no-sandbox
  const extraArgs = process.env.CI ? ["--no-sandbox"] : [];

  return await _electron.launch({
    executablePath: electronExecutable,
    cwd: DESKTOP_DIR,
    args: [
      "electron/main.cjs",
      `--user-data-dir=${options.userDataDir}`,
      ...extraArgs,
    ],
    env: {
      ...stripCredentialEnv(process.env),
      OPENCOLORFUL_HOME: options.homeDir,
      OPENCOLORFUL_SERVER_URL: options.serverUrl,
    },
  });
}

/** 首个窗口（ready-to-show 后才 show；Playwright 追踪创建即返回） */
export async function firstWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return window;
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close();
}
