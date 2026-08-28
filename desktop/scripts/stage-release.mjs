/**
 * G2 T1：生成 electron-builder 的 staging 应用目录 desktop/release/app/。
 *
 * 布局：
 *   release/app/package.json     精简应用清单（type:module；版本取自 desktop/package.json；
 *                                dependencies 复刻根 package.json，供 electron-builder native rebuild）
 *   release/app/electron/*.cjs   主进程/代理/preload（main 为 .cjs 显式 CommonJS）
 *   release/app/server-dist/     根 npm run build 的后端 tsc 产物（ESM .js；
 *                                PI 扩展文件由 jiti 从 server-dist/pi-sdk/ 原样加载，与 CLI 生产模式一致）
 *   release/app/dist/            renderer 构建产物
 *   release/app/node_modules/    生产依赖 + 手工拷贝的 @opencolorful/plugin-protocol
 *                               （workspace 私包未发布，npm install 无法获取）
 *
 * 前置条件（由根 npm run desktop:pack 串起；workspace 包 dist 必须先于根 tsc 构建——
 * src/contracts/plugin-protocol.ts 的类型经 exports 指向 dist，干净环境顺序颠倒会 TS2307）：
 *   1. npm run build:protocol（plugin-protocol dist）
 *   2. npm run build:sdk（plugin-sdk/runtime/components dist）
 *   3. npm run build（后端 dist）
 *   4. npm run build --workspace=@opencolorful/desktop（renderer dist）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(desktopDir, "..");
const appDir = path.join(desktopDir, "release", "app");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runNpm(args, cwd) {
  // Windows 下 .cmd 不经 shell 无法 execFile（参考 scripts/dev.mjs 的 ComSpec 模式）
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args], { cwd, stdio: "inherit" })
    : spawnSync("npm", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} 失败（exit ${result.status ?? "unknown"}）`);
}

const desktopPkg = readJson(path.join(desktopDir, "package.json"));
const rootPkg = readJson(path.join(repoRoot, "package.json"));

const serverDist = path.join(repoRoot, "dist");
if (!fs.existsSync(path.join(serverDist, "server", "start.js"))) {
  throw new Error("后端未构建：请先运行 npm run build");
}
const rendererDist = path.join(desktopDir, "dist");
if (!fs.existsSync(path.join(rendererDist, "index.html"))) {
  throw new Error("renderer 未构建：请先运行 npm run build --workspace=@opencolorful/desktop");
}
const protocolPkgDir = path.join(repoRoot, "packages", "plugin-protocol");
if (!fs.existsSync(path.join(protocolPkgDir, "dist", "index.js"))) {
  throw new Error("plugin-protocol 未构建：请先运行 npm run build:protocol");
}

console.log(`[stage] 清理并重建 ${path.relative(desktopDir, appDir)}/（版本 ${desktopPkg.version}）`);
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(path.join(appDir, "electron"), { recursive: true });

// 1. 应用清单：electron-builder 的 app 元数据 + 生产依赖声明（native rebuild 依据）。
//    type:module 关键——server-dist 的 .js 是 ESM（根 package.json 语义在此延续）。
fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify({
  name: "opencolorful-desktop",
  version: desktopPkg.version,
  private: true,
  type: "module",
  description: "OpenColorful 桌面端（内嵌后端）",
  author: "czj527",
  main: "electron/main.cjs",
  // 生产依赖 = 根清单（内嵌后端）+ desktop 清单（桌面运行时依赖，如 electron-updater）
  dependencies: { ...rootPkg.dependencies, ...desktopPkg.dependencies },
}, null, 2)}\n`);

// 2. 主进程文件
for (const file of fs.readdirSync(path.join(desktopDir, "electron"))) {
  if (file.endsWith(".cjs")) {
    fs.copyFileSync(path.join(desktopDir, "electron", file), path.join(appDir, "electron", file));
  }
}

// 3. renderer 与后端产物
fs.cpSync(rendererDist, path.join(appDir, "dist"), { recursive: true });
fs.cpSync(serverDist, path.join(appDir, "server-dist"), { recursive: true });

// 4. 生产依赖（--omit=optional 跳过 ws 的可选原生加速包，避免无谓 rebuild；
//    --legacy-peer-deps 与根仓库一致：@hono/node-ws 对 node-server 的 peer 范围过时）
console.log("[stage] 安装生产依赖");
runNpm(["install", "--omit=dev", "--omit=optional", "--legacy-peer-deps", "--no-audit", "--no-fund", "--loglevel=error"], appDir);

// 5. workspace 插件协议包（必须在 npm install 之后拷贝，否则被 prune）
const protocolTarget = path.join(appDir, "node_modules", "@opencolorful", "plugin-protocol");
fs.mkdirSync(protocolTarget, { recursive: true });
fs.copyFileSync(path.join(protocolPkgDir, "package.json"), path.join(protocolTarget, "package.json"));
fs.cpSync(path.join(protocolPkgDir, "dist"), path.join(protocolTarget, "dist"), { recursive: true });

console.log("[stage] 完成");
