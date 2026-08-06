#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Phase 13 Skill 包质量门（plans/phase-13.md §19 / §15.3）
//
// 用法：
//   node scripts/verify-skill-package.mjs <skill-dir> [<skill-dir> ...]
//
// 独立 Node 校验（不依赖 typebox / 编译产物），供 Skill 作者发布前检查
// 包结构、frontmatter 与内容哈希是否对齐平台校验规则（validator.ts）：
// - SKILL.md 必须存在且为常规文件（非符号链接/Junction）；
// - frontmatter 必须含 name/description；version 参与内容哈希；
// - 遍历全部文件：拒绝符号链接、禁止扩展名（二进制）、未知文件类型、
//   单文件 256KB / 整包 32MB / 4096 文件上限（与 DEFAULT_SKILL_PACKAGE_LIMITS 一致）；
// - 内容哈希与 hash.ts 同规则：`sha256-` + 57 位十六进制，
//   相对路径（前向斜杠）+ 内容 + 可选 version，按路径排序；
// - 任何错误输出到 stderr 并以非零码退出（fail-closed）。
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const MAX_SINGLE_FILE_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 4096;
const HASH_HEX_LENGTH = 57;

const DENIED_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".node", ".jar", ".wasm", ".o", ".obj", ".class", ".app", ".msi", ".deb",
  ".rpm", ".apk", ".a", ".lib", ".pyc", ".pyd", ".whl", ".egg",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".yaml", ".yml", ".json", ".toml", ".csv", ".tsv",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".pdf",
  ".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts",
  ".hbs", ".mustache", ".liquid", ".jinja", ".jinja2", ".tmpl", ".ipynb",
]);

const errors = [];
function error(skillDir, message) {
  errors.push(`${skillDir}: ${message}`);
}

// ── frontmatter 轻量解析（完整标准化由平台 validator 负责）────────

function parseFrontmatter(source) {
  if (!source.startsWith("---")) return { ok: false, reason: "SKILL.md 必须以 --- 开头（YAML frontmatter）" };
  const end = source.indexOf("\n---", 3);
  if (end === -1) return { ok: false, reason: "frontmatter 缺少闭合 ---" };
  const block = source.slice(3, end);
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue; // 嵌套块（如 metadata）跳过，不要求此层完整解析
    const key = match[1];
    const value = match[2].trim();
    if (key === "name" || key === "description" || key === "version" || key === "license") {
      fields[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return { ok: true, fields };
}

// ── 安全遍历（拒绝符号链接；返回 rel/abs/size）───────────────────

function walk(root) {
  const entries = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (cause) {
      error(root, `无法读取路径 ${current}：${cause.message}`);
      return null;
    }
    if (stat.isSymbolicLink()) {
      error(root, `包内容包含符号链接或 Junction，已拒绝：${path.relative(root, current)}`);
      return null;
    }
    const rel = path.relative(root, current).replace(/\\/g, "/");
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      if (rel !== "") entries.push({ rel, abs: current, sizeBytes: stat.size });
    } else {
      error(root, `包内容包含非常规文件类型，已拒绝：${rel}`);
      return null;
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

// ── 内容哈希（与 hash.ts 同规则）────────────────────────────────

function computeContentHash(entries, version) {
  const hash = createHash("sha256");
  if (version !== undefined && version !== null && version !== "") {
    hash.update("version");
    hash.update("\0");
    hash.update(version);
    hash.update("\0");
  }
  for (const entry of entries) {
    const content = fs.readFileSync(entry.abs);
    hash.update(entry.rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  const hex = hash.digest("hex");
  return `sha256-${hex.slice(0, HASH_HEX_LENGTH)}`;
}

// ── 单目录校验 ─────────────────────────────────────────────────

function verifySkillDir(skillDir) {
  const root = path.resolve(skillDir);
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    error(root, "Skill 包根目录不存在");
    return;
  }
  if (rootStat.isSymbolicLink()) {
    error(root, "Skill 包根目录不允许是符号链接或 Junction");
    return;
  }
  if (!rootStat.isDirectory()) {
    error(root, "Skill 包根路径不是目录");
    return;
  }

  const manifestPath = path.join(root, "SKILL.md");
  let manifestStat;
  try {
    manifestStat = fs.lstatSync(manifestPath);
  } catch {
    error(root, "缺少 SKILL.md（不接受裸 skill_content 冒充完整 Skill）");
    return;
  }
  if (manifestStat.isSymbolicLink()) {
    error(root, "SKILL.md 不允许是符号链接或 Junction");
    return;
  }
  if (!manifestStat.isFile()) {
    error(root, "SKILL.md 不是常规文件");
    return;
  }
  if (manifestStat.size > MAX_SINGLE_FILE_BYTES) {
    error(root, `SKILL.md 超过单文件上限（${MAX_SINGLE_FILE_BYTES} 字节）`);
  }

  const source = fs.readFileSync(manifestPath, "utf8");
  const parsed = parseFrontmatter(source);
  if (!parsed.ok) {
    error(root, `SKILL.md frontmatter 非法：${parsed.reason}`);
    return;
  }
  if (typeof parsed.fields.name !== "string" || parsed.fields.name.trim() === "") {
    error(root, "frontmatter 缺少 name（1-128 字符）");
  }
  if (typeof parsed.fields.description !== "string" || parsed.fields.description.trim() === "") {
    error(root, "frontmatter 缺少 description");
  }
  const version = typeof parsed.fields.version === "string" && parsed.fields.version.trim() !== ""
    ? parsed.fields.version.trim()
    : undefined;
  if (version !== undefined && !/^\d+\.\d+\.\d+/.test(version)) {
    error(root, `version 建议为 SemVer 开头（收到 ${JSON.stringify(version)}）`);
  }

  const entries = walk(root);
  if (entries === null) return;

  let sizeBytes = 0;
  for (const entry of entries) {
    if (entry.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      error(root, `单文件超过上限（${MAX_SINGLE_FILE_BYTES} 字节）：${entry.rel}`);
    }
    const extension = path.extname(entry.rel).toLowerCase();
    if (extension !== "" && DENIED_EXTENSIONS.has(extension)) {
      error(root, `禁止的二进制/可执行文件类型：${entry.rel}（${extension}）`);
    } else if (extension !== "" && !ALLOWED_EXTENSIONS.has(extension)) {
      error(root, `非法文件类型：${entry.rel}（${extension}）`);
    }
    sizeBytes += entry.sizeBytes;
  }
  if (sizeBytes > MAX_PACKAGE_BYTES) {
    error(root, `整包超过总大小上限（${MAX_PACKAGE_BYTES} 字节）`);
  }
  if (entries.length > MAX_FILES) {
    error(root, `包内文件数超过上限（${MAX_FILES}）`);
  }

  if (errors.some((line) => line.startsWith(root))) return; // 已有错误不再输出哈希

  const contentHash = computeContentHash(entries, version);
  console.log(`${root}：通过`);
  console.log(`  name=${parsed.fields.name ?? "?"} version=${version ?? "0.0.0"}`);
  console.log(`  contentHash=${contentHash}`);
  console.log(`  sizeBytes=${sizeBytes} fileCount=${entries.length}`);
}

// ═══════════════════════════════════════════════════════════════

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("用法：node scripts/verify-skill-package.mjs <skill-dir> [<skill-dir> ...]");
    process.exit(2);
  }
  for (const target of targets) {
    verifySkillDir(target);
  }
  if (errors.length > 0) {
    for (const line of errors) {
      console.error(`✗ ${line}`);
    }
    console.error(`\nverify-skill-package: FAIL（${errors.length} 个问题）`);
    process.exit(1);
  }
  console.log("\nverify-skill-package: OK");
}

export { verifySkillDir, errors };
