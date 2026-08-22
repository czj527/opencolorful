const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require("electron");
const path = require("node:path");

const { apiRequest, resolveBase } = require("./api-proxy.cjs");
const { SseProxyManager } = require("./sse-proxy.cjs");

const sseManager = new SseProxyManager(resolveBase);

let mainWindow = null;

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
ipcMain.handle("desktop:api", (_event, request) => apiRequest(request));
ipcMain.on("desktop:sse-sub", (event, payload) => {
  if (!payload || typeof payload.subId !== "string") return;
  sseManager.subscribe(event.sender, payload.subId, payload.path, payload.lastEventId);
});
ipcMain.on("desktop:sse-unsub", (_event, payload) => {
  if (payload && typeof payload.subId === "string") sseManager.unsubscribe(payload.subId);
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  sseManager.disposeAll();
  if (process.platform !== "darwin") app.quit();
});
