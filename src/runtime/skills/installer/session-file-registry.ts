import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SkillError } from "../errors.js";
import { canonicalPathSync } from "../path-safety.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 SessionFile 登记（plans/phase-13.md §7.3 / §14.1）
//
// - 客户端/API 不得直接引用任意绝对路径：只有先 register 的 SessionFile
//   才能被 install 引用（T6 在 API 层只透传 fileKey，不透传路径）；
// - 登记时校验文件存在、常规文件、大小与 sha256 一致（fail-closed）；
// - install 时再次校验文件当前 sha256 与登记一致（防止登记后被替换）。
// ═══════════════════════════════════════════════════════════════

export interface SessionFileRegistrationInput {
  readonly sessionId: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface SessionFileRegistration {
  readonly fileKey: string;
  readonly sessionId: string;
  /** 登记时的规范化绝对路径（服务端已校验，不回传给客户端） */
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly registeredAt: string;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export class SessionFileRegistry {
  private readonly entries = new Map<string, SessionFileRegistration>();

  /**
   * 登记服务端可见文件。校验：
   * - 参数非空、sha256 为 64 位十六进制；
   * - 文件存在、常规文件（拒绝 symlink）、大小与声明一致、实际 sha256 与声明一致。
   */
  register(input: SessionFileRegistrationInput): SessionFileRegistration {
    if (input.sessionId.trim() === "") {
      throw new SkillError("skill_content_read_denied", "sessionId 不能为空");
    }
    if (input.sizeBytes <= 0) {
      throw new SkillError("skill_package_invalid", "SessionFile 大小必须为正数");
    }
    if (!SHA256_HEX_PATTERN.test(input.sha256)) {
      throw new SkillError("skill_package_invalid", "SessionFile sha256 必须是 64 位十六进制");
    }
    const resolved = canonicalPathSync(input.filePath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      throw new SkillError("skill_source_not_found", "SessionFile 不存在");
    }
    if (stat.isSymbolicLink()) {
      throw new SkillError("skill_content_read_denied", "SessionFile 不允许是符号链接或 Junction");
    }
    if (!stat.isFile()) {
      throw new SkillError("skill_package_invalid", "SessionFile 不是常规文件");
    }
    if (stat.size !== input.sizeBytes) {
      throw new SkillError("skill_content_hash_mismatch", "SessionFile 大小与登记声明不一致");
    }
    const actualSha = sha256File(resolved);
    if (actualSha.toLowerCase() !== input.sha256.toLowerCase()) {
      throw new SkillError("skill_content_hash_mismatch", "SessionFile sha256 与登记声明不一致");
    }
    const registration: SessionFileRegistration = {
      fileKey: `sf-${crypto.randomUUID()}`,
      sessionId: input.sessionId,
      filePath: resolved,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256.toLowerCase(),
      registeredAt: new Date().toISOString(),
    };
    this.entries.set(registration.fileKey, registration);
    return registration;
  }

  get(fileKey: string): SessionFileRegistration | undefined {
    return this.entries.get(fileKey);
  }

  /**
   * 断言文件已登记且属于该 session；未登记/越界 session 一律拒绝
   * （fail-closed，reasonCode=skill_content_read_denied）。
   */
  assertRegistered(fileKey: string, sessionId: string): SessionFileRegistration {
    const registration = this.entries.get(fileKey);
    if (registration === undefined || registration.sessionId !== sessionId) {
      throw new SkillError("skill_content_read_denied", "SessionFile 未登记或不属于当前会话，已拒绝引用");
    }
    return registration;
  }

  removeForSession(sessionId: string): void {
    for (const [fileKey, registration] of this.entries) {
      if (registration.sessionId === sessionId) {
        this.entries.delete(fileKey);
      }
    }
  }
}

/** 校验当前文件实际 sha256 与登记一致（防登记后文件被替换）。 */
export function assertSessionFileUnchanged(registration: SessionFileRegistration): void {
  const stat = fs.lstatSync(registration.filePath);
  if (!stat.isFile() || stat.size !== registration.sizeBytes) {
    throw new SkillError("skill_content_hash_mismatch", "SessionFile 已变化，拒绝安装");
  }
  if (sha256File(registration.filePath).toLowerCase() !== registration.sha256.toLowerCase()) {
    throw new SkillError("skill_content_hash_mismatch", "SessionFile 内容哈希与登记不一致，拒绝安装");
  }
}

function sha256File(target: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(target));
  return hash.digest("hex");
}
