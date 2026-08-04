import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { assertSafeRelativeEntry, safeJoin } from "../paths.js";
import {
  SourceIntegrityError,
  SourceResolveError,
  assertPluginSourceRef,
  computeArtifactHash,
  manifestVersion,
  readManifestFile,
  type ArtifactVerification,
  type FetchedArtifact,
  type PluginSourceAdapter,
  type PluginSourceRef,
  type ResolvedSource,
  type SourceSearchResult,
  type SourceVersionInfo,
} from "./source-adapter.js";

// ═══════════════════════════════════════════════════════════════
// ZIP Source Adapter：本地 .zip 文件（含原生 manifest.json）。
//
// 解包安全（plans/phase-12.md §7.2 / §13）：
// - 拒绝绝对路径、盘符、UNC 与父目录穿越条目（ZIP Slip）；
// - 拒绝 Unix 符号链接条目（external attributes 的 S_IFLNK 位）；
// - 解包目标路径 canonical 后必须位于 staging 根内；
// - 解压总大小/单文件/条目数上限（防 zip bomb）。
// ═══════════════════════════════════════════════════════════════

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** 单包解压总上限 256MB（防 zip bomb）。 */
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
/** 单文件上限 64MB。 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 条目数上限 10,000。 */
const MAX_ENTRY_COUNT = 10_000;

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly externalAttributes: number;
}

function locateEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65_537);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new SourceIntegrityError("zip_eocd_missing", "ZIP 缺少中央目录结束标记");
}

function parseCentralDirectory(buffer: Buffer, eocdOffset: number): ZipEntry[] {
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new SourceIntegrityError("zip64_unsupported", "暂不支持 ZIP64 归档");
  }
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new SourceIntegrityError("zip_cd_corrupt", "ZIP 中央目录损坏");
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
      throw new SourceIntegrityError("zip64_unsupported", "暂不支持 ZIP64 归档");
    }
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, externalAttributes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZip(buffer: Buffer, entries: readonly ZipEntry[], destRoot: string): void {
  const root = path.resolve(destRoot);
  fs.mkdirSync(root, { recursive: true });
  let totalBytes = 0;
  for (const entry of entries) {
    assertSafeRelativeEntry(entry.name);
    // Unix 符号链接条目（S_IFLNK）直接拒绝
    if (((entry.externalAttributes >>> 16) & 0xf000) === 0xa000) {
      throw new SourceIntegrityError("zip_symlink_entry", "ZIP 包含符号链接条目，已拒绝");
    }
    if (entry.name.endsWith("/")) {
      fs.mkdirSync(safeJoin(root, entry.name), { recursive: true });
      continue;
    }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES || totalBytes + entry.uncompressedSize > MAX_EXTRACTED_BYTES) {
      throw new SourceIntegrityError("zip_too_large", "插件包解压后超过大小上限，已拒绝");
    }
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new SourceIntegrityError("zip_local_header_corrupt", "ZIP 本地文件头损坏");
    }
    const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let content: Buffer;
    if (entry.method === 0) {
      content = compressed;
    } else if (entry.method === 8) {
      try {
        content = zlib.inflateRawSync(compressed);
      } catch {
        throw new SourceIntegrityError("zip_inflate_failed", "ZIP 条目解压失败");
      }
    } else {
      throw new SourceIntegrityError("zip_method_unsupported", "ZIP 压缩方式不受支持");
    }
    if (content.length !== entry.uncompressedSize) {
      throw new SourceIntegrityError("zip_size_mismatch", "ZIP 条目解压大小不一致");
    }
    const destFile = safeJoin(root, entry.name);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, content);
    totalBytes += content.length;
  }
}

export class ZipSourceAdapter implements PluginSourceAdapter {
  readonly sourceType = "zip" as const;

  private requireZipFile(ref: string): string {
    const resolved = path.resolve(ref);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SourceResolveError("zip_missing", "ZIP 文件不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new SourceResolveError("zip_symlink", "ZIP 文件不允许是符号链接或 Junction");
    }
    if (!stat.isFile()) {
      throw new SourceResolveError("zip_not_file", "来源不是 ZIP 文件");
    }
    if (!resolved.toLowerCase().endsWith(".zip")) {
      throw new SourceResolveError("zip_extension", "来源不是 ZIP 文件");
    }
    return resolved;
  }

  search(): readonly SourceSearchResult[] {
    return [];
  }

  resolve(sourceRef: PluginSourceRef): ResolvedSource {
    const ref = assertPluginSourceRef(sourceRef);
    const zipPath = this.requireZipFile(ref.ref);
    return { sourceType: "zip", ref: zipPath, version: null, lock: null, metadata: {} };
  }

  listVersions(): readonly SourceVersionInfo[] {
    return [];
  }

  fetchArtifact(sourceRef: PluginSourceRef, options?: { readonly stagingDir?: string }): FetchedArtifact {
    const ref = assertPluginSourceRef(sourceRef);
    const zipPath = this.requireZipFile(ref.ref);
    const stagingDir = options?.stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "plugin-zip-"));
    const destRoot = safeJoin(stagingDir, "unpacked");
    const buffer = fs.readFileSync(zipPath);
    const eocdOffset = locateEndOfCentralDirectory(buffer);
    const entries = parseCentralDirectory(buffer, eocdOffset);
    if (entries.length === 0) {
      throw new SourceIntegrityError("zip_empty", "ZIP 包为空");
    }
    if (entries.length > MAX_ENTRY_COUNT) {
      throw new SourceIntegrityError("zip_too_many_entries", "ZIP 条目数超过上限，已拒绝");
    }
    try {
      extractZip(buffer, entries, destRoot);
    } catch (error) {
      if (error instanceof SourceIntegrityError) {
        throw error;
      }
      // PluginPathError（ZIP Slip/绝对路径/目录穿越）统一为来源完整性错误
      throw new SourceIntegrityError("zip_unsafe_entry", error instanceof Error ? error.message : "ZIP 条目不安全");
    }
    const raw = readManifestFile(destRoot);
    const version = manifestVersion(raw);
    if (version === null) {
      throw new SourceIntegrityError("manifest_version_missing", "插件 manifest 缺少 version");
    }
    if (ref.version !== undefined && ref.version !== version) {
      throw new SourceResolveError("version_mismatch", "请求版本与插件实际版本不一致");
    }
    return {
      sourceType: "zip",
      ref: zipPath,
      version,
      lock: null,
      contentRoot: destRoot,
      metadata: { manifest: raw, sourceFile: path.basename(zipPath) },
    };
  }

  verifyArtifact(artifact: FetchedArtifact): ArtifactVerification {
    return computeArtifactHash(artifact.contentRoot);
  }

  readProvenance(artifact: FetchedArtifact): unknown {
    return {
      sourceType: "zip",
      sourceFile: path.basename(artifact.ref),
      manifest: readManifestFile(artifact.contentRoot),
    };
  }
}
