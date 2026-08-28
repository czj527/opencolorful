#!/usr/bin/env node
/**
 * G2 T3：发布版本号同步。
 * desktop/package.json 是发布版本唯一来源（electron-builder 产物名 / app.getVersion() / tag 与之对应），
 * 根 package.json 与 package-lock.json 由本脚本一并同步。
 *
 * 用法：node scripts/bump-desktop-version.mjs 0.2.0
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = process.argv[2]?.trim();
if (version === undefined || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  throw new Error("用法：node scripts/bump-desktop-version.mjs <semver>（如 0.2.0 或 0.2.0-beta.1）");
}

for (const rel of ["desktop/package.json", "package.json"]) {
  const file = path.join(root, rel);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${rel} → ${version}`);
}

// 同步锁文件里的版本字段（npm ci 会校验锁与清单一致）
const lockResult = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", "install", "--package-lock-only", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" })
  : spawnSync("npm", ["install", "--package-lock-only", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
if (lockResult.error) throw lockResult.error;
if (lockResult.status !== 0) throw new Error("package-lock 同步失败");

console.log("\n下一步：");
console.log(`  1. 更新 CHANGELOG.md（Unreleased → [${version}]）`);
console.log("  2. 提交并经 PR 合并到 main");
console.log(`  3. git tag v${version} && git push origin v${version}（触发 .github/workflows/release.yml）`);
