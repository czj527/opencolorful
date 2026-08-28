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
 *   release/app/node_modules/    生产依赖（npm install 实装）。workspace 私包
 *                                @opencolorful/plugin-protocol / plugin-runtime 以
 *                                file: 依赖声明 + .npmrc install-links=true 让 npm
 *                                真实拷贝进 node_modules 并记入 lockfile——
 *                                electron-builder 的生产依赖收集器只认 lockfile 条目，
 *                                事后手工拷贝会被当作未声明包从 asar 剪掉（v0.1.0 事故）
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
const runtimePkgDir = path.join(repoRoot, "packages", "plugin-runtime");
if (!fs.existsSync(path.join(runtimePkgDir, "dist", "index.js"))) {
  throw new Error("plugin-runtime 未构建：请先运行 npm run build:sdk");
}

console.log(`[stage] 清理并重建 ${path.relative(desktopDir, appDir)}/（版本 ${desktopPkg.version}）`);
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(path.join(appDir, "electron"), { recursive: true });

// 1. 应用清单：electron-builder 的 app 元数据 + 生产依赖声明（native rebuild 依据）。
//    type:module 关键——server-dist 的 .js 是 ESM（根 package.json 语义在此延续）。
//    workspace 私包以 file: 相对路径声明（相对 release/app 指向仓库内 packages/），
//    配合下方 .npmrc install-links=true 实拷进 node_modules 并进入 lockfile。
fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify({
  name: "opencolorful-desktop",
  version: desktopPkg.version,
  private: true,
  type: "module",
  description: "OpenColorful 桌面端（内嵌后端）",
  author: "czj527",
  main: "electron/main.cjs",
  // 生产依赖 = 根清单（内嵌后端）+ desktop 清单（桌面运行时依赖，如 electron-updater）
  //           + workspace 插件包（server-dist 直接 import；未发布 registry，只能 file:）
  dependencies: {
    ...rootPkg.dependencies,
    ...desktopPkg.dependencies,
    "@opencolorful/plugin-protocol": "file:../../../packages/plugin-protocol",
    "@opencolorful/plugin-runtime": "file:../../../packages/plugin-runtime",
  },
}, null, 2)}\n`);

// file: 目录依赖默认软链——asar 内指向仓库路径会断；install-links=true 让 npm 把
// file: 依赖按 tarball 打包语义实拷进 node_modules（npm 语义与字面相反，已实测验证）
fs.writeFileSync(path.join(appDir, ".npmrc"), "install-links=true\n");

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

// 5. 关键依赖断言：workspace 插件包必须实装进 node_modules（package.json + dist/index.js）。
//    缺失说明 file:/install-links 链路失效——在打包阶段 fail-fast，
//    而不是把缺包的 asar 发给用户（v0.1.0 的 ERR_MODULE_NOT_FOUND 事故）。
for (const pkg of ["plugin-protocol", "plugin-runtime"]) {
  const target = path.join(appDir, "node_modules", "@opencolorful", pkg);
  for (const required of ["package.json", path.join("dist", "index.js")]) {
    if (!fs.existsSync(path.join(target, required))) {
      throw new Error(`staging 缺关键依赖：node_modules/@opencolorful/${pkg}/${required} 不存在`);
    }
  }
  const realPath = fs.lstatSync(target);
  if (realPath.isSymbolicLink()) {
    throw new Error(`staging 依赖不得为软链（asar 内会断）：node_modules/@opencolorful/${pkg}`);
  }
}

console.log("[stage] 完成");
