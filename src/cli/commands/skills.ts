// ═══════════════════════════════════════════════════════════════
// Phase 13 T8 CLI skills 命令组（plans/phase-13.md §14.3 / §15.1）
//
// 子命令：
//   list                         已安装/可见 Skill（含四类状态）
//   search <query>               跨层搜索（bound/managed/workspace/plugin/remote）
//   inspect <source-ref>         检查来源（--kind local|archive|git|http）
//   install <source-ref>         安装（高风险默认显式确认；--yes 跳过交互）
//   validate <path>              纯本地：包结构/完整性/哈希校验
//   pack <path> [--out <file>]   纯本地：生成 .skill ZIP + 输出内容哈希
//   init <name>                  纯本地：生成标准目录 + 最小 SKILL.md
//   link <path>                  纯本地：登记 Linked Source（只读引用，不复制）
//   unlink <source-id>           纯本地：注销 Linked Source
//   doctor                       本地来源/哈希/Linked + Server Catalog/绑定诊断
//   bundle create|version|inspect  Bundle 版本化管理（HTTP）
//
// 事实来源承诺：
// - 安装/绑定/搜索/检查/版本化一律经 Server HTTP（/api/skills*），与会话内
//   工具共用同一 SkillCoreService；CLI 不实现第二套校验或安装逻辑；
// - validate/pack/init/link/unlink 是纯文件操作，直接复用 T2 的
//   validator/hash 与 T8 的 LinkedSourceRegistry/pack 模块；
// - doctor 的 Server 部分不可达时给出明确诊断（网络失败≠没有 Skill）。
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { getRuntimePaths } from "../../config/paths.js";
import { loadEnvironment } from "../../config/environment.js";
import type { SkillErrorCode } from "../../contracts/skill-protocol.js";
import { LinkedSourceRegistry } from "../../runtime/skills/sources/linked-source-registry.js";
import { SkillSourceTrustStore } from "../../runtime/skills/sources/trust-config.js";
import { workspaceCompatibilityRoots } from "../../runtime/skills/sources/workspace-roots.js";
import { packSkillPackage } from "../../runtime/skills/pack.js";
import { assessPackageRisks } from "../../runtime/skills/installer/risk.js";
import { validateSkillPackage } from "../../runtime/skills/validator.js";
import { SkillError } from "../../runtime/skills/errors.js";

export async function runSkillsCommand(args: readonly string[]): Promise<void> {
  const command = args[0];
  const rest = args.slice(1);
  switch (command) {
    case "list":
      await runList(rest);
      return;
    case "search":
      await runSearch(rest);
      return;
    case "inspect":
      await runInspect(rest);
      return;
    case "install":
      await runInstall(rest);
      return;
    case "validate":
      await runValidate(rest);
      return;
    case "pack":
      await runPack(rest);
      return;
    case "init":
      await runInit(rest);
      return;
    case "link":
      await runLink(rest);
      return;
    case "unlink":
      await runUnlink(rest);
      return;
    case "doctor":
      await runDoctor(rest);
      return;
    case "bundle":
      await runBundleCommand(rest);
      return;
    default:
      throw new Error(
        `未知 skills 命令: ${command ?? "(空)"}\n` +
          "支持：list / search / inspect / install / validate / pack / init / link / unlink / doctor / bundle",
      );
  }
}

// ═══════════════════════════════════════════════════════════════
// HTTP 命令（与 Web 共用 Server Service）
// ═══════════════════════════════════════════════════════════════

async function runList(_args: readonly string[]): Promise<void> {
  const body = await get("/api/skills");
  const skills = Array.isArray(body) ? body : [];
  if (skills.length === 0) {
    console.log("（Catalog 为空：没有已登记 Skill）");
    return;
  }
  const rows = skills.map((skill) => {
    const record = skill as {
      displayName?: string;
      skillId?: string;
      sourceKind?: string;
      sourceId?: string;
      version?: string;
      contentHash?: string;
      status?: { validity?: string; trust?: string; readiness?: string; selection?: string; blockedReason?: string };
    };
    const status = record.status ?? {};
    return {
      name: record.displayName ?? record.skillId ?? "?",
      skillId: record.skillId ?? "?",
      sourceKind: record.sourceKind ?? "?",
      version: record.version ?? "?",
      hash: (record.contentHash ?? "").slice(0, 16),
      validity: status.validity ?? "?",
      trust: status.trust ?? "?",
      readiness: status.readiness ?? "?",
      selection: status.selection ?? "?",
      blockedReason: status.blockedReason ?? "",
    };
  });
  console.table(rows);
  console.log(
    `共 ${rows.length} 个 Skill；readiness: ${countBy(rows, "readiness")}；selection: ${countBy(rows, "selection")}`,
  );
}

async function runSearch(args: readonly string[]): Promise<void> {
  const query = args[0] ?? "";
  if (query === "") {
    throw new Error("缺少搜索词：skills search <query>");
  }
  const scope = flagValue(args, "--scope") ?? "all";
  const body = (await post("/api/skills/search", { query, scope })) as {
    hits?: readonly {
      layer?: string;
      displayName?: string;
      skillId?: string;
      version?: string;
      sourceKind?: string;
      sourceId?: string;
      contentHash?: string;
      readiness?: string;
      bindable?: boolean;
      status?: { selection?: string };
    }[];
    diagnostics?: readonly { code?: string; message?: string }[];
    remote?: { available?: boolean; note?: string };
  };
  console.log(`搜索 "${query}"（scope=${scope}）`);
  for (const hit of body.hits ?? []) {
    const key = `${hit.skillId ?? "?"}@${hit.sourceId ?? "?"}@${hit.version ?? "?"}`;
    console.log(
      `[${hit.layer ?? "?"}] ${hit.displayName ?? hit.skillId ?? "?"}（${key}）` +
        ` readiness=${hit.readiness ?? "?"} bindable=${hit.bindable === true ? "是" : "否"} hash=${(hit.contentHash ?? "").slice(0, 16)}`,
    );
  }
  for (const diagnostic of body.diagnostics ?? []) {
    console.warn(`诊断[${diagnostic.code ?? "?"}]：${diagnostic.message ?? ""}`);
  }
  console.log(
    `命中 ${(body.hits ?? []).length} 项；remote=${body.remote?.available === true ? "可用" : "不可用"}（${body.remote?.note ?? ""}）`,
  );
}

async function runInspect(args: readonly string[]): Promise<void> {
  const sourceRef = args[0];
  requireValue(sourceRef, "source-ref（inspect <source-ref>）");
  const kind = flagValue(args, "--kind") ?? detectInstallKind(sourceRef);
  const result = await post("/api/skills/inspect", { sourceRef, kind });
  console.log(JSON.stringify(result, null, 2));
}

/** 安装：inspect 由 Server 完成；高风险默认显式确认（--yes 跳过）。 */
async function runInstall(args: readonly string[]): Promise<void> {
  const sourceRef = args[0];
  requireValue(sourceRef, "source-ref（install <source-ref>）");
  const kind = flagValue(args, "--kind") ?? detectInstallKind(sourceRef);
  const agentId = flagValue(args, "--agent");
  const sessionId = flagValue(args, "--session");
  const yes = hasFlag(args, "--yes");
  const payload: Record<string, string> = { sourceRef, kind };
  if (agentId !== undefined) payload["agentId"] = agentId;
  if (sessionId !== undefined) payload["sessionId"] = sessionId;

  let attempt = await postInstall(payload);
  if (attempt.status === "confirmation_required") {
    const confirmation = attempt.confirmation;
    const riskList = (attempt.risks ?? []).map((risk: { code?: string }) => risk.code ?? "?").join("、");
    console.log("安装需要用户确认：");
    console.log(`  来源：${sourceRef}（kind=${kind}）`);
    console.log(`  原因：${confirmation?.reason ?? "未知"}`);
    console.log(`  风险标记：${riskList === "" ? "无" : riskList}`);
    console.log(`  令牌过期：${confirmation?.expiresAt ?? "?"}`);
    const token = confirmation?.token;
    if (token === undefined) {
      throw new Error("安装返回 confirmation_required 但缺少令牌（Server 异常），已中止");
    }
    if (!yes) {
      const ok = await confirmPrompt("确认安装该 Skill？[y/N] ");
      if (!ok) {
        console.log("已取消安装（未做任何修改）");
        return;
      }
    }
    const approved = await post(`/api/skills/confirmation/${encodeURIComponent(token)}/approve`, {
      ...(agentId !== undefined ? { agentId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    void approved;
    attempt = await postInstall({ ...payload, confirmationToken: token });
  }
  printInstallResult(attempt);
}

interface InstallAttemptResult {
  readonly status: string;
  readonly skillRef?: unknown;
  readonly operationId?: string;
  readonly agentBinding?: string;
  readonly activationGrant?: string;
  readonly loadHandle?: string | null;
  readonly reasonCode?: string;
  readonly reason?: string;
  readonly confirmation?: { token?: string; reason?: string; expiresAt?: string; riskLevel?: string };
  readonly risks?: readonly { code?: string }[];
}

async function postInstall(payload: Record<string, string>): Promise<InstallAttemptResult> {
  const { status, body } = await requestRaw("POST", "/api/skills/install", payload);
  if (status === 201 || status === 202) {
    return body as InstallAttemptResult;
  }
  const record = body as { message?: string; details?: { reasonCode?: string; reason?: string } };
  const reasonCode = record.details?.reasonCode ?? "skill_operation_failed";
  throw new SkillError(reasonCode as SkillErrorCode, record.details?.reason ?? record.message ?? `安装失败（HTTP ${status}）`);
}

function printInstallResult(result: InstallAttemptResult): void {
  switch (result.status) {
    case "installed":
      console.log("安装完成：");
      console.log(`  skillRef：${JSON.stringify(result.skillRef ?? null)}`);
      console.log(`  operationId：${result.operationId ?? "?"}`);
      console.log(`  agentBinding：${result.agentBinding ?? "unchanged"}`);
      console.log(`  activationGrant：${result.activationGrant ?? "unavailable"}`);
      console.log(`  loadHandle：${result.loadHandle ?? "null"}`);
      return;
    case "rejected":
      throw new SkillError(result.reasonCode as SkillErrorCode, `安装被拒绝：${result.reason ?? "未知原因"}`);
    case "failed":
      throw new SkillError(result.reasonCode as SkillErrorCode, `安装失败：${result.reason ?? "未知原因"}`);
    default:
      throw new Error(`安装结果状态未知：${result.status}`);
  }
}

async function runBundleCommand(args: readonly string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "create":
    case "version": {
      const bundleId = rest[0];
      requireValue(bundleId, "bundleId（bundle create|version <bundleId>）");
      const name = flagValue(rest, "--name");
      requireValue(name, "--name <name>");
      const selection = flagValue(rest, "--selection") ?? "implicit";
      const keys = parseRepeatedValues(rest, "--skill");
      if (keys.length === 0) {
        throw new Error("至少需要一个 --skill <skillRefKey>（可从 skills list 的 skillRefKey 获取）");
      }
      const items: unknown[] = [];
      for (const key of keys) {
        const detail = (await get(`/api/skills/${encodeURIComponent(key)}`)) as { skillRef?: unknown };
        if (detail.skillRef === undefined) {
          throw new Error(`无法从 Catalog 解析 skillRefKey：${key}`);
        }
        items.push({ skillRef: detail.skillRef, selection });
      }
      const url =
        sub === "create"
          ? "/api/skills/bundles"
          : `/api/skills/bundles/${encodeURIComponent(bundleId)}/versions`;
      const body = sub === "create" ? { bundleId, name, items } : { name, items };
      const result = (await post(url, body)) as { status?: string; result?: { status?: string; bundleId?: string; version?: string; contentHash?: string } };
      if (result.status !== "ok") {
        throw new Error(`Bundle 版本化失败：${JSON.stringify(result)}`);
      }
      console.log(
        `${sub === "create" ? "已创建" : "已创建新版本"}：${result.result?.bundleId ?? bundleId}@${result.result?.version ?? "?"}` +
          `（contentHash=${result.result?.contentHash ?? "?"}）`,
      );
      return;
    }
    case "inspect": {
      const bundleId = rest[0];
      requireValue(bundleId, "bundleId（bundle inspect <bundleId>）");
      const version = flagValue(rest, "--version");
      const url = `/api/skills/bundles?bundleId=${encodeURIComponent(bundleId)}`;
      const body = (await get(url)) as { bundles?: readonly { bundleId?: string; name?: string; versions?: readonly { version?: string; contentHash?: string; createdAt?: string; itemCount?: number }[] }[] };
      const entry = (body.bundles ?? []).find((candidate) => candidate.bundleId === bundleId);
      if (entry === undefined) {
        console.log(`（Bundle 不存在：${bundleId}）`);
        return;
      }
      const versions = (entry.versions ?? []).filter(
        (candidate) => version === undefined || candidate.version === version,
      );
      console.log(`Bundle ${entry.bundleId}（${entry.name ?? "?"}）共 ${versions.length} 个版本：`);
      for (const item of versions) {
        console.log(
          `  v${item.version ?? "?"} hash=${(item.contentHash ?? "").slice(0, 16)} items=${item.itemCount ?? 0} created=${item.createdAt ?? "?"}`,
        );
      }
      return;
    }
    default:
      throw new Error(`未知 skills bundle 命令: ${sub ?? "(空)"}（支持：create / version / inspect）`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 纯本地命令（直接复用 T2 validator/hash 与 T8 pack/registry）
// ═══════════════════════════════════════════════════════════════

async function runValidate(args: readonly string[]): Promise<void> {
  const packagePath = args[0];
  requireValue(packagePath, "path（validate <path>）");
  const root = path.resolve(packagePath);
  const version = flagValue(args, "--version");
  const validation = validateSkillPackage({ packageRoot: root, ...(version !== undefined ? { version } : {}) });
  console.log(`校验 ${root}`);
  console.log(`  结果：${validation.ok ? "通过" : "失败"}`);
  console.log(`  内容哈希：${validation.contentHash ?? "（不可用）"}`);
  console.log(`  大小：${validation.sizeBytes} 字节；文件数：${validation.fileCount}`);
  if (validation.manifest !== null) {
    console.log(`  名称：${validation.manifest.name}；兼容等级：${validation.manifest.compatibilityLevel}`);
  }
  const risks = assessPackageRisks(root);
  if (risks.length > 0) {
    console.log("  风险标记：");
    for (const risk of risks) {
      console.log(`    - [${risk.code}] ${risk.message}`);
    }
  }
  for (const warning of validation.warnings) {
    console.warn(`  警告：${warning}`);
  }
  if (!validation.ok) {
    for (const error of validation.errors) {
      console.error(`  错误[${error.reasonCode}]：${error.message}${error.path !== undefined ? `（${error.path}）` : ""}`);
    }
    throw new Error(`Skill 包校验失败（${validation.errors.length} 个错误）`);
  }
}

async function runPack(args: readonly string[]): Promise<void> {
  const packagePath = args[0];
  requireValue(packagePath, "path（pack <path>）");
  const out = flagValue(args, "--out");
  const result = packSkillPackage(path.resolve(packagePath), out);
  console.log("打包完成：");
  console.log(`  输出：${result.zipPath}`);
  console.log(`  内容哈希：${result.contentHash}`);
  console.log(`  大小：${result.sizeBytes} 字节；文件数：${result.fileCount}`);
  console.log(`  skillId：${result.skillId}；version：${result.version}`);
}

async function runInit(args: readonly string[]): Promise<void> {
  const name = args[0];
  requireValue(name, "name（init <name>）");
  const root = path.join(process.cwd(), sanitizeDirName(name));
  if (fs.existsSync(root)) {
    throw new Error(`目录已存在：${root}`);
  }
  fs.mkdirSync(path.join(root, "references"), { recursive: true });
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), INIT_SKILL_TEMPLATE(name), "utf8");
  console.log(`已创建 Skill 目录：${root}`);
  console.log("下一步：");
  console.log("  1. 编辑 SKILL.md 的 description（会进入系统提示）与正文");
  console.log("  2. skills validate <dir>  校验包结构");
  console.log("  3. skills link <dir>      接入 Linked Source（修改后下一 turn 生效）");
  console.log("  4. skills pack <dir>      生成可分发的 .skill 包");
}

async function runLink(args: readonly string[]): Promise<void> {
  const sourcePath = args[0];
  requireValue(sourcePath, "path（link <path>）");
  const registry = new LinkedSourceRegistry(getRuntimePaths());
  const status = registry.register(path.resolve(sourcePath));
  console.log(`已登记 Linked Source：${status.sourceId}`);
  console.log(`  路径：${status.rootPath}`);
  console.log(`  状态：${status.valid ? "有效" : "无效"}；内容哈希：${status.contentHash ?? "（不可用）"}`);
  console.log("Linked Source 是只读引用，不复制到 Managed Store；修改文件后下一 turn 重新哈希生效。");
}

async function runUnlink(args: readonly string[]): Promise<void> {
  const sourceId = args[0];
  requireValue(sourceId, "source-id（unlink <source-id>）");
  const registry = new LinkedSourceRegistry(getRuntimePaths());
  const removed = registry.unregister(sourceId);
  console.log(`已注销 Linked Source：${removed.sourceId}（${removed.rootPath}）`);
}

async function runDoctor(_args: readonly string[]): Promise<void> {
  const paths = getRuntimePaths();
  console.log("=== Skill 本地状态 ===");
  console.log(`OPENCOLORFUL_HOME：${paths.home}`);
  const trustStore = new SkillSourceTrustStore(paths);
  const config = trustStore.load();
  console.log(`来源信任配置（${paths.skillSources}）：`);
  console.log(`  信任根：${config.trustedRoots.length === 0 ? "（无）" : config.trustedRoots.join("; ")}`);
  console.log(`  显式关闭的 kind：${config.disabledKinds.length === 0 ? "（无）" : config.disabledKinds.join(", ")}`);
  console.log(`  精确来源信任：${Object.keys(config.trustedSourceIds).length} 项`);
  console.log("兼容目录（默认关闭，需显式信任根目录后才扫描）：");
  for (const root of workspaceCompatibilityRoots(process.cwd(), paths.home)) {
    const trusted = config.trustedRoots.some((candidate) => isWithin(root, candidate));
    console.log(`  ${trusted ? "[已信任]" : "[未信任]"} ${root}`);
  }
  const registry = new LinkedSourceRegistry(paths);
  const linked = registry.list();
  console.log(`Linked Sources（${linked.length}）：`);
  for (const entry of linked) {
    console.log(
      `  ${entry.sourceId} ${entry.valid ? "有效" : "无效"} hash=${entry.contentHash ?? "?"} ${entry.rootPath}` +
        (entry.errors.length > 0 ? ` 错误：${entry.errors.join("; ")}` : ""),
    );
  }

  console.log("\n=== Server 诊断（HTTP）===");
  let catalog: unknown[];
  try {
    const body = await get("/api/skills");
    catalog = Array.isArray(body) ? body : [];
  } catch (error) {
    console.log(`Server 不可达或未接线（HTTP 诊断跳过）：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const byKind = new Map<string, number>();
  const byReadiness = new Map<string, number>();
  const shadowed: string[] = [];
  for (const skill of catalog) {
    const record = skill as {
      sourceKind?: string;
      status?: { readiness?: string; selection?: string; blockedReason?: string };
      displayName?: string;
      skillId?: string;
    };
    byKind.set(record.sourceKind ?? "?", (byKind.get(record.sourceKind ?? "?") ?? 0) + 1);
    const readiness = record.status?.readiness ?? "?";
    byReadiness.set(readiness, (byReadiness.get(readiness) ?? 0) + 1);
    if (record.status?.selection === "shadowed") {
      shadowed.push(record.displayName ?? record.skillId ?? "?");
    }
    if (record.status?.readiness === "blocked" || record.status?.readiness === "incompatible") {
      console.warn(
        `  [${record.status.readiness}] ${record.displayName ?? record.skillId ?? "?"}：${record.status.blockedReason ?? "无原因"}`,
      );
    }
  }
  console.log(`Catalog 共 ${catalog.length} 项：`);
  console.log(`  按来源：${Array.from(byKind.entries()).map(([kind, count]) => `${kind}=${count}`).join(", ")}`);
  console.log(`  按 readiness：${Array.from(byReadiness.entries()).map(([kind, count]) => `${kind}=${count}`).join(", ")}`);
  console.log(`  shadowed：${shadowed.length === 0 ? "无" : shadowed.join(", ")}`);

  try {
    const search = (await post("/api/skills/search", { query: "", scope: "all" })) as {
      diagnostics?: readonly { code?: string; message?: string }[];
    };
    for (const diagnostic of search.diagnostics ?? []) {
      console.warn(`  搜索诊断[${diagnostic.code ?? "?"}]：${diagnostic.message ?? ""}`);
    }
  } catch (error) {
    console.log(`  搜索诊断不可用：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const agents = (await get("/api/agents")) as readonly { id?: string; identity?: { name?: string } }[];
    console.log(`Agent 绑定诊断（${agents.length} 个 Agent）：`);
    for (const agent of agents) {
      const agentId = agent.id ?? "";
      const view = (await get(`/api/agents/${encodeURIComponent(agentId)}/skills`)) as {
        view?: {
          visible?: unknown[];
          shadowed?: unknown[];
          disabled?: unknown[];
          gated?: unknown[];
          learningPolicy?: string;
          bundleBindings?: unknown[];
        };
      };
      const skillsView = view.view;
      if (skillsView === undefined) {
        console.log(`  ${agent.identity?.name ?? agentId}：视图不可用`);
        continue;
      }
      console.log(
        `  ${agent.identity?.name ?? agentId}：可见=${(skillsView.visible ?? []).length} shadowed=${(skillsView.shadowed ?? []).length} ` +
          `disabled=${(skillsView.disabled ?? []).length} gated=${(skillsView.gated ?? []).length} ` +
          `policy=${skillsView.learningPolicy ?? "?"} bundles=${(skillsView.bundleBindings ?? []).length}`,
      );
      for (const gated of skillsView.gated ?? []) {
        const item = gated as { displayName?: string; blockedReason?: string };
        console.warn(`    [gated] ${item.displayName ?? "?"}：${item.blockedReason ?? "无原因"}`);
      }
    }
  } catch (error) {
    console.log(`Agent 绑定诊断不可用（${error instanceof Error ? error.message : String(error)}）`);
  }
  console.log("\ndoctor 完成（本地与 Server 诊断；完整状态以 /logs 事件为准）");
}

// ═══════════════════════════════════════════════════════════════
// Server HTTP 客户端（复用 plugins.ts 模式；未接线时明确错误）
// ═══════════════════════════════════════════════════════════════

function baseUrl(): string {
  const environment = loadEnvironment();
  return `http://${environment.host}:${environment.port}`;
}

interface HttpEnvelope {
  readonly status: number;
  readonly body: unknown;
}

async function requestRaw(method: string, pathName: string, body?: unknown): Promise<HttpEnvelope> {
  const url = `${baseUrl()}${pathName}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接 Server（${url}）：${reason}\n请先启动 server（ocf server start）`);
  }
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    parsed = { message: response.statusText };
  }
  return { status: response.status, body: parsed };
}

async function get(pathName: string): Promise<unknown> {
  const { status, body } = await requestRaw("GET", pathName);
  if (!isOk(status)) {
    throw httpError(status, body, pathName);
  }
  return body;
}

async function post(pathName: string, body: unknown): Promise<unknown> {
  const envelope = await requestRaw("POST", pathName, body);
  if (!isOk(envelope.status)) {
    throw httpError(envelope.status, envelope.body, pathName);
  }
  return envelope.body;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function httpError(status: number, body: unknown, pathName: string): Error {
  if (status === 404 || status === 405 || status === 502 || status === 503) {
    return new Error(
      `Server 的 Skill 端点未接线（HTTP ${status}）：${pathName}\n` +
        "请确认组合根已注入 skillCoreService / skillAdminService 后重启 server。",
    );
  }
  const record = body as { message?: string; details?: { reasonCode?: string; reason?: string } };
  const message = record.details?.reason ?? record.message ?? `HTTP ${status}`;
  const reasonCode = record.details?.reasonCode;
  if (reasonCode !== undefined) {
    return new SkillError(reasonCode as SkillErrorCode, message);
  }
  return new Error(`HTTP ${status}：${message}`);
}

// ═══════════════════════════════════════════════════════════════
// 参数解析与交互
// ═══════════════════════════════════════════════════════════════

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function parseRepeatedValues(args: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        values.push(value);
      }
    }
  }
  return values;
}

function requireValue(value: string | undefined, what: string): asserts value is string {
  if (value === undefined || value === "") {
    throw new Error(`缺少必填参数：${what}`);
  }
}

/** 来源 kind 推断（仅输入归一化；Server 仍会完整校验）。 */
function detectInstallKind(sourceRef: string): "local" | "archive" | "git" | "http" {
  const lower = sourceRef.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return "http";
  }
  if (lower.startsWith("git://") || lower.startsWith("ssh://") || lower.endsWith(".git")) {
    return "git";
  }
  if (lower.endsWith(".zip") || lower.endsWith(".skill")) {
    return "archive";
  }
  return "local";
}

async function confirmPrompt(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new Error("非交互终端：请使用 --yes 显式确认高风险安装");
  }
  const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await interface_.question(question);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    interface_.close();
  }
}

function sanitizeDirName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    throw new Error(`目录名不合法：${name}`);
  }
  return cleaned.slice(0, 128);
}

function countBy(rows: readonly { readiness: string; selection: string }[], field: "readiness" | "selection"): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row[field];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([value, count]) => `${value}=${count}`).join(", ") || "（无）";
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ── init 模板 ──────────────────────────────────────────────────

function INIT_SKILL_TEMPLATE(name: string): string {
  return `---
name: ${name}
description: ${name} 的工作方法（一句话说明它做什么、适合什么场景）。
version: 0.1.0
license: MIT
metadata:
  opencolorful:
    version: 1
    requires:
      os: [win32, darwin, linux]
    risk: low
---

# ${name}

（在这里描述完整工作流程。正文不会常驻注入：模型先看到 name/description，
需要时再读取本文件与 references/ 下的资料。）

## 使用步骤

1. 第一步
2. 第二步
3. 输出结果

## 参考资料

- \`references/\`：按需读取的详细资料；
- \`templates/\`：输出骨架与模板；
- Skill 不授予任何工具/网络/Secret 权限；脚本类工作必须依赖既有的
  Sandbox/工具入口，安装器不会执行任何来源脚本。
`;
}
