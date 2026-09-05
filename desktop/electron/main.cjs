const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { apiRequest, resolveBase } = require("./api-proxy.cjs");
const { SseProxyManager } = require("./sse-proxy.cjs");
const { initAutoUpdater } = require("./auto-update.cjs");

const sseManager = new SseProxyManager(resolveBase);

// dev 下 app.getVersion() 返回 Electron 运行时版本而非应用版本（2026-09-01 A4 SET-05
// 真链发现：关于页显示 37.10.3）；显式对齐 desktop/package.json 的版本
if (!app.isPackaged) {
  try {
    app.setVersion(require(path.join(__dirname, "..", "package.json")).version);
  } catch {
    // 读取失败保持默认，关于页仍可用
  }
}

let mainWindow = null;
// G2 T1：packaged 模式下由主进程内嵌启动的 Agent Server（dev 模式恒为 null）
let embeddedServer = null;

// packaged 应用无可见控制台，shell 级事件落一份本地日志便于排障
function shellLog(level, message) {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "shell.log"), `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}

// A5 诊断关联：进程级失败签发短引用（ipc- + 8 位），随失败响应带给 renderer 的
// 用户可见错误，shell.log 同步落一行可检索记录（client-events 在主进程侧不可达
// 时本地引用的持久化兜底；引用只含 id，不含任何请求/响应载荷）
function newDiagRef() {
  return `ipc-${crypto.randomUUID().slice(0, 8)}`;
}

// G2 T1：packaged 且无显式外部后端时，进程内启动内嵌 Agent Server；
// 服务锁冲突/环境异常 → 降级为纯代理模式（与 dev 行为一致）
async function maybeStartEmbeddedServer() {
  if (!app.isPackaged || process.env.OPENCOLORFUL_SERVER_URL) return;
  try {
    // server-dist 是 ESM（staging app package.json type:module），CJS 主进程用动态 import 加载
    const serverDist = path.join(__dirname, "..", "server-dist");
    const importFrom = (rel) => import(pathToFileURL(path.join(serverDist, rel)).href);
    const [{ startForegroundServer }, { getRuntimePaths }, { loadEnvironment }] = await Promise.all([
      importFrom(path.join("server", "start.js")),
      importFrom(path.join("config", "paths.js")),
      importFrom(path.join("config", "environment.js")),
    ]);
    const environment = loadEnvironment();
    const startOptions = (port) => ({
      host: environment.host,
      port,
      paths: getRuntimePaths(),
      version: app.getVersion(),
    });
    try {
      embeddedServer = await startForegroundServer(startOptions(environment.port));
    } catch (error) {
      // 默认端口被无关进程占用（真实事故：QQ squatting 4310）→ 回退随机空闲端口。
      // startForegroundServer 把实际端口写入 server.json，代理也经下方
      // OPENCOLORFUL_SERVER_URL 直连实际端口，无需固定端口。
      if (error && typeof error === "object" && error.code === "EADDRINUSE") {
        shellLog("warn", `端口 ${environment.port} 被占用，回退随机端口启动内嵌后端`);
        embeddedServer = await startForegroundServer(startOptions(0));
      } else {
        throw error;
      }
    }
    // 让 api/sse 代理直连内嵌实例（自定义端口时默认探测 4311/4310 找不到它）；
    // 内嵌启动失败则不设置，代理维持既有探测/降级行为
    process.env.OPENCOLORFUL_SERVER_URL = `http://${embeddedServer.host}:${embeddedServer.port}`;
    shellLog("info", `embedded server online: http://${embeddedServer.host}:${embeddedServer.port}`);
  } catch (error) {
    embeddedServer = null;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    // A5：启动失败随弹窗给出诊断引用（shell.log 中可检索同一 id）
    const diagRef = newDiagRef();
    shellLog("error", `embedded server start failed [${diagRef}]: ${message}`);
    // packaged 下后端不可用 = 全功能不可用；明确告知而不是静默降级为
    // "每个操作都莫名其妙失败"（v0.1.0 事故：缺包 + 端口被占时用户无任何线索）
    dialog.showErrorBox(
      "OpenColorful 后端启动失败",
      `内嵌服务未能启动，应用功能不可用。\n\n${error instanceof Error ? error.message : String(error)}\n\n` +
      `诊断引用：${diagRef}\n` +
      `日志位置：${path.join(app.getPath("userData"), "logs", "shell.log")}`,
    );
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141619" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.DESKTOP_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("window:close", () => mainWindow?.close());

// 数据通道：API 代理 + SSE 订阅（renderer 沙箱，不直连网络）
// A5：失败的 API 请求签发诊断引用（diagRef 随响应带回 renderer 的错误对象，
// 同时落 shell.log 可检索）。health 巡检除外——离线期每 8s 一次会产生日志噪音。
ipcMain.handle("desktop:api", async (_event, request) => {
  const result = await apiRequest(request);
  const diagPath = typeof request?.path === "string" ? request.path : "";
  if (!result.ok && diagPath !== "/api/health") {
    result.diagRef = newDiagRef();
    shellLog("warn", `[${result.diagRef}] ${typeof request?.method === "string" ? request.method : "?"} ${diagPath} → ${result.status}`);
  }
  return result;
});

// 原生目录选择：T1 onboarding 需要用户指定助理工作目录；返回绝对路径或 null，不暴露完整 dialog 结果
ipcMain.handle("desktop:pick-directory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
ipcMain.on("desktop:sse-sub", (event, payload) => {
  if (!payload || typeof payload.subId !== "string") return;
  sseManager.subscribe(event.sender, payload.subId, payload.path, payload.lastEventId);
});
ipcMain.on("desktop:sse-unsub", (_event, payload) => {
  if (payload && typeof payload.subId === "string") sseManager.unsubscribe(payload.subId);
});

// packaged 下单实例：第二个实例聚焦已有窗口（双实例会争抢内嵌后端服务锁）
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 内嵌后端先行（含 DB 迁移）；失败也继续开窗——UI 呈现"未连接"可重试态
    await maybeStartEmbeddedServer();
    createWindow();
    initAutoUpdater({ getWindow: () => mainWindow, log: shellLog });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    sseManager.disposeAll();
    if (process.platform !== "darwin") app.quit();
  });

  // 优雅停止内嵌后端（日志落盘/释放服务锁）后再真正退出
  app.on("will-quit", (event) => {
    if (embeddedServer === null) return;
    event.preventDefault();
    const server = embeddedServer;
    embeddedServer = null;
    server.stop()
      .catch((error) => shellLog("error", `embedded server stop failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => app.quit());
  });
}
