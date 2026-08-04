import fs from "node:fs";
import path from "node:path";

import { instrument } from "../../../observability/instrument.js";
import type { PluginSecretStore } from "./secret-contribution.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Secret 持久化 Store（plans/phase-12.md §8.7，T9）
//
// - 与 InMemorySecretStore 接口完全一致（pluginId + secretName 二维，
//   明文值），SecretService 无感知切换；
// - 文件格式见 FileSecretsDocument：`auth/plugin-secrets.json`
//   （paths.pluginSecrets），版本化便于后续迁移；
// - 变更后立即落盘；写入用临时文件 + renameSync 原子替换，避免半写
//   文件被进程重启后当作合法数据读取；
// - 缺失/损坏按空状态处理；损坏时先备份 `.bak` 再按空处理，并走
//   instrument.warn 记录（文件路径可入日志，Secret 值绝不入日志）；
// - 文件权限 best-effort 收紧到 0o600（明文 Secret 文件仅限当前用户
//   读写）；Windows 不支持完整权限位，chmod 失败忽略。
// ═══════════════════════════════════════════════════════════════

export interface FileSecretStoreOptions {
  readonly filePath: string;
}

/** 单个 Secret 的记录：值 + 最后更新时间（供审计/排查引用，不参与接口语义）。 */
interface FileSecretRecord {
  readonly value: string;
  readonly updatedAt?: string;
}

/**
 * 磁盘格式：
 * {
 *   "version": 1,
 *   "secrets": {
 *     "<pluginId>": {
 *       "<secretName>": { "value": "...", "updatedAt": "..." }
 *     }
 *   }
 * }
 */
interface FileSecretsDocument {
  readonly version: 1;
  readonly secrets: Record<string, Record<string, FileSecretRecord>>;
}

const EMPTY_DOCUMENT: FileSecretsDocument = { version: 1, secrets: {} };

/**
 * 持久化 Secret Store：读时懒加载并缓存到内存，每次变更（set/remove）
 * 立即原子写回 `auth/plugin-secrets.json`。
 */
export class FileSecretStore implements PluginSecretStore {
  private readonly filePath: string;
  /** 与 InMemorySecretStore 相同的键约定：`${pluginId}\u0000${secretName}` */
  private readonly values = new Map<string, string>();
  private readonly updatedAt = new Map<string, string>();
  private loaded = false;

  constructor(options: FileSecretStoreOptions) {
    this.filePath = options.filePath;
  }

  get(pluginId: string, secretName: string): string | undefined {
    this.ensureLoaded();
    return this.values.get(this.key(pluginId, secretName));
  }

  set(pluginId: string, secretName: string, value: string): void {
    this.ensureLoaded();
    const key = this.key(pluginId, secretName);
    this.values.set(key, value);
    this.updatedAt.set(key, new Date().toISOString());
    this.persist();
  }

  has(pluginId: string, secretName: string): boolean {
    this.ensureLoaded();
    return this.values.has(this.key(pluginId, secretName));
  }

  listNames(pluginId: string): string[] {
    this.ensureLoaded();
    const prefix = `${pluginId}\u0000`;
    const names: string[] = [];
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) {
        names.push(key.slice(prefix.length));
      }
    }
    return names.sort();
  }

  remove(pluginId: string, secretName: string): void {
    this.ensureLoaded();
    const key = this.key(pluginId, secretName);
    if (!this.values.delete(key)) {
      return;
    }
    this.updatedAt.delete(key);
    this.persist();
  }

  // ── private helpers ───────────────────────────────────────────

  private key(pluginId: string, secretName: string): string {
    return `${pluginId}\u0000${secretName}`;
  }

  /** 首访问时读取磁盘文件；缺失/损坏一律按空状态处理，绝不抛致命错误。 */
  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      this.backupCorruptFile();
      return;
    }
    if (parsed === null || typeof parsed !== "object") {
      this.backupCorruptFile();
      return;
    }
    const document = parsed as Partial<FileSecretsDocument>;
    if (document.version !== 1 || document.secrets === null || typeof document.secrets !== "object") {
      this.backupCorruptFile();
      return;
    }
    // 逐条防御性校验：单条记录格式异常只跳过该条，不丢弃其余合法数据
    for (const [pluginId, secretMap] of Object.entries(document.secrets)) {
      if (secretMap === null || typeof secretMap !== "object") {
        continue;
      }
      for (const [secretName, record] of Object.entries(secretMap)) {
        if (record === null || typeof record !== "object") {
          continue;
        }
        const value = (record as Partial<FileSecretRecord>).value;
        if (typeof value !== "string") {
          continue;
        }
        const key = this.key(pluginId, secretName);
        this.values.set(key, value);
        const recordUpdatedAt = (record as Partial<FileSecretRecord>).updatedAt;
        if (typeof recordUpdatedAt === "string") {
          this.updatedAt.set(key, recordUpdatedAt);
        }
      }
    }
  }

  /** 文件损坏：先备份 `.bak` 再按空状态继续（删除失败不阻断，后续写入会原子替换）。 */
  private backupCorruptFile(): void {
    try {
      fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
    } catch {
      // 备份失败不阻断：仍按空状态处理
    }
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // 删除失败不阻断：仍按空状态处理
    }
    instrument.warn("plugin.secret.store_corrupt", "插件 Secret 文件损坏，已备份 .bak 并按空状态处理", {
      filePath: this.filePath,
    });
  }

  /** 全量原子写回：临时文件 + renameSync，避免半写文件被后续进程读到。 */
  private persist(): void {
    const document = this.toDocument();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    // 权限收紧到 0o600：明文 Secret 文件仅限当前用户读写；
    // Windows 上 chmod 仅影响只读位（best-effort，失败忽略）
    try {
      fs.chmodSync(temporaryPath, 0o600);
    } catch {
      // 平台不支持权限位时忽略
    }
    fs.renameSync(temporaryPath, this.filePath);
  }

  private toDocument(): FileSecretsDocument {
    const secrets: Record<string, Record<string, FileSecretRecord>> = {};
    for (const [key, value] of this.values) {
      const separator = key.indexOf("\u0000");
      const pluginId = key.slice(0, separator);
      const secretName = key.slice(separator + 1);
      let pluginSecrets = secrets[pluginId];
      if (pluginSecrets === undefined) {
        pluginSecrets = {};
        secrets[pluginId] = pluginSecrets;
      }
      const recordUpdatedAt = this.updatedAt.get(key);
      pluginSecrets[secretName] =
        recordUpdatedAt !== undefined ? { value, updatedAt: recordUpdatedAt } : { value };
    }
    return { version: 1, secrets };
  }
}
