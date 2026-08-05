import type { RuntimePaths } from "../../../config/paths.js";
import type { SkillSourceCandidate, SkillSourceKind } from "../../../contracts/skill-protocol.js";
import type { ReadinessEnvironment } from "../readiness.js";
import type { SkillSourceAdapter, SkillSourceInspection } from "../sources/skill-source-adapter.js";
import type { SkillTrustPolicy } from "../sources/trust-config.js";
import { BuiltinSkillSource } from "../sources/builtin-source.js";
import { ManagedSkillSource } from "../sources/managed-source.js";
import { WorkspaceSkillSource } from "../sources/workspace-source.js";
import { ExternalLocalSkillSource } from "../sources/external-local-source.js";
import { PluginSkillSource, type PluginSkillBundleProvider } from "../sources/plugin-source.js";
import type { SkillCatalog, RegisteredSkill } from "./skill-catalog.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T2 五类来源扫描编排（plans/phase-13.md §8.1 / §18.2）
//
// - builtin/managed/plugin/workspace/external 统一经适配器 → 校验 → Catalog；
// - workspace 与兼容目录默认关闭（trust policy 判定，未信任 → skipped）；
// - plugin 未注入 provider（T7 接线）→ skipped（fail-closed，不假装已发现）；
// - 校验失败/哈希不可用的候选 → failed（显式诊断，不静默丢弃）。
// ═══════════════════════════════════════════════════════════════

export interface SkillScanOptions {
  readonly paths: RuntimePaths;
  readonly cwd: string;
  readonly home: string;
  readonly trust: SkillTrustPolicy;
  readonly environment: ReadinessEnvironment;
  readonly catalog: SkillCatalog;
  readonly query?: string;
  /** 显式外部本地目录（作为 external 来源扫描，默认不可信，需审查） */
  readonly externalDirs?: readonly string[];
  readonly pluginProvider?: PluginSkillBundleProvider;
  readonly includeKinds?: readonly SkillSourceKind[];
}

export interface ScanSkipped {
  readonly sourceKind: SkillSourceKind;
  readonly reason: string;
}

export interface ScanFailedCandidate {
  readonly candidate: SkillSourceCandidate;
  readonly errors: readonly string[];
}

export interface SkillScanReport {
  readonly registered: readonly RegisteredSkill[];
  readonly skipped: readonly ScanSkipped[];
  readonly failed: readonly ScanFailedCandidate[];
}

export function scanSkills(options: SkillScanOptions): SkillScanReport {
  const kinds = new Set(options.includeKinds ?? ["builtin", "managed", "plugin", "workspace", "external"]);
  const registered: RegisteredSkill[] = [];
  const skipped: ScanSkipped[] = [];
  const failed: ScanFailedCandidate[] = [];

  const ingest = (sourceKind: SkillSourceKind, adapter: SkillSourceAdapter, trusted: boolean): void => {
    let candidates: readonly SkillSourceCandidate[];
    try {
      candidates = adapter.discover(options.query);
    } catch (error) {
      skipped.push({ sourceKind, reason: `来源扫描失败：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    for (const candidate of candidates) {
      let inspection: SkillSourceInspection;
      try {
        inspection = adapter.inspect(candidate.sourceId);
      } catch (error) {
        failed.push({
          candidate,
          errors: [error instanceof Error ? error.message : String(error)],
        });
        continue;
      }
      if (inspection.contentHash === "") {
        failed.push({ candidate, errors: ["内容哈希不可用，无法登记"] });
        continue;
      }
      const registeredOne = options.catalog.ingestCandidate({
        candidate,
        inspection,
        trusted,
        environment: options.environment,
      });
      registered.push(registeredOne);
    }
  };

  if (kinds.has("builtin")) {
    ingest("builtin", new BuiltinSkillSource(options.paths), true);
  }
  if (kinds.has("managed")) {
    ingest("managed", new ManagedSkillSource(options.paths), true);
  }
  if (kinds.has("workspace")) {
    const decision = options.trust.evaluate({ sourceKind: "workspace", sourceId: options.cwd, rootPath: options.cwd });
    if (!decision.enabled) {
      skipped.push({ sourceKind: "workspace", reason: decision.reason ?? "workspace 来源默认关闭" });
    } else {
      ingest("workspace", new WorkspaceSkillSource({ cwd: options.cwd, home: options.home, trust: options.trust }), true);
    }
  }
  if (kinds.has("plugin")) {
    if (options.pluginProvider === undefined) {
      skipped.push({ sourceKind: "plugin", reason: "Plugin Skill Bundle 登记接线在 T7，未注入 provider" });
    } else {
      ingest("plugin", new PluginSkillSource({ provider: options.pluginProvider }), true);
    }
  }
  if (kinds.has("external")) {
    const decision = options.trust.evaluate({ sourceKind: "external", sourceId: "external" });
    if (!decision.enabled) {
      skipped.push({ sourceKind: "external", reason: decision.reason ?? "external 来源已显式关闭" });
    } else {
      const adapter = new ExternalLocalSkillSource(options.trust);
      for (const dir of options.externalDirs ?? []) {
        const dirDecision = options.trust.evaluate({ sourceKind: "external", sourceId: dir, rootPath: dir });
        const candidates = adapter.discover(options.query, { baseDir: dir });
        for (const candidate of candidates) {
          let inspection: SkillSourceInspection;
          try {
            inspection = adapter.inspect(candidate.sourceId);
          } catch (error) {
            failed.push({ candidate, errors: [error instanceof Error ? error.message : String(error)] });
            continue;
          }
          if (inspection.contentHash === "") {
            failed.push({ candidate, errors: ["内容哈希不可用，无法登记"] });
            continue;
          }
          const registeredOne = options.catalog.ingestCandidate({
            candidate,
            inspection,
            trusted: dirDecision.trusted,
            environment: options.environment,
          });
          registered.push(registeredOne);
        }
      }
    }
  }

  return { registered, skipped, failed };
}
