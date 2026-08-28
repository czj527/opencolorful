/**
 * G2 热修（v0.1.0 事故回归门）：打包产物完整性断言。
 *
 * 教训：electron-builder 的生产依赖收集器只认 staging lockfile 条目；
 * win-unpacked 在仓库树内运行时，缺失的 asar 包会静默解析到仓库自身
 * node_modules（假阳性）。本脚本直接检查 asar 内容，在 CI 打包后 fail-fast。
 *
 * 用法：npm run verify:pack --workspace=@opencolorful/desktop
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bundlesDir = path.join(desktopDir, "release", "bundles");
const resourcesDir = path.join(bundlesDir, "win-unpacked", "resources");

const require = createRequire(path.join(desktopDir, "package.json"));
let asar;
try {
  asar = require("@electron/asar");
} catch {
  try {
    asar = require("asar");
  } catch {
    throw new Error("找不到 asar 工具包（应为 electron-builder 的传递依赖）");
  }
}

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

// ── 1. asar 内容 ──
const asarPath = path.join(resourcesDir, "app.asar");
check(fs.existsSync(asarPath), "app.asar 存在");
if (fs.existsSync(asarPath)) {
  const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, "/"));
  const required = [
    "electron/main.cjs",
    "dist/index.html",
    "server-dist/server/start.js",
    "server-dist/contracts/plugin-protocol.js",
    "node_modules/@opencolorful/plugin-protocol/package.json",
    "node_modules/@opencolorful/plugin-protocol/dist/index.js",
    "node_modules/@opencolorful/plugin-runtime/package.json",
    "node_modules/@opencolorful/plugin-runtime/dist/index.js",
    "node_modules/electron-updater/package.json",
    "node_modules/better-sqlite3/package.json",
  ];
  for (const entry of required) {
    check(
      entries.some((e) => e === `/${entry}` || e === entry),
      `asar 包含 ${entry}`,
    );
  }
}

// ── 2. 原生模块（asarUnpack 后必须在 asar 外真实存在，且是 Electron ABI 产物） ──
const nativeModule = path.join(
  resourcesDir,
  "app.asar.unpacked",
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
check(fs.existsSync(nativeModule), "better_sqlite3.node 已 unpack 到 app.asar.unpacked（Electron ABI）");

// ── 3. 发布产物（更新 feed 依赖 latest.yml）──
check(fs.existsSync(path.join(bundlesDir, "latest.yml")), "latest.yml 存在（electron-updater feed）");
check(
  fs.readdirSync(bundlesDir).some((file) => file.endsWith(".exe") && !file.includes("__uninstaller")),
  "NSIS 安装器存在",
);

if (failures.length > 0) {
  console.error(`\n[verify-pack] 失败：${failures.length} 项断言未通过`);
  process.exit(1);
}
console.log("\n[verify-pack] 通过");
