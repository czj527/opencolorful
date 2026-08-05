// ═══════════════════════════════════════════════════════════════
// Phase 13 T3 Skill 安装器公共出口（plans/phase-13.md §十六 T3）
// ═══════════════════════════════════════════════════════════════

export {
  SkillInstaller,
  type SkillInstallerDeps,
  type SkillInstallOptions,
  type SkillInstallResult,
  type SkillUpdateOptions,
  type SkillRollbackOptions,
  type SkillRollbackResult,
  type SkillUninstallOptions,
  type SkillUninstallResult,
  type SkillSourceInspectResult,
} from "./skill-installer.js";

export { SkillStager, type SkillInstallSourceKind } from "./stager.js";

export {
  SkillOperationStore,
  SKILL_OPERATION_KINDS,
  SKILL_OPERATION_STATUSES,
  type SkillOperationKind,
  type SkillOperationStatus,
  type SkillOperationRecord,
} from "./operation-store.js";

export {
  SessionFileRegistry,
  type SessionFileRegistration,
  type SessionFileRegistrationInput,
} from "./session-file-registry.js";

export {
  assessPackageRisks,
  SKILL_RISK_CODES,
  type SkillRiskCode,
  type SkillRiskMarker,
} from "./risk.js";
