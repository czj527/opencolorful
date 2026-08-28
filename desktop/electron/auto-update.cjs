// G2 T2：应用内版本更新状态机（electron-updater + GitHub provider）。
// - 仅 packaged 模式真实工作；dev/浏览器模式 status 固定 "unsupported"，IPC 仍注册。
// - 状态每次变化经 "update:state-changed" 推送给 renderer（状态形状见 desktop/src/env.d.ts）。
const { app, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const FIRST_CHECK_DELAY_MS = 10 * 1000; // 启动后 10 秒

let initialized = false;
let state = null;
let checkInFlight = false;
let windowFn = null;
let logFn = () => undefined;

// error 态 message：中文描述（err.message 截断 200 字符，不含堆栈/URL 查询参数）
function toErrorText(raw) {
  const text = raw instanceof Error ? raw.message : String(raw);
  // 去掉 URL 查询参数（GitHub API 错误常带签名/重试参数）；堆栈只在 err.stack，不在 message
  const cleaned = text
    .replace(/https?:\/\/[^\s?)"]*\?[^\s?)"]*/g, (match) => match.split("?")[0])
    .replace(/\s+/g, " ")
    .trim();
  const message = cleaned === "" ? "未知错误" : `更新失败：${cleaned}`;
  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}

// 状态变化合并并推送；窗口销毁/关闭期间发送失败不影响状态机（仅记日志）
function apply(patch) {
  state = { ...state, ...patch };
  try {
    windowFn()?.webContents?.send("update:state-changed", state);
  } catch (error) {
    logFn("error", `update state emit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function performCheck() {
  if (!app.isPackaged || checkInFlight) return;
  checkInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    apply({ status: "error", message: toErrorText(error), checkedAt: new Date().toISOString() });
    logFn("error", `update check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } finally {
    checkInFlight = false;
  }
}

function initAutoUpdater({ getWindow, log }) {
  if (initialized) return; // 幂等：重复调用不重复注册
  initialized = true;
  windowFn = getWindow ?? (() => null);
  logFn = log ?? (() => undefined);

  state = {
    status: app.isPackaged ? "idle" : "unsupported",
    currentVersion: app.getVersion(),
    newVersion: null,
    progressPercent: null,
    message: null,
    checkedAt: null,
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (message) => logFn("info", String(message)),
    warn: (message) => logFn("warn", String(message)),
    error: (message) => logFn("error", String(message)),
  };

  autoUpdater.on("checking-for-update", () => {
    apply({ status: "checking", newVersion: null, progressPercent: null, message: null });
  });
  autoUpdater.on("update-available", (info) => {
    apply({ status: "available", newVersion: info.version, progressPercent: null, message: null, checkedAt: new Date().toISOString() });
  });
  autoUpdater.on("update-not-available", () => {
    apply({ status: "none", newVersion: null, progressPercent: null, message: null, checkedAt: new Date().toISOString() });
  });
  autoUpdater.on("download-progress", (progress) => {
    apply({ status: "downloading", progressPercent: Math.round(progress.percent), message: null });
  });
  autoUpdater.on("update-downloaded", (info) => {
    apply({ status: "downloaded", newVersion: info.version, message: null });
  });
  autoUpdater.on("error", (error) => {
    apply({ status: "error", progressPercent: null, message: toErrorText(error) });
    logFn("error", `auto-updater error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });

  // IPC：手动检查触发 performCheck（内部有 packaged 与并发守卫），handle 统一返回当前 state
  ipcMain.handle("update:get-state", () => state);
  ipcMain.handle("update:check", async () => {
    await performCheck();
    return state;
  });
  ipcMain.handle("update:download", async () => {
    if (state.status !== "available") return state;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      apply({ status: "error", message: toErrorText(error) });
      logFn("error", `update download failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    return state;
  });
  ipcMain.on("update:install", () => {
    if (state.status !== "downloaded") return;
    autoUpdater.quitAndInstall(false, true);
  });

  if (app.isPackaged) {
    // 启动后 10 秒首次检查，之后每 4 小时一次
    setTimeout(() => { void performCheck(); }, FIRST_CHECK_DELAY_MS);
    setInterval(() => { void performCheck(); }, CHECK_INTERVAL_MS);
  }
}

module.exports = { initAutoUpdater };