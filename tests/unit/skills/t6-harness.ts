import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type { ProducerContext } from "../../../src/contracts/observability.js";
import { getRuntimePaths, type RuntimePaths } from "../../../src/config/paths.js";
import { openMetadataDatabase } from "../../../src/storage/database.js";
import { ObservabilityContext } from "../../../src/observability/observability-context.js";
import { instrument } from "../../../src/observability/instrument.js";
import type { AuditRecorder } from "../../../src/observability/audit-recorder.js";
import { SkillCatalog } from "../../../src/runtime/skills/catalog/skill-catalog.js";
import { AgentSkillConfigStore } from "../../../src/runtime/skills/agent/agent-skill-config.js";
import { AgentSkillService } from "../../../src/runtime/skills/binding/skill-binding-service.js";
import { SkillBundleService } from "../../../src/runtime/skills/bundles/skill-bundle-service.js";
import { SessionSkillService } from "../../../src/runtime/skills/session/session-skill-service.js";
import { AgentSkillBindingStore } from "../../../src/storage/agent-skill-binding-store.js";
import { SkillBundleStore } from "../../../src/storage/skill-bundle-store.js";
import { SessionSkillBindingStore } from "../../../src/storage/session-skill-binding-store.js";
import { SkillActivationGrantStore } from "../../../src/storage/skill-activation-grant-store.js";
import { SkillOperationStore } from "../../../src/runtime/skills/installer/operation-store.js";
import { SessionFileRegistry } from "../../../src/runtime/skills/installer/session-file-registry.js";
import { SkillStager } from "../../../src/runtime/skills/installer/stager.js";
import { SkillInstaller } from "../../../src/runtime/skills/installer/skill-installer.js";
import { BuiltinSkillSource } from "../../../src/runtime/skills/sources/builtin-source.js";
import { ManagedSkillSource } from "../../../src/runtime/skills/sources/managed-source.js";
import { ArchiveSkillSource } from "../../../src/runtime/skills/sources/archive-source.js";
import { DefaultSkillTrustPolicy, type SkillTrustPolicy } from "../../../src/runtime/skills/sources/trust-config.js";
import { SkillSnapshotService } from "../../../src/runtime/skills/snapshot/skill-snapshot.js";
import { SkillContentService } from "../../../src/runtime/skills/content/skill-content-service.js";
import { LoadHandleRegistry } from "../../../src/runtime/skills/content/load-handle.js";
import { ConfirmationTokenRegistry } from "../../../src/runtime/skills/confirmation/confirmation-token.js";
import { SkillCoreService } from "../../../src/runtime/skills/core/skill-core-service.js";
import { createSkillPackage, ingestPackage, makeEnv, tempPaths, type CreateSkillPackageOptions } from "./helpers.js";
import { buildSkillZip } from "./zip-fixture.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T6 测试共享 harness（tests/unit/skills/）
//
// 组合真实 DB + ObservabilityContext + T2 Catalog + T3 Installer +
// T4 三个服务 + T5 Content/loadHandle/Snapshot + T6 确认令牌与 Core Service。
// now 可注入（令牌过期 / 授权过期 / 临时绑定 TTL 测试用）。
// ═══════════════════════════════════════════════════════════════

const producer: ProducerContext = {
  component: "t6-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t6",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

export interface T6Harness {
  readonly paths: RuntimePaths;
  readonly home: string;
  readonly db: Database.Database;
  readonly audit: AuditRecorder;
  readonly catalog: SkillCatalog;
  readonly trust: SkillTrustPolicy;
  readonly sessionFiles: SessionFileRegistry;
  readonly installer: SkillInstaller;
  readonly agentService: AgentSkillService;
  readonly bundleService: SkillBundleService;
  readonly sessionService: SessionSkillService;
  readonly content: SkillContentService;
  readonly loadHandles: LoadHandleRegistry;
  readonly confirmations: ConfirmationTokenRegistry;
  readonly core: SkillCoreService;
  readonly now: () => Date;
  /** 推进假时钟（now 注入后生效）。 */
  advance(ms: number): void;
  /** 便捷：登记一个 session-file（.zip），返回 fileKey。 */
  registerSessionZip(filePath: string, sessionId: string): string;
  /** 便捷：建完整 Skill 包目录并返回路径。 */
  makePackage(subdir: string, options?: CreateSkillPackageOptions): string;
}

const cleanups: Array<() => void> = [];

export function cleanupT6Harnesses(): void {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
}

export function createT6Harness(options: { readonly trustedRoots?: readonly string[] } = {}): T6Harness {
  const { paths, home } = tempPaths("ocf-t6-home-");
  const db = openMetadataDatabase(path.join(home, "metadata.sqlite"));
  const context = new ObservabilityContext({
    database: db,
    producer,
    logsRoot: path.join(home, "logs"),
    spoolRoot: path.join(home, "spool"),
  });
  instrument.init(context);

  let nowValue = new Date("2026-01-01T00:00:00.000Z");
  const now = (): Date => nowValue;

  const catalog = new SkillCatalog();
  const configStore = new AgentSkillConfigStore(paths);
  const bindingStore = new AgentSkillBindingStore(db);
  const bundles = new SkillBundleStore(db);
  const sessionBindings = new SessionSkillBindingStore(db);
  const grants = new SkillActivationGrantStore(db);
  const operations = new SkillOperationStore(db);
  const sessionFiles = new SessionFileRegistry();
  const adapters = [
    new BuiltinSkillSource(paths),
    new ManagedSkillSource(paths),
    new ArchiveSkillSource(paths),
  ];
  const stager = new SkillStager({ paths, adapters, sessionFiles });
  const installer = new SkillInstaller({
    paths,
    catalog,
    operations,
    sessionFiles,
    adapters,
    stager,
    environment: makeEnv(),
  });
  const agentService = new AgentSkillService({
    paths,
    catalog,
    configStore,
    bindingStore,
    bundles,
    audit: context.audit,
    operations,
    now,
  });
  const bundleService = new SkillBundleService({
    paths,
    bundles,
    catalog,
    configStore,
    bindingStore,
    audit: context.audit,
    operations,
    now,
  });
  const sessionService = new SessionSkillService({ catalog, sessionBindings, grants, now });
  const snapshots = new SkillSnapshotService({ now });
  const content = new SkillContentService({
    catalog,
    snapshots,
    grants: {
      listBySession: (sessionId) => grants.listBySession(sessionId),
      listTurnOverlays: (sessionId, turnId) => sessionService.listTurnOverlays(sessionId, turnId),
    },
    now,
  });
  const loadHandles = new LoadHandleRegistry({ now });
  const confirmations = new ConfirmationTokenRegistry({ now, ttlMs: 15 * 60 * 1000 });

  const trust = new DefaultSkillTrustPolicy({
    version: 1,
    trustedRoots: options.trustedRoots ?? [home],
    disabledKinds: [],
    trustedSourceIds: {},
  });

  const core = new SkillCoreService({
    catalog,
    installer,
    agentService,
    bundleService,
    sessionService,
    snapshots,
    contentService: content,
    loadHandles,
    confirmations,
    sessionFiles,
    environment: makeEnv(),
    trust,
    workspace: { cwd: home, home },
    now,
    activationGrantTtlMs: 30 * 60 * 1000,
    loadHandleTtlMs: 15 * 60 * 1000,
    confirmationTtlMs: 15 * 60 * 1000,
  });

  cleanups.push(() => {
    instrument.reset();
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  return {
    paths,
    home,
    db,
    audit: context.audit,
    catalog,
    trust,
    sessionFiles,
    installer,
    agentService,
    bundleService,
    sessionService,
    content,
    loadHandles,
    confirmations,
    core,
    now,
    advance(ms: number) {
      nowValue = new Date(nowValue.getTime() + ms);
    },
    registerSessionZip(filePath: string, sessionId: string): string {
      const buffer = fs.readFileSync(filePath);
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      const registration = installer.registerSessionFile({
        sessionId,
        filePath,
        sizeBytes: buffer.length,
        sha256,
      });
      return registration.fileKey;
    },
    makePackage(subdir: string, options: CreateSkillPackageOptions = {}): string {
      return createSkillPackage(path.join(home, subdir), options);
    },
  };
}

/** 便捷：建包 + 登记到 Catalog（managed 来源，trusted）。 */
export function ingestManagedSkill(
  harness: T6Harness,
  rootDir: string,
  options: CreateSkillPackageOptions = {},
): ReturnType<SkillCatalog["ingestCandidate"]> {
  const dir = createSkillPackage(rootDir, options);
  return ingestPackage(harness.catalog, dir, "managed", makeEnv());
}

/** 便捷：在 workspace 兼容目录（home/.claude/skills/<name>）直接写一个包，返回包路径。 */
export function makeWorkspaceSkill(
  harness: T6Harness,
  name: string,
  options: CreateSkillPackageOptions = {},
): string {
  const root = path.join(harness.home, ".claude", "skills");
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "---",
    `name: ${options.name ?? name}`,
    `description: ${options.description ?? "测试用 Skill"}`,
    ...(options.version !== undefined ? [`version: ${options.version}`] : []),
    ...(options.license !== undefined ? [`license: ${options.license}`] : []),
    ...(options.extraFrontmatter !== undefined ? options.extraFrontmatter.split("\n") : []),
    "---",
    options.body ?? "这是 Skill 正文。",
  ];
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${lines.join("\n")}\n`, "utf8");
  return dir;
}

/** 便捷：把一个完整 Skill 目录打包为 .zip（session-file 用；SKILL.md 由 fixture 生成）。 */
export function packSkillZip(packageRoot: string, targetZip: string): string {
  const extraEntries = zipEntriesFromDir(packageRoot).filter((entry) => entry.name !== "SKILL.md");
  const zip = buildSkillZip({
    name: path.basename(packageRoot),
    extraEntries,
  });
  fs.mkdirSync(path.dirname(targetZip), { recursive: true });
  fs.writeFileSync(targetZip, zip);
  return targetZip;
}

function zipEntriesFromDir(packageRoot: string): { readonly name: string; readonly content: string }[] {
  const entries: { name: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(packageRoot, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        entries.push({ name: rel, content: fs.readFileSync(abs, "utf8") });
      }
    }
  };
  walk(packageRoot);
  return entries;
}
