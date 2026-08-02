import fs from "node:fs";
import path from "node:path";
import type { ActivityEnvelope, AuditEnvelope } from "../contracts/observability.js";
import { normalizeSafeObject } from "./safe-value.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 EmergencySpool（plans/phase-11.md §5.5）
//
// - 按 processType/bootId 分文件：logs/emergency/{activity,audit}/<pt>-<bootId>-<segment>.jsonl；
// - 单 segment 10MB；activity 总预算 128MB，超限拒绝新记录（critical）；
//   audit spool 满或两种介质都失败时由调用方 fail closed；
// - 坏行 quarantine（同目录 .quarantine 文件），原 segment 保留；
// - 幂等导入：eventId UNIQUE，重复导入不产生重复行；
// - spool-only 事件导入 SQLite 前不进入实时流（T6 高水位交接）。
// ═══════════════════════════════════════════════════════════════

export interface EmergencySpoolOptions {
  readonly spoolRoot: string;
  readonly processType: string;
  readonly bootId: string;
  readonly segmentSizeBytes?: number;
  readonly budgetBytes?: number;
  readonly now?: () => Date;
}

export interface SpoolWriteResult {
  ok: boolean;
  error?: string;
  pendingSegments: number;
}

export interface SpoolImportResult {
  imported: number;
  quarantined: number;
  failed: number;
  /** 每个 segment 的导入结果（导入成功后 segment 已删除） */
  segments: Array<{ file: string; ok: boolean }>;
}

export class EmergencySpool {
  private readonly spoolRoot: string;
  private readonly processType: string;
  private readonly bootId: string;
  private readonly segmentSizeBytes: number;
  private readonly budgetBytes: number;
  private readonly now: () => Date;
  private failedWrites = 0;

  constructor(options: EmergencySpoolOptions) {
    this.spoolRoot = options.spoolRoot;
    this.processType = options.processType;
    this.bootId = options.bootId;
    this.segmentSizeBytes = options.segmentSizeBytes ?? 10 * 1024 * 1024;
    this.budgetBytes = options.budgetBytes ?? 128 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  getFailedWriteCount(): number { return this.failedWrites; }

  /** 当前进程的待导入 segment 数 */
  pendingSegments(): number {
    try {
      if (!fs.existsSync(this.spoolRoot)) return 0;
      return fs.readdirSync(this.spoolRoot)
        .filter((name) => name.endsWith(".jsonl") && name.includes(`${this.processType}-${this.bootId}-`))
        .length;
    } catch {
      return 0;
    }
  }

  totalBytes(): number {
    try {
      if (!fs.existsSync(this.spoolRoot)) return 0;
      return fs.readdirSync(this.spoolRoot)
        .filter((name) => name.endsWith(".jsonl"))
        .reduce((sum, name) => sum + fs.statSync(path.join(this.spoolRoot, name)).size, 0);
    } catch {
      return 0;
    }
  }

  write(channel: "activity" | "audit", envelope: ActivityEnvelope | AuditEnvelope): SpoolWriteResult {
    const line = JSON.stringify(normalizeSafeObject(envelope).value);
    try {
      fs.mkdirSync(this.spoolRoot, { recursive: true });
      // 预算检查：audit spool 满 → 失败（调用方 fail closed）；activity 超限拒绝新记录
      if (this.totalBytes() + line.length > this.budgetBytes) {
        return { ok: false, error: "应急 spool 预算已满", pendingSegments: this.pendingSegments() };
      }
      const name = this.nextSegmentName(channel);
      const filePath = path.join(this.spoolRoot, name);
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined;
      if (stat !== undefined && stat.size >= this.segmentSizeBytes) {
        // 滚动到新 segment（时间戳后缀）
        const rotated = `${channel}-${this.processType}-${this.bootId}-${this.now().getTime()}.jsonl`;
        fs.appendFileSync(path.join(this.spoolRoot, rotated), `${line}\n`, "utf8");
        return { ok: true, pendingSegments: this.pendingSegments() };
      }
      fs.appendFileSync(filePath, `${line}\n`, "utf8");
      return { ok: true, pendingSegments: this.pendingSegments() };
    } catch (error) {
      this.failedWrites += 1;
      return { ok: false, error: error instanceof Error ? error.message : "spool 写入失败", pendingSegments: this.pendingSegments() };
    }
  }

  /**
   * 幂等导入全部待导入 segment（按文件内顺序逐行校验；坏行 quarantine；
   * 全部成功（含已 quarantine 的坏行）后原子删除 segment）。
   */
  importInto(insert: (line: unknown) => { ok: boolean; error?: string }): SpoolImportResult {
    const result: SpoolImportResult = { imported: 0, quarantined: 0, failed: 0, segments: [] };
    try {
      if (!fs.existsSync(this.spoolRoot)) return result;
      const files = fs.readdirSync(this.spoolRoot)
        .filter((name) => name.endsWith(".jsonl") && name.includes(`${this.processType}-${this.bootId}-`))
        .sort();
      for (const name of files) {
        const filePath = path.join(this.spoolRoot, name);
        const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim().length > 0);
        let segmentOk = true;
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // 坏行 quarantine：追加到 .quarantine 文件，原 segment 保留其他行
            result.quarantined += 1;
            try { fs.appendFileSync(`${filePath}.quarantine`, `${line}\n`, "utf8"); } catch { /* ignore */ }
            continue;
          }
          const outcome = insert(parsed);
          if (outcome.ok) {
            result.imported += 1;
          } else if (outcome.error === "quarantine") {
            result.quarantined += 1;
            try { fs.appendFileSync(`${filePath}.quarantine`, `${line}\n`, "utf8"); } catch { /* ignore */ }
          } else {
            result.failed += 1;
            segmentOk = false;
          }
        }
        if (segmentOk) {
          // 全部行处理完成（含 quarantine）→ 删除 segment（幂等导入）
          try { fs.unlinkSync(filePath); result.segments.push({ file: name, ok: true }); } catch { result.segments.push({ file: name, ok: false }); }
        } else {
          result.segments.push({ file: name, ok: false });
        }
      }
    } catch { /* 导入枚举失败 */ }
    return result;
  }

  private nextSegmentName(channel: "activity" | "audit"): string {
    return `${channel}-${this.processType}-${this.bootId}-0.jsonl`;
  }
}
