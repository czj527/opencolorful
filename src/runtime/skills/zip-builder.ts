import fs from "node:fs";
import path from "node:path";

import { SkillError } from "./errors.js";
import { walkSafeFiles } from "./path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 ZIP 打包器（plans/phase-13.md §7.3 / §15.1 `skills pack`）
//
// - 生成可分发的 .skill 包（ZIP，store 方法不压缩，确定性：路径排序固定）；
// - 二进制布局与 zip-extract.ts 解析器严格一致（2 字节字段不能按 4 字节
//   对齐写入，否则 EOCD/中央目录错位导致归档被判定为空）；
// - 只读安全遍历（walkSafeFiles）：符号链接/Junction/非常规文件直接拒绝；
// - 文件名为前向斜杠相对路径，不做任何绝对路径或 `..` 归一化（遍历保证安全）；
// - 只打包常规文件，目录以隐式条目存在；无外部依赖（不调系统 zip）。
// ═══════════════════════════════════════════════════════════════

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;

const LOCAL_HEADER_BASE = 30; // 签名(4) 版本(2) 标志(2) 方法(2) 时间(2) 日期(2) crc(4) 压缩大小(4) 解压大小(4) 名字长(2) 额外长(2)
const CENTRAL_ENTRY_BASE = 46; // 签名(4) 版本(4) 标志(2) 方法(2) 时间(2) 日期(2) crc(4) 压缩大小(4) 解压大小(4) 名字长(2) 额外长(2) 注释长(2) 磁盘(2) 内部属性(2) 外部属性(4) 偏移(4)

interface ZipEntryData {
  readonly rel: string;
  readonly content: Buffer;
  readonly crc32: number;
  readonly sizeBytes: number;
}

export interface BuildSkillZipOptions {
  /** 排除的相对路径（前向斜杠；缺省排除 .git） */
  readonly exclude?: readonly string[];
}

export interface BuildSkillZipResult {
  readonly buffer: Buffer;
  readonly fileCount: number;
  readonly sizeBytes: number;
}

/** 目录 → 确定性 ZIP（.skill 包）Buffer。 */
export function buildSkillZip(packageRoot: string, options: BuildSkillZipOptions = {}): BuildSkillZipResult {
  const exclude = options.exclude ?? [".git"];
  const entries = walkSafeFiles(packageRoot, { exclude });
  const data: ZipEntryData[] = entries.map((entry) => {
    const content = fs.readFileSync(entry.abs);
    return {
      rel: entry.rel,
      content,
      crc32: crc32(content),
      sizeBytes: content.length,
    };
  });
  return assembleZip(data);
}

/** 生成 ZIP Buffer（local headers + central directory + EOCD）。 */
export function assembleZip(entries: readonly ZipEntryData[]): BuildSkillZipResult {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.rel, "utf8");
    // local file header（30 字节固定 + 名字）
    const localHeader = Buffer.alloc(LOCAL_HEADER_BASE + name.length);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(STORE_METHOD, 8);
    localHeader.writeUInt16LE(0, 10); // 修改时间
    localHeader.writeUInt16LE(0, 12); // 修改日期
    localHeader.writeUInt32LE(entry.crc32, 14);
    localHeader.writeUInt32LE(entry.sizeBytes, 18); // 压缩后大小（store = 原大小）
    localHeader.writeUInt32LE(entry.sizeBytes, 22); // 解压后大小
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28); // 额外字段长度
    name.copy(localHeader, LOCAL_HEADER_BASE);
    localParts.push(localHeader);
    localParts.push(entry.content);

    // central directory entry（46 字节固定 + 名字）
    const centralEntry = Buffer.alloc(CENTRAL_ENTRY_BASE + name.length);
    centralEntry.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralEntry.writeUInt16LE(VERSION_NEEDED, 4); // 制作版本
    centralEntry.writeUInt16LE(VERSION_NEEDED, 6); // 需要版本
    centralEntry.writeUInt16LE(UTF8_FLAG, 8);
    centralEntry.writeUInt16LE(STORE_METHOD, 10);
    centralEntry.writeUInt16LE(0, 12); // 修改时间
    centralEntry.writeUInt16LE(0, 14); // 修改日期
    centralEntry.writeUInt32LE(entry.crc32, 16);
    centralEntry.writeUInt32LE(entry.sizeBytes, 20); // 压缩后大小
    centralEntry.writeUInt32LE(entry.sizeBytes, 24); // 解压后大小
    centralEntry.writeUInt16LE(name.length, 28);
    centralEntry.writeUInt16LE(0, 30); // 额外字段长度
    centralEntry.writeUInt16LE(0, 32); // 注释长度
    centralEntry.writeUInt16LE(0, 34); // 起始磁盘
    centralEntry.writeUInt16LE(0, 36); // 内部属性
    centralEntry.writeUInt32LE(0, 38); // 外部属性（0 = 非常规可执行/符号链接）
    centralEntry.writeUInt32LE(offset, 42); // 本地文件头偏移
    name.copy(centralEntry, CENTRAL_ENTRY_BASE);
    centralParts.push(centralEntry);

    offset += LOCAL_HEADER_BASE + name.length + entry.sizeBytes;
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralDirectoryOffset = localParts.reduce((sum, part) => sum + part.length, 0);
  const count = entries.length;

  // EOCD（22 字节）
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // 当前磁盘
  eocd.writeUInt16LE(0, 6); // 中央目录所在磁盘
  eocd.writeUInt16LE(count, 8); // 当前磁盘条目数
  eocd.writeUInt16LE(count, 10); // 总条目数
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  const buffer = Buffer.concat([...localParts, ...centralParts, eocd]);
  const sizeBytes = buffer.length;
  return { buffer, fileCount: count, sizeBytes };
}

// ── CRC32（表驱动；store 方法必需）─────────────────────────────

const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(content: Buffer | Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 便捷：构建后直接写文件（CLI 用）。 */
export function writeSkillZipFile(packageRoot: string, targetZipPath: string, options: BuildSkillZipOptions = {}): BuildSkillZipResult {
  const built = buildSkillZip(packageRoot, options);
  fs.mkdirSync(path.dirname(path.resolve(targetZipPath)), { recursive: true });
  fs.writeFileSync(targetZipPath, built.buffer);
  return built;
}

/** 校验目标输出路径安全（拒绝目录/非法扩展名）。 */
export function assertSkillZipTarget(targetZipPath: string): void {
  const lower = targetZipPath.toLowerCase();
  if (!lower.endsWith(".zip") && !lower.endsWith(".skill")) {
    throw new SkillError("skill_package_invalid", `打包输出必须是 .zip 或 .skill 文件（收到：${targetZipPath}）`);
  }
  const stat = fs.lstatSync(path.dirname(path.resolve(targetZipPath)), { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isDirectory()) {
    throw new SkillError("skill_package_invalid", `打包输出目录不存在：${path.dirname(path.resolve(targetZipPath))}`);
  }
}
