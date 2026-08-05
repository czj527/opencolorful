import zlib from "node:zlib";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 测试用 ZIP fixture 生成器（自建字节流，不依赖任何归档库）
// ═══════════════════════════════════════════════════════════════

export interface ZipFixtureEntry {
  readonly name: string;
  readonly content: string | Buffer;
  /** 0=stored，8=deflate（缺省 8） */
  readonly method?: 0 | 8;
  /** Unix 外部属性（如 symlink 0o120000 << 16） */
  readonly externalAttributes?: number;
}

const CRC_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const index = (crc ^ byte) & 0xff;
    const tableValue = CRC_TABLE[index];
    crc = (tableValue ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 手工构造 ZIP 字节流：本地文件头 + 数据 + 中央目录 + EOCD。
 * 支持 store/deflate 与任意条目名（含 ../ 恶意路径、重复路径、符号链接属性）。
 */
export function buildZipFixture(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const method = entry.method ?? 8;
    const data = method === 0 ? raw : zlib.deflateRawSync(raw);
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const crc = crc32(raw);
    const externalAttributes = entry.externalAttributes ?? 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len
    localParts.push(localHeader, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += 30 + nameBuffer.length + data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(Buffer.concat(localParts).length, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

/** 便捷生成完整 Skill 包的 ZIP（含顶层目录或直接根布局）。 */
export function buildSkillZip(options: {
  readonly name?: string;
  readonly version?: string;
  readonly extraEntries?: readonly ZipFixtureEntry[];
  readonly topLevelDir?: string;
}): Buffer {
  const name = options.name ?? "test-skill";
  const version = options.version ?? "1.0.0";
  const skillContent =
    `---\nname: ${name}\ndescription: 测试 Skill\nversion: ${version}\n---\n这是 Skill 正文。\n`;
  const entries: ZipFixtureEntry[] = [
    {
      name: `${options.topLevelDir ?? ""}SKILL.md`,
      content: skillContent,
    },
    ...(options.extraEntries ?? []),
  ];
  return buildZipFixture(entries);
}
