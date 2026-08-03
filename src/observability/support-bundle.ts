import fs from "node:fs";
import path from "node:path";

import type { RuntimePaths } from "../config/paths.js";
import type { ObservabilityHealth } from "./observability-context.js";
import type { ObservabilityQuery } from "./observability-query.js";

// ═══════════════════════════════════════════════════════════════
// Phase 11 T9：Support Bundle 导出（plans/phase-11.md §10.4）
//
// - 写入私有输出目录（<home>/logs/runtime/exports/），文件名时间戳+随机，
//   不接受用户输入进入路径（防穿越）；
// - 导出内容二次脱敏：Activity/Audit 只含 allowlist 字段，绝不包含
//   payloadJson 原文、事实源正文、凭据；rawPayloadIncluded=false、
//   factSourcesIncluded=false、rawLogsIncluded=false（privacy manifest）；
// - 导出是纯读操作：不修改、不删除任何源日志。
// ═══════════════════════════════════════════════════════════════

export interface SupportBundleManifest {
  readonly generatedAt: string;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly redactionVersion: number;
  readonly includedSections: readonly string[];
  readonly rawPayloadIncluded: false;
  readonly factSourcesIncluded: false;
  readonly rawLogsIncluded: false;
}

export interface SupportBundleResult {
  readonly path: string;
  readonly manifest: SupportBundleManifest;
}

const REDACTION_VERSION = 1;

export function buildSupportBundle(options: {
  readonly paths: RuntimePaths;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly database: import("better-sqlite3").Database;
  readonly query: ObservabilityQuery;
  readonly health: ObservabilityHealth | undefined;
  readonly traceId?: string;
  readonly now?: () => Date;
}): SupportBundleResult {
  const now = options.now ?? (() => new Date());
  const exportsDir = path.join(options.paths.logs, "runtime", "exports");
  fs.mkdirSync(exportsDir, { recursive: true });
  const fileName = `bundle-${now().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}.json`;
  const bundlePath = path.join(exportsDir, fileName);

  // 二次脱敏：只导出 allowlist 字段，不含 payloadJson 原文
  const activityAllowlist = options.query
    .queryActivities({}, null, 100)
    .items
    .filter((row) => row.level === "error" || row.level === "fatal" || row.status === "failed" || row.status === "degraded")
    .map((row) => ({
      id: row.id,
      eventId: row.eventId,
      eventName: row.eventName,
      level: row.level,
      status: row.status,
      recordedAt: row.recordedAt,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      retryable: row.retryable,
      ownerAgentId: row.ownerAgentId,
      sessionId: row.sessionId,
      traceId: row.traceId,
    }));
  const auditAllowlist = options.query.queryAudit({}, null, 100).items.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    ledgerEpoch: row.ledgerEpoch,
    recordedAt: row.recordedAt,
    action: row.action,
    decision: row.decision,
    actorKind: row.actorKind,
    actorId: row.actorId,
    ownerAgentId: row.ownerAgentId,
    sessionId: row.sessionId,
    traceId: row.traceId,
  }));

  const manifest: SupportBundleManifest = {
    generatedAt: now().toISOString(),
    appVersion: options.appVersion,
    schemaVersion: options.schemaVersion,
    platform: process.platform,
    nodeVersion: process.version,
    redactionVersion: REDACTION_VERSION,
    includedSections: ["manifest", "configShape", "health", "failedActivity", "audit", "metrics"],
    rawPayloadIncluded: false,
    factSourcesIncluded: false,
    rawLogsIncluded: false,
  };

  const bundle = {
    manifest,
    // 配置 shape：只含键名与布尔，绝不含配置值/凭据
    configShape: {
      pathKeys: Object.keys(options.paths).sort(),
      hasProviderSettings: fs.existsSync(options.paths.providerSettings),
      hasPreferences: fs.existsSync(options.paths.preferences),
    },
    health: options.health ?? null,
    failedActivity: activityAllowlist,
    audit: auditAllowlist,
    metrics: options.query.dailyMetrics({ days: 7 }),
    ...(options.traceId !== undefined
      ? { trace: { tree: options.query.traceTree(options.traceId), linked: options.query.linkedGraph(options.traceId, { maxNodes: 20 }) } }
      : {}),
  };
  // 原子写（临时文件 + rename），避免半写 bundle
  const tmpPath = `${bundlePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(bundle, null, 2), "utf8");
  fs.renameSync(tmpPath, bundlePath);
  return { path: bundlePath, manifest };
}
