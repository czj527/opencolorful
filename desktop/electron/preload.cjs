const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopShell", {
  platform: process.platform,
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  pickDirectory: () => ipcRenderer.invoke("desktop:pick-directory"),
});

// 数据桥：通用 API 代理 + SSE 订阅。主进程限制 path 必须以 /api/ 开头。
contextBridge.exposeInMainWorld("desktopApi", {
  invoke: (method, path, body) => ipcRenderer.invoke("desktop:api", { method, path, body }),
  subscribeEvents: (path, lastEventId) => {
    const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    ipcRenderer.send("desktop:sse-sub", { subId, path, lastEventId: lastEventId ?? null });
    return subId;
  },
  unsubscribeEvents: (subId) => ipcRenderer.send("desktop:sse-unsub", { subId }),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("desktop:sse-event", listener);
    return () => {
      ipcRenderer.removeListener("desktop:sse-event", listener);
    };
  },
});

// 更新桥：应用内版本更新（electron-updater 状态机，仅 packaged 真实工作）
contextBridge.exposeInMainWorld("desktopUpdate", {
  getState: () => ipcRenderer.invoke("update:get-state"),
  check: () => ipcRenderer.invoke("update:check"),
  download: () => ipcRenderer.invoke("update:download"),
  install: () => ipcRenderer.send("update:install"),
  onStateChanged: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("update:state-changed", listener);
    return () => {
      ipcRenderer.removeListener("update:state-changed", listener);
    };
  },
});
