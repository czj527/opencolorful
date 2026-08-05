import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import type { SkillPackageLimits } from "../validator.js";
import { SkillError } from "../errors.js";
import { assertSafeRelativeEntry, safeJoin } from "../path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 ZIP 解包（plans/phase-13.md §7.3 / §12.2）
//
// - 解包只接受完整 package：ZIP/.skill；条目一律先过 assertSafeRelativeEntry
//   （ZIP Slip 第一道防线，reasonCode=skill_zip_slip）；
// - 拒绝重复路径 / 父路径冲突（skill_duplicate_path）、Unix 符号链接条目、
//   单文件/总大小/条目数超限（skill_too_large，上限取 DEFAULT_SKILL_PACKAGE_LIMITS）、
//   禁止与未知文件类型（skill_binary_denied / skill_file_type_denied）；
// - 所有失败 fail-closed 抛 SkillError（稳定 reasonCode），由调用方转 SkillSourceError；
// - 本模块不执行归档内任何内容。
// ═══════════════════════════════════════════════════════════════

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UNIX_SYMLINK_FILE_TYPE = 0xa000;

export interface ZipEntryInfo {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly externalAttributes: number;
}

/** 在缓冲区内定位 EOCD（只扫描尾部 64KB+22 字节）。 */
export function locateEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65_537);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new SkillError("skill_package_invalid", "ZIP 缺少中央目录结束标记");
}

/** 解析中央目录条目（不支持 ZIP64，ZIP64 显式拒绝）。 */
export function parseCentralDirectory(buffer: Buffer, eocdOffset: number): readonly ZipEntryInfo[] {
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new SkillError("skill_package_invalid", "暂不支持 ZIP64 归档");
  }
  const entries: ZipEntryInfo[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new SkillError("skill_package_invalid", "ZIP 中央目录损坏");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new SkillError("skill_package_invalid", "暂不支持 ZIP64 归档");
    }
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, externalAttributes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * 解包到 destRoot（受控 staging）。按 DEFAULT_SKILL_PACKAGE_LIMITS 与
 * 文件类型白名单/黑名单（与 validator 一致）fail-closed 拒绝。
 */
export function extractSkillZip(
  buffer: Buffer,
  entries: readonly ZipEntryInfo[],
  destRoot: string,
  limits: SkillPackageLimits,
): { readonly fileCount: number; readonly totalBytes: number } {
  const root = path.resolve(destRoot);
  fs.mkdirSync(root, { recursive: true });

  if (entries.length > limits.maxFiles) {
    throw new SkillError("skill_too_large", `包内文件数超过上限（${limits.maxFiles}）`);
  }

  // 先做整目录结构检查：ZIP Slip、重复路径、父路径冲突、文件类型、大小预算。
  const fileEntries: Array<{ readonly name: string; readonly method: number; readonly compressedSize: number; readonly uncompressedSize: number; readonly localHeaderOffset: number }> = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    assertSafeRelativeEntry(entry.name, "skill_zip_slip");
    if (((entry.externalAttributes >>> 16) & 0xf000) === UNIX_SYMLINK_FILE_TYPE) {
      throw new SkillError("skill_symlink_escape", "ZIP 包含符号链接条目，已拒绝");
    }
    const normalized = entry.name.replace(/\\/g, "/");
    if (seen.has(normalized)) {
      throw new SkillError("skill_duplicate_path", `归档条目重复：${normalized}`);
    }
    seen.add(normalized);
    if (normalized.endsWith("/")) {
      continue;
    }
    const extension = path.extname(normalized).toLowerCase();
    if (extension !== "" && DENIED.has(extension)) {
      throw new SkillError("skill_binary_denied", `禁止的二进制/可执行文件类型：${extension}`, normalized);
    }
    if (extension !== "" && !limits.allowedExtensions.includes(extension)) {
      throw new SkillError("skill_file_type_denied", `非法文件类型：${extension}`, normalized);
    }
    if (entry.uncompressedSize > limits.maxFileBytes) {
      throw new SkillError("skill_too_large", `单文件超过上限（${limits.maxFileBytes} 字节）`, normalized);
    }
    if (totalBytes + entry.uncompressedSize > limits.maxPackageBytes) {
      throw new SkillError("skill_too_large", `整包超过总大小上限（${limits.maxPackageBytes} 字节）`);
    }
    totalBytes += entry.uncompressedSize;
    fileEntries.push({ name: entry.name, method: entry.method, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, localHeaderOffset: entry.localHeaderOffset });
  }
  assertNoPathConflicts(fileEntries.map((entry) => entry.name.replace(/\\/g, "/")));

  // 写盘阶段：逐条目解压写入（写入失败统一 fail-closed）。
  for (const entry of fileEntries) {
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new SkillError("skill_package_invalid", "ZIP 本地文件头损坏");
    }
    const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataStart + entry.compressedSize > buffer.length) {
      throw new SkillError("skill_package_invalid", "ZIP 条目数据越界");
    }
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let content: Buffer;
    if (entry.method === 0) {
      content = compressed;
    } else if (entry.method === 8) {
      try {
        content = zlib.inflateRawSync(compressed);
      } catch {
        throw new SkillError("skill_package_invalid", "ZIP 条目解压失败");
      }
    } else {
      throw new SkillError("skill_package_invalid", "ZIP 压缩方式不受支持");
    }
    if (content.length !== entry.uncompressedSize) {
      throw new SkillError("skill_package_invalid", "ZIP 条目解压大小不一致");
    }
    const destFile = safeJoin(root, entry.name);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, content);
  }
  return { fileCount: fileEntries.length, totalBytes };
}

const DENIED = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".node", ".jar", ".wasm", ".o", ".obj", ".class", ".app", ".msi", ".deb",
  ".rpm", ".apk", ".a", ".lib", ".pyc", ".pyd", ".whl", ".egg",
]);

/** 重复路径与父路径冲突检查（"a" 是文件时不允许再出现 "a/b"）。 */
function assertNoPathConflicts(files: readonly string[]): void {
  const seenFiles = new Set<string>();
  for (const rel of files) {
    if (seenFiles.has(rel)) {
      throw new SkillError("skill_duplicate_path", `归档条目重复：${rel}`);
    }
    seenFiles.add(rel);
    let parent = rel;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (seenFiles.has(parent)) {
        throw new SkillError("skill_duplicate_path", `归档路径冲突（父路径也是文件）：${rel}`);
      }
    }
  }
}
