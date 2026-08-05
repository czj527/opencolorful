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
import { createSkillPackage, ingestPackage, makeEnv, tempPaths, type CreateSkillPackageOptions } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T4 测试共享 harness（tests/unit/skills/）
//
// 组合真实 DB + ObservabilityContext（AuditRecorder/Activity）+ 四类
// Store + 三个 T4 服务；now 可注入（临时绑定 TTL / 授权过期测试用）。
// ═══════════════════════════════════════════════════════════════

const producer: ProducerContext = {
  component: "t4-test",
  processType: "server",
  processId: "1",
  bootId: "boot-t4",
  appVersion: "0.0.0-test",
  hostPlatform: process.platform,
};

export interface T4Harness {
  readonly paths: RuntimePaths;
  readonly home: string;
  readonly db: Database.Database;
  readonly audit: AuditRecorder;
  readonly catalog: SkillCatalog;
  readonly configStore: AgentSkillConfigStore;
  readonly bindingStore: AgentSkillBindingStore;
  readonly bundles: SkillBundleStore;
  readonly sessionBindings: SessionSkillBindingStore;
  readonly grants: SkillActivationGrantStore;
  readonly agentService: AgentSkillService;
  readonly bundleService: SkillBundleService;
  readonly sessionService: SessionSkillService;
  readonly now: () => Date;
  /** 推进假时钟（now 注入后生效）。 */
  advance(ms: number): void;
}

const cleanups: Array<() => void> = [];

export function cleanupT4Harnesses(): void {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
}

export function createT4Harness(): T4Harness {
  const { paths, home } = tempPaths();
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
  const agentService = new AgentSkillService({
    paths,
    catalog,
    configStore,
    bindingStore,
    bundles,
    audit: context.audit,
    now,
  });
  const bundleService = new SkillBundleService({
    paths,
    bundles,
    catalog,
    configStore,
    bindingStore,
    audit: context.audit,
    now,
  });
  const sessionService = new SessionSkillService({
    catalog,
    sessionBindings,
    grants,
    now,
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
    configStore,
    bindingStore,
    bundles,
    sessionBindings,
    grants,
    agentService,
    bundleService,
    sessionService,
    now,
    advance(ms: number) {
      nowValue = new Date(nowValue.getTime() + ms);
    },
  };
}

/** 便捷登记：建包 + 校验 + 注入 Catalog（managed 来源，trusted）。 */
export function ingestManagedSkill(
  harness: T4Harness,
  rootDir: string,
  options: CreateSkillPackageOptions = {},
): ReturnType<SkillCatalog["ingestCandidate"]> {
  const dir = createSkillPackage(rootDir, options);
  return ingestPackage(harness.catalog, dir, "managed", makeEnv());
}

/** 便捷登记 workspace 来源候选。 */
export function ingestWorkspaceSkill(
  harness: T4Harness,
  rootDir: string,
  options: CreateSkillPackageOptions = {},
): ReturnType<SkillCatalog["ingestCandidate"]> {
  const dir = createSkillPackage(rootDir, options);
  return ingestPackage(harness.catalog, dir, "workspace", makeEnv());
}
