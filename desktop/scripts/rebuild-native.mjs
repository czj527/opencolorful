/**
 * G2 T1：把 staging（release/app）里的 better-sqlite3 定向 rebuild 到 Electron ABI。
 *
 * 为什么不由 electron-builder 的 npmRebuild 做：它识别出 npm workspace root 后会重建
 * 根 node_modules 里的提升副本，把 vitest 用的 Node ABI 打坏（实测 ERR_DLOPEN_FAILED）。
 * 因此 electron-builder.yml 里 npmRebuild:false，由本脚本显式只处理 staging。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rebuild } from "@electron/rebuild";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const appDir = path.join(desktopDir, "release", "app");
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;

console.log(`[rebuild] better-sqlite3 → Electron ${electronVersion} ABI（仅 staging）`);
await rebuild({
  buildPath: appDir,
  electronVersion,
  arch: "x64",
  onlyModules: ["better-sqlite3"],
  force: true,
});
console.log("[rebuild] 完成");
