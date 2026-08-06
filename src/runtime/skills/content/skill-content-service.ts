import crypto from "node:crypto";
import fs from "node:fs";

import type { EventScope, ExecutorRef } from "../../../contracts/observability.js";
import { SKILL_BUDGETS, skillRefKey, type SkillErrorCode, type SkillRef } from "../../../contracts/skill-protocol.js";
import type { SkillActivationGrantRecord } from "../../../storage/skill-activation-grant-store.js";
import { instrument } from "../../../observability/instrument.js";
import type { SkillCatalog } from "../catalog/skill-catalog.js";
import { SkillError, assertSkillRef } from "../errors.js";
import { computeSkillContentHash, hashFileEntries } from "../hash.js";
import { assertNotSymlinkOrJunction, assertSafeRelativeEntry, safeJoin, SkillPathError } from "../path-safety.js";
import {
  SKILL_MAIN_FILE,
  type SkillSnapshot,
  type SkillSnapshotGrant,
  type SkillSnapshotService,
  type SkillSupportFileEntry,
} from "../snapshot/skill-snapshot.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T5 SkillContentService（plans/phase-13.md §6.1 / §10.1 / §10.2 / §18.4）
//
// - 只读取当前 Snapshot 中存在的 SkillRef（entries 或激活授权 overlay），
//   否则 skill_not_in_snapshot fail-closed；
// - 受控路径：safeJoin + canonical 判定 + 拒绝符号链接/Junction（复用 path-safety）；
// - 哈希校验：SKILL.md 首次读取必须匹配包哈希（skill_content_hash_mismatch）；
//   支持文件首次访问冻结相对路径+单文件哈希进 snapshot manifest（首读冻结），
//   后续读取必须匹配冻结哈希（文件被改 → fail-closed）；
// - 大小/预算：单文件 ≤ maxSingleFileBytes、每轮支持文件读取总量 ≤
//   maxSupportBytesPerTurn（超限 skill_content_too_large + truncated，首读计费、
//   重读不重复计费）；超时 contentReadTimeoutMs → skill_content_read_denied；
// - 源文件消失（skill_content_missing）/路径逃逸（skill_path_escape /
//   skill_symlink_escape）fail-closed；
// - 事件：skill.read.started/completed/failed（只记录元数据，绝不记录正文）；
// - loadHandle（load-handle.ts）在读取前由调用方消费；本服务校验 handle 与
//   skillRef 绑定一致后仍执行完整哈希/预算/审计校验。
// ═══════════════════════════════════════════════════════════════

export interface SkillContentBudgets {
  readonly maxSingleFileBytes: number;
  readonly maxSupportBytesPerTurn: number;
  readonly contentReadTimeoutMs: number;
}

const DEFAULT_CONTENT_BUDGETS: SkillContentBudgets = {
  maxSingleFileBytes: SKILL_BUDGETS.maxSingleFileBytes,
  maxSupportBytesPerTurn: SKILL_BUDGETS.maxSupportBytesPerTurn,
  contentReadTimeoutMs: SKILL_BUDGETS.contentReadTimeoutMs,
};

/** 当前 turn 的激活授权 overlay 读取器（生产实现为 SkillActivationGrantStore）。 */
export interface SkillActivationOverlayReader {
  listBySession(sessionId: string): readonly SkillActivationGrantRecord[];
}

export interface SkillContentServiceDeps {
  readonly catalog: SkillCatalog;
  readonly snapshots: SkillSnapshotService;
  /** 激活授权 overlay（会话内安装后当前 turn 生效；缺省只认快照冻结摘要） */
  readonly grants?: SkillActivationOverlayReader;
  /**
   * T11（P0-3）：来源可读性检查（PluginSkillBridge 适配）——插件禁用/卸载后
   * 正文读取 fail-closed（抛错拒绝）。缺省放行（非插件场景）。
   */
  readonly sourceReadable?: (skillRef: SkillRef) => void;
  readonly budgets?: Partial<SkillContentBudgets>;
  readonly now?: () => Date;
  /** 受控读取实现（测试注入：模拟超时/失败；缺省 bounded readFile） */
  readonly readFile?: (absPath: string, maxBytes: number) => Promise<Buffer>;
}

export interface ReadSkillBodyInput {
  readonly snapshot: SkillSnapshot;
  readonly skillRef: SkillRef;
  /** 相对路径（前向斜杠）；缺省 SKILL.md */
  readonly relativePath?: string;
  /** 已消费的受控 loadHandle（load-handle.ts 签发；与 skillRef 绑定不符拒绝） */
  readonly handle?: { readonly skillRef: SkillRef; readonly contentHash: string };
}

export interface SkillReadResult {
  /** 正文（UTF-8；可能为预算截断前缀） */
  readonly body: string;
  readonly truncated: boolean;
  readonly truncatedReason?: "single_file" | "turn_budget";
  /** 本次读取文件内容的单文件确定性哈希（首读冻结用） */
  readonly fileHash: string;
  /** 冻结支持文件后的新 Snapshot（原对象不可变，调用方以返回值继续） */
  readonly snapshot: SkillSnapshot;
}

const EXECUTOR: ExecutorRef = { kind: "service", id: "skill-content" };

export class SkillContentService {
  private readonly budgets: SkillContentBudgets;
  private readonly now: () => Date;
  /** snapshotId → 已通过包哈希校验的 skillRefKey（turn 内缓存） */
  private readonly verifiedPackages = new Map<string, Set<string>>();
  /** snapshotId → 已读取支持文件字节（首读计费；重读不重复计费） */
  private readonly supportBytesUsed = new Map<string, number>();

  constructor(private readonly deps: SkillContentServiceDeps) {
    this.budgets = { ...DEFAULT_CONTENT_BUDGETS, ...(deps.budgets ?? {}) };
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 受控读取 Skill 正文/支持文件（fail-closed，任何失败抛稳定 reasonCode）。
   * T6/T7 的 read 工具挂接点：模型只能通过本入口读取 Snapshot 内路径。
   */
  async readSkillBody(input: ReadSkillBodyInput): Promise<SkillReadResult> {
    const validation = this.deps.snapshots.validateSnapshot(input.snapshot);
    if (!validation.ok) {
      throw new SkillError("skill_operation_failed", `Snapshot 校验失败：${validation.reason ?? "unknown"}`);
    }
    const ref = assertSkillRef(input.skillRef);
    const refKey = skillRefKey(ref);
    const nowIso = this.now().toISOString();
    const relativePath = normalizeRelativePath(input.relativePath);
    const operationId = `skill-read-${refKey.slice(0, 32)}-${crypto.randomUUID().slice(0, 8)}`;

    // 生命周期：started → 全部校验与读取 → completed/failed（只记录元数据）
    this.emitStarted(input.snapshot, refKey, relativePath, operationId);
    try {
      // ── 0. 来源可读性检查（T11 P0-3：插件禁用/卸载 → fail-closed） ──
      if (this.deps.sourceReadable !== undefined) {
        try {
          this.deps.sourceReadable(ref);
        } catch (error) {
          throw new SkillError(
            "skill_content_read_denied",
            `Skill 来源已阻断，正文读取拒绝：${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
          );
        }
      }

      // ── 1. 成员检查：Snapshot entries 或激活授权 overlay（fail-closed） ──
      const inEntries = input.snapshot.entries.some(
        (entry) => entry.skillRefKey === refKey && entry.skillRef.contentHash === ref.contentHash,
      );
      const overlayGrant = this.findOverlayGrant(input.snapshot, ref, nowIso);
      if (!inEntries && overlayGrant === undefined) {
        throw new SkillError("skill_not_in_snapshot", `SkillRef 不在当前 Snapshot 可见集或激活授权中：${refKey}`);
      }

      // ── 2. loadHandle 绑定校验（提供 handle 时必须与 skillRef 精确一致） ──
      if (input.handle !== undefined) {
        if (skillRefKey(input.handle.skillRef) !== refKey || input.handle.contentHash !== ref.contentHash) {
          throw new SkillError("skill_content_read_denied", "loadHandle 与请求的 SkillRef 绑定不符，已拒绝");
        }
      }

      // ── 3. 受控路径解析（canonical / 逃逸 / 符号链接 / 消失） ──
      const registered = this.deps.catalog.resolveBySkillRef(ref);
      const absPath = safeJoin(registered.rootPath, ...relativePath.split("/"));
      try {
        assertNotSymlinkOrJunction(absPath, "Skill 文件");
      } catch (error) {
        if (error instanceof SkillPathError) {
          throw error; // skill_symlink_escape
        }
        throw new SkillError("skill_content_missing", `Skill 源文件不存在或不可读：${relativePath}`);
      }
      const stat = statRegularFile(absPath, relativePath);

      // ── 4. 哈希校验 + 受控读取（SKILL.md → 包哈希；支持文件 → 首读冻结哈希） ──
      const firstSupportRead = relativePath !== SKILL_MAIN_FILE && !this.isFrozen(input.snapshot, refKey, relativePath);
      const prefix =
        relativePath === SKILL_MAIN_FILE
          ? await this.readMainFile(input.snapshot, ref, refKey, registered.rootPath, absPath)
          : firstSupportRead
            ? await this.readWithTimeout(absPath, this.budgets.maxSingleFileBytes)
            : await this.verifyFrozenSupportFile(input.snapshot, refKey, relativePath, absPath);

      // ── 5. 预算/截断 + 首读冻结 ──
      const fileHash = hashFileEntries([{ rel: relativePath, content: prefix }]);
      let resultSnapshot = input.snapshot;
      if (firstSupportRead) {
        const entry: SkillSupportFileEntry = {
          skillRefKey: refKey,
          relativePath,
          fileHash,
          sizeBytes: stat.size,
          frozenAt: nowIso,
        };
        resultSnapshot = this.deps.snapshots.freezeSupportFile(input.snapshot, entry);
      }
      const result = this.applyBudget(resultSnapshot, relativePath, prefix, stat.size, fileHash, firstSupportRead);

      this.emitCompleted(resultSnapshot, refKey, relativePath, result.body.length, result.truncated);
      return result;
    } catch (error) {
      this.emitFailed(input.snapshot, refKey, relativePath, operationId, error);
      throw error;
    }
  }

  /** 某 Snapshot 内已冻结的支持文件清单（审计/调试用）。 */
  listFrozenSupportFiles(snapshot: SkillSnapshot): readonly SkillSupportFileEntry[] {
    const validation = this.deps.snapshots.validateSnapshot(snapshot);
    if (!validation.ok) {
      throw new SkillError("skill_operation_failed", `Snapshot 校验失败：${validation.reason ?? "unknown"}`);
    }
    return snapshot.supportFiles;
  }

  // ── 内部辅助 ─────────────────────────────────────────────────

  /** SKILL.md：包哈希校验（缓存 per snapshot+skill；turn 内冻结）后受控读取。 */
  private async readMainFile(snapshot: SkillSnapshot, ref: SkillRef, refKey: string, rootPath: string, absPath: string): Promise<Buffer> {
    const verified = this.verifiedPackages.get(snapshot.snapshotId);
    if (verified === undefined || !verified.has(refKey)) {
      // 与注册同源校验：生产安装路径（installer → buildStagedPackage）登记的是
      // 版本参与哈希（version 盐）；测试/本地 ingest 路径登记的是无盐哈希。
      // 两种注册风格都必须能通过校验，但只有与登记哈希完全一致才放行（fail-closed）。
      let actualHash: string;
      try {
        const version = ref.version;
        actualHash = computeSkillContentHash(rootPath);
        if (actualHash !== ref.contentHash && version !== undefined && version !== "") {
          actualHash = computeSkillContentHash(rootPath, { version });
        }
      } catch (error) {
        if (error instanceof SkillPathError) {
          throw error;
        }
        throw new SkillError("skill_content_missing", `Skill 包不可哈希（源文件消失或不可读）：${refKey}`);
      }
      if (actualHash !== ref.contentHash) {
        throw new SkillError("skill_content_hash_mismatch", "Skill 内容哈希与 Snapshot SkillRef 不一致");
      }
      const set = this.verifiedPackages.get(snapshot.snapshotId) ?? new Set<string>();
      set.add(refKey);
      this.verifiedPackages.set(snapshot.snapshotId, set);
    }
    return this.readWithTimeout(absPath, this.budgets.maxSingleFileBytes);
  }

  /** 支持文件重读：必须匹配首读冻结哈希（文件被改 → fail-closed）。 */
  private async verifyFrozenSupportFile(snapshot: SkillSnapshot, refKey: string, relativePath: string, absPath: string): Promise<Buffer> {
    const frozen = snapshot.supportFiles.find((file) => file.skillRefKey === refKey && file.relativePath === relativePath);
    if (frozen === undefined) {
      throw new SkillError("skill_content_read_denied", `支持文件未冻结（${relativePath}）`);
    }
    const prefix = await this.readWithTimeout(absPath, this.budgets.maxSingleFileBytes);
    const currentHash = hashFileEntries([{ rel: relativePath, content: prefix }]);
    if (currentHash !== frozen.fileHash) {
      throw new SkillError("skill_content_hash_mismatch", `支持文件哈希与首读冻结不一致（${relativePath}）`);
    }
    return prefix;
  }

  private isFrozen(snapshot: SkillSnapshot, refKey: string, relativePath: string): boolean {
    return snapshot.supportFiles.some((file) => file.skillRefKey === refKey && file.relativePath === relativePath);
  }

  /**
   * 预算截断：单文件上限 → single_file；支持文件 turn 总量 → turn_budget
   * （首读计费；重读冻结内容不重复计费）。超限返回截断前缀并标记 truncated。
   */
  private applyBudget(
    snapshot: SkillSnapshot,
    relativePath: string,
    prefix: Buffer,
    fullSize: number,
    fileHash: string,
    firstRead: boolean,
  ): SkillReadResult {
    let returnLength = Math.min(prefix.length, this.budgets.maxSingleFileBytes);
    let truncated = fullSize > this.budgets.maxSingleFileBytes;
    let truncatedReason: "single_file" | "turn_budget" | undefined = truncated ? "single_file" : undefined;
    if (firstRead && relativePath !== SKILL_MAIN_FILE) {
      // 支持文件首读计费：剩余额度不足时只返回剩余字节（截断前缀）
      const used = this.supportBytesUsed.get(snapshot.snapshotId) ?? 0;
      const remaining = this.budgets.maxSupportBytesPerTurn - used;
      if (returnLength > remaining) {
        returnLength = Math.max(0, remaining);
        truncated = true;
        truncatedReason = "turn_budget";
      }
      this.supportBytesUsed.set(snapshot.snapshotId, used + returnLength);
    }
    return {
      body: prefix.subarray(0, returnLength).toString("utf8"),
      truncated,
      ...(truncatedReason !== undefined ? { truncatedReason } : {}),
      fileHash,
      snapshot,
    };
  }

  /** 激活授权 overlay：快照冻结摘要（未过期）+ 当前 turn 实时 overlay。 */
  private findOverlayGrant(snapshot: SkillSnapshot, ref: SkillRef, nowIso: string): SkillSnapshotGrant | undefined {
    const refKey = skillRefKey(ref);
    const grants: readonly SkillSnapshotGrant[] = [
      ...snapshot.activationGrants,
      ...(this.deps.grants !== undefined
        ? this.deps.grants.listBySession(snapshot.sessionId).filter((grant) => grant.issuedTurnId === snapshot.turnId).map(toSnapshotGrantLike)
        : []),
    ];
    for (const grant of grants) {
      if (grant.skillRefKey === refKey && grant.contentHash === ref.contentHash && grant.expiresAt >= nowIso) {
        return grant;
      }
    }
    return undefined;
  }

  private async readWithTimeout(absPath: string, maxBytes: number): Promise<Buffer> {
    const readPromise = this.deps.readFile !== undefined ? this.deps.readFile(absPath, maxBytes) : readFileBounded(absPath, maxBytes);
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new SkillError("skill_content_read_denied", "Skill 内容读取超时"));
      }, this.budgets.contentReadTimeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([readPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  // ── 事件（只记录元数据，绝不记录正文） ─────────────────────────

  private emitStarted(snapshot: SkillSnapshot, refKey: string, relativePath: string, operationId: string): void {
    this.emit("skill.read.started", snapshot, operationId, "started", { skillRefKey: refKey, file: relativePath });
  }

  private emitCompleted(snapshot: SkillSnapshot, refKey: string, relativePath: string, sizeBytes: number, truncated: boolean): void {
    this.emit("skill.read.completed", snapshot, undefined, "completed", {
      skillRefKey: refKey,
      file: relativePath,
      sizeBytes,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  private emitFailed(snapshot: SkillSnapshot, refKey: string, relativePath: string, operationId: string, error: unknown): void {
    this.emit("skill.read.failed", snapshot, operationId, "failed", {
      skillRefKey: refKey,
      file: relativePath,
      reasonCode: extractReasonCode(error),
    });
  }

  private emit(
    eventName: "skill.read.started" | "skill.read.completed" | "skill.read.failed",
    snapshot: SkillSnapshot,
    operationId: string | undefined,
    status: "started" | "completed" | "failed",
    attributes: Record<string, string | number | boolean>,
  ): void {
    const scope: EventScope = { ownerAgentId: snapshot.agentId, sessionId: snapshot.sessionId, turnId: snapshot.turnId };
    instrument.activity({
      eventName,
      ...(operationId !== undefined ? { operationId } : {}),
      status,
      actor: { kind: "system", id: "skill-content" },
      executor: EXECUTOR,
      scope,
      payload: { summaryCode: eventName.replace(/\./g, "_"), attributes },
    });
  }
}

// ── 模块级辅助 ─────────────────────────────────────────────────

function toSnapshotGrantLike(grant: SkillActivationGrantRecord): SkillSnapshotGrant {
  return {
    grantId: grant.grantId,
    skillRefKey: grant.skillRefKey,
    contentHash: grant.contentHash,
    issuedTurnId: grant.issuedTurnId,
    expiresAt: grant.expiresAt,
    consumedAt: grant.consumedAt,
  };
}

/** 相对路径规范化：缺省 SKILL.md；拒绝绝对路径/`..`/空（fail-closed）。 */
function normalizeRelativePath(relativePath: string | undefined): string {
  const value = relativePath ?? SKILL_MAIN_FILE;
  assertSafeRelativeEntry(value, "skill_path_escape");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new SkillError("skill_path_escape", "相对路径不能以 / 开头");
  }
  return normalized;
}

/** 常规文件 stat；消失/不可读 → skill_content_missing（fail-closed）。 */
function statRegularFile(absPath: string, relativePath: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new SkillError("skill_content_missing", `Skill 源文件不存在或不可读：${relativePath}`);
  }
  if (!stat.isFile()) {
    throw new SkillError("skill_content_read_denied", `Skill 路径不是常规文件：${relativePath}`);
  }
  return stat;
}

/** 生产实现：bounded readFile（最多读取 maxBytes 字节，防超大文件拉满内存）。 */
async function readFileBounded(absPath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.promises.open(absPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function extractReasonCode(error: unknown): SkillErrorCode {
  if (error instanceof SkillError) {
    return error.code;
  }
  if (error instanceof SkillPathError) {
    return error.reasonCode;
  }
  return "skill_content_read_denied";
}
