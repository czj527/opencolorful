import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceAdapterKind, SkillStagedPackage } from "../../../contracts/skill-protocol.js";
import { SkillError, SkillSourceError } from "../errors.js";
import { safeJoin, SkillPathError } from "../path-safety.js";
import type { SkillSourceAdapter } from "../sources/skill-source-adapter.js";
import { buildStagedPackage, copyPackageTree, locateSkillPackageRoot } from "../sources/stage-utils.js";
import { extractSkillZip, locateEndOfCentralDirectory, parseCentralDirectory } from "../sources/zip-extract.js";
import { DEFAULT_SKILL_PACKAGE_LIMITS } from "../validator.js";
import { assertSessionFileUnchanged, type SessionFileRegistry } from "./session-file-registry.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 受控 Staging（plans/phase-13.md §7.3 / §8.3）
//
// - 统一入口：SkillStager.stage() 按 kind 分发到来源适配器或 SessionFile；
// - staging 目录恒为 paths.skillsStaging/<operationId>（受控，不信任来源）；
// - 只接受完整 package（目录/ZIP/.skill/Git 子目录/已登记 SessionFile）；
// - cleanup() 在成功/失败补偿时清除 staging。
// ═══════════════════════════════════════════════════════════════

/** 安装器可接受的来源 kind：本地/归档/Git/HTTP + 已登记 SessionFile。 */
export type SkillInstallSourceKind = SkillSourceAdapterKind | "session-file";

const REMOTE_UNSUPPORTED: readonly SkillSourceAdapterKind[] = ["openclaw", "hermes"];

export class SkillStager {
  constructor(
    private readonly deps: {
      readonly paths: RuntimePaths;
      readonly adapters: readonly SkillSourceAdapter[];
      readonly sessionFiles: SessionFileRegistry;
    },
  ) {}

  stagingDirFor(operationId: string): string {
    return safeJoin(this.deps.paths.skillsStaging, operationId);
  }

  /**
   * 将完整 package 放入受控 staging（skillsStaging/<operationId>）。
   * 失败抛 SkillError/SkillSourceError（稳定 reasonCode）。
   */
  stage(input: {
    readonly sourceRef: string;
    readonly kind: SkillInstallSourceKind;
    readonly operationId: string;
    readonly sessionId?: string;
  }): SkillStagedPackage {
    const stagingRoot = this.stagingDirFor(input.operationId);
    fs.mkdirSync(stagingRoot, { recursive: true });
    if (input.kind === "session-file") {
      return this.stageSessionFile(input.sourceRef, input.sessionId, stagingRoot);
    }
    if ((REMOTE_UNSUPPORTED as readonly string[]).includes(input.kind)) {
      throw new SkillSourceError("skill_source_unsupported", `来源适配器暂未实现：${input.kind}`);
    }
    const adapter = this.adapterFor(input.kind);
    return adapter.stage(input.sourceRef, { stagingRoot });
  }

  cleanup(operationId: string): void {
    try {
      fs.rmSync(this.stagingDirFor(operationId), { recursive: true, force: true });
    } catch {
      // 尽力清理：失败不掩盖主流程（调用方补偿已尽量）
    }
  }

  private adapterFor(kind: SkillSourceAdapterKind): SkillSourceAdapter {
    const adapter = this.deps.adapters.find((candidate) => candidate.kind === kind);
    if (adapter === undefined) {
      throw new SkillSourceError("skill_source_unsupported", `来源适配器不受支持：${kind}`);
    }
    return adapter;
  }

  private stageSessionFile(fileKey: string, sessionId: string | undefined, stagingRoot: string): SkillStagedPackage {
    if (sessionId === undefined || sessionId.trim() === "") {
      throw new SkillError("skill_content_read_denied", "SessionFile 安装必须提供 sessionId");
    }
    const registration = this.deps.sessionFiles.assertRegistered(fileKey, sessionId);
    assertSessionFileUnchanged(registration);
    const lower = registration.filePath.toLowerCase();
    if (!lower.endsWith(".zip") && !lower.endsWith(".skill")) {
      throw new SkillError("skill_not_a_complete_package", "SessionFile 必须是完整 .zip/.skill 包（不接受裸 Markdown）");
    }
    const buffer = fs.readFileSync(registration.filePath);
    const unpackRoot = safeJoin(stagingRoot, "unpacked");
    const eocdOffset = locateEndOfCentralDirectory(buffer);
    const entries = parseCentralDirectory(buffer, eocdOffset);
    if (entries.length === 0) {
      throw new SkillError("skill_not_a_complete_package", "SessionFile 归档为空，不是完整 Skill 包");
    }
    try {
      extractSkillZip(buffer, entries, unpackRoot, DEFAULT_SKILL_PACKAGE_LIMITS);
    } catch (error) {
      if (error instanceof SkillPathError) {
        throw new SkillError(error.reasonCode, error.message);
      }
      if (error instanceof SkillError) {
        throw error;
      }
      throw new SkillError("skill_package_invalid", error instanceof Error ? error.message : "SessionFile 解包失败");
    }
    const packageRoot = locateSkillPackageRoot(unpackRoot);
    const stagedRoot = safeJoin(stagingRoot, "package");
    copyPackageTree(packageRoot, stagedRoot, { exclude: [".git"] });
    return buildStagedPackage(stagedRoot, {
      sourceRef: `session-file:${fileKey}`,
      originalUrl: registration.filePath,
    });
  }
}
