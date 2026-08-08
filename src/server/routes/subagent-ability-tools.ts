import fs from "node:fs";
import path from "node:path";

import type { ToolPolicy } from "../../runtime/tool-policy.js";
import type { EffectiveSnapshot } from "../../runtime/subagents/delegation-policy.js";
import type { SubagentSessionToolDef, SubagentToolInvokeResult } from "../../runtime/subagents/runtime/types.js";
import { skillRefKey, type SkillRef } from "../../contracts/skill-protocol.js";
import type { SkillCoreService } from "../../runtime/skills/core/skill-core-service.js";
import type { SkillFileReadOutcome } from "../../pi-sdk/types.js";
import type { WorkspaceLeaseStore } from "../../runtime/subagents/stores/index.js";

// ═══════════════════════════════════════════════════════════════
// Phase 14 复审 P0-2/P0-3：Subagent 能力工具的目录与 run-scoped 执行器
// （plans/phase-14.md §12.1 / §12.4 / §12.6 / §12.7；必须项 #12/#13）
//
// 复审结论要求：
// - Snapshot.toolIds 必须全部可解析为工具定义，缺定义 → spawn fail-closed，
//   不允许静默 filter 缩减（快照声称的能力 Session 必须有）；
// - 文件工具（read/grep/find/ls/write/edit）经 Phase 9 Sandbox（ToolPolicy
//   PathGuard，按 Thread 冻结的 workspaceCwd 解析）执行；write/edit 额外
//   校验 run 持有的独占写 Lease（§18.3），绝不与父 Agent 静默并发写；
// - Skill 元数据/正文经 Phase 13 SkillCoreService/SkillContentService 受控
//   读取，按 run 冻结快照（spawn 时父 turn 可见集）校验，当前 Run 中变化
//   不生效（readSkillFileForSubagentRun 的 turn 冻结门）；
// - 插件工具使用 spawn 时冻结的 PluginExecutionSnapshot（version/
//   runtimeInstanceId/grantRevision 真实值），执行不再现场重新冻结——
//   活动 Run 的权限/实例不漂移（P0-2）。
//
// bash 与父会话一致（Sandbox allowBash=false）不在委派清单：父 Agent 的
// bash 本就不可执行，不属于"有效能力"，parentSnapshot 已过滤。
// ═══════════════════════════════════════════════════════════════

// ── 文件工具定义（模型可见 schema；执行在 run-scoped executor）────

export const SUBAGENT_FILE_TOOL_DEFS: readonly SubagentSessionToolDef[] = [
  {
    name: "read",
    description: "读取工作区内文件内容（沙箱路径校验；Skill 文件经受控读取）。",
    parameters: { type: "object", properties: { path: { type: "string", description: "工作区相对或绝对路径" } }, required: ["path"] },
  },
  {
    name: "grep",
    description: "在工作区内按正则搜索文件内容。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "搜索起始路径（工作区内）" },
        glob: { type: "string" },
      },
      required: ["pattern", "path"],
    },
  },
  {
    name: "find",
    description: "在工作区内按名称/glob 查找文件。",
    parameters: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" } }, required: ["path"] },
  },
  {
    name: "ls",
    description: "列出工作区内目录内容。",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write",
    description: "写入/覆盖工作区内文件（需要 write 工作区访问与独占写 Lease）。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "替换工作区内文件中的一段文本（需要 write 工作区访问与独占写 Lease）。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
      required: ["path", "oldString", "newString"],
    },
  },
];

/** read/grep/find/ls 工具（workspace-read 类） */
export const SUBAGENT_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
/** write/edit 工具（workspace-write 类） */
export const SUBAGENT_WRITE_TOOL_NAMES = ["write", "edit"] as const;

export function isSubagentFileToolName(name: string): boolean {
  return SUBAGENT_FILE_TOOL_DEFS.some((def) => def.name === name);
}

// ── run-scoped 执行器构建 ───────────────────────────────────────

export interface SubagentFrozenPluginContribution {
  /** spawn 时冻结的完整执行快照（PluginExecutionSnapshot）与授权状态 */
  readonly snapshot: unknown;
  readonly state: unknown;
}

export interface BuildSubagentRunToolExecutorInput {
  readonly workspaceCwd: string;
  readonly ownerAgentId: string;
  readonly sessionId: string;
  readonly runId: string;
  /** Run 的 EffectiveSnapshot（spawn 时冻结；能力目录与执行边界） */
  readonly snapshot: EffectiveSnapshot;
  /** spawn 时父 turnId（Skill 受控读取的 turn 冻结门；无 turn 上下文为 null） */
  readonly spawnTurnId: string | null;
  /** spawn 时冻结的插件执行快照（contributionId → frozen） */
  readonly frozenPlugins: ReadonlyMap<string, SubagentFrozenPluginContribution>;
  /** 插件工具执行端口（生产：PluginFacade.hostApi.tools.invoke；测试注入 Faux） */
  readonly pluginInvoke: (input: {
    readonly pluginId: string;
    readonly contributionId: string;
    readonly params: unknown;
    readonly agentId: string;
    readonly sessionId: string;
    readonly snapshot: unknown;
    readonly state: unknown;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly ok: boolean; readonly code?: string; readonly message?: string; readonly result?: unknown }>;
  /** 工作区写 Lease 存储（校验 run 独占持有；缺省 → 写工具不可用 fail-closed） */
  readonly leases?: WorkspaceLeaseStore;
  /** Phase 9 沙箱策略（PathGuard 按 workspaceCwd 构造；缺省 → 文件工具不可用） */
  readonly toolPolicy?: ToolPolicy;
  /** Phase 13 Skill 受控读取（SkillCoreService；缺省 → Skill 工具不可用 fail-closed） */
  readonly skillCore?: SkillCoreService;
  /** 读文件大小上限（字节，缺省 256KB；超出截断并标记） */
  readonly maxReadBytes?: number;
}

export type SubagentRunToolExecutor = (input: {
  readonly name: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
}) => Promise<SubagentToolInvokeResult>;

/**
 * 构建 run-scoped 能力工具执行器（P0-2/P0-3）。快照与执行闭包绑定：
 * - 插件工具 → 消费 spawn 时冻结快照（version/instance/grantRevision 不再漂移）；
 * - 文件工具 → ToolPolicy 沙箱校验 + write/edit 独占写 Lease 校验；
 * - Skill 工具 → 只暴露 run 冻结快照内的 Skill，正文经 SkillCoreService 受控读取。
 */
export function buildSubagentRunToolExecutor(input: BuildSubagentRunToolExecutorInput): SubagentRunToolExecutor {
  const { workspaceCwd, ownerAgentId, sessionId, runId, snapshot, spawnTurnId, frozenPlugins } = input;
  const skillRefKeys = new Set(snapshot.skills.map((entry) => skillRefKey(entry.ref)));

  return async (call): Promise<SubagentToolInvokeResult> => {
    // ── 插件工具（P0-2：冻结快照执行）─────────────────────────
    const pluginContribution = snapshot.pluginContributions.find((entry) => entry.contributionId === call.name);
    if (pluginContribution !== undefined) {
      const frozen = frozenPlugins.get(call.name);
      if (frozen === undefined) {
        return { ok: false, text: `subagent_plugin_snapshot_missing: 插件贡献 ${call.name} 的冻结快照缺失（fail-closed）` };
      }
      try {
        const result = await input.pluginInvoke({
          pluginId: pluginContribution.pluginId,
          contributionId: pluginContribution.contributionId,
          params: call.args,
          agentId: ownerAgentId,
          sessionId,
          snapshot: frozen.snapshot,
          state: frozen.state,
          ...(call.signal !== undefined ? { signal: call.signal } : {}),
        });
        return result.ok
          ? { ok: true, text: JSON.stringify(result.result) }
          : { ok: false, text: `${result.code ?? "subagent_plugin_invoke_rejected"}: ${result.message ?? "unknown"}` };
      } catch (error) {
        return { ok: false, text: `subagent_operation_failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}` };
      }
    }

    // ── Skill 工具（P0-3：run 快照门 + SkillCoreService 受控读取）─
    if (call.name === "search_skills" || call.name === "inspect_skill") {
      return executeSkillTool(input, call, skillRefKeys);
    }

    // ── 文件工具（P0-3：Sandbox + 写 Lease）───────────────────
    if (isSubagentFileToolName(call.name)) {
      return executeFileTool(input, call);
    }

    return { ok: false, text: `subagent_ability_tool_unavailable: 快照中不存在工具 ${call.name}` };
  };
}

// ── Skill 工具执行（run 冻结快照门）─────────────────────────────

async function executeSkillTool(
  input: BuildSubagentRunToolExecutorInput,
  call: { readonly name: string; readonly args: unknown },
  skillRefKeys: Set<string>,
): Promise<SubagentToolInvokeResult> {
  const skillCore = input.skillCore;
  if (skillCore === undefined) {
    return { ok: false, text: "subagent_skill_unavailable: Skill 服务未就绪（fail-closed）" };
  }
  const args = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>;

  if (call.name === "search_skills") {
    const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const scope = typeof args.scope === "string" ? args.scope : undefined;
    const hits = [];
    for (const entry of input.snapshot.skills) {
      if (scope !== undefined && entry.sourceKind !== scope) {
        continue;
      }
      const view = skillCore.getSkillDetail(skillRefKey(entry.ref));
      if (view === null) {
        continue;
      }
      if (query.length > 0) {
        const haystack = `${view.displayName} ${view.description ?? ""} ${view.skillId}`.toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }
      }
      hits.push({
        layer: "bound",
        sourceKind: entry.sourceKind,
        skillId: view.skillId,
        skillRefKey: skillRefKey(entry.ref),
        skillRef: entry.ref,
        displayName: view.displayName,
        ...(view.description !== undefined ? { description: view.description } : {}),
        version: view.version,
        contentHash: entry.contentHash,
        status: "ready",
      });
    }
    return { ok: true, text: JSON.stringify({ query: args.query ?? "", scope: scope ?? null, hits }) };
  }

  // inspect_skill：只允许 run 快照内的 Skill
  const rawRef = args.skillRef;
  const ref: SkillRef | null =
    typeof rawRef === "object" && rawRef !== null
      ? (rawRef as SkillRef)
      : null;
  if (ref === null) {
    return { ok: false, text: "subagent_skill_not_in_snapshot: 缺少 skillRef" };
  }
  const refKey = skillRefKey(ref);
  if (!skillRefKeys.has(refKey)) {
    return { ok: false, text: `subagent_skill_not_in_snapshot: Skill ${refKey} 不在本 Run 冻结快照内（fail-closed）` };
  }
  const view = skillCore.getSkillDetail(refKey);
  if (view === null) {
    return { ok: false, text: `subagent_skill_not_found: Skill ${refKey} 已不可解析` };
  }
  const output: Record<string, unknown> = {
    skillRefKey: refKey,
    skillRef: view.skillRef,
    displayName: view.displayName,
    ...(view.description !== undefined ? { description: view.description } : {}),
    version: view.version,
    sourceKind: view.sourceKind,
    contentHash: view.contentHash,
    status: view.status,
  };
  if (args.readBody === true) {
    // SKILL.md 正文经 SkillCoreService 受控读取（run 冻结快照成员 + 哈希 +
    // 预算校验；父 Session 换 turn 后 denied，fail-closed 不回退裸读）
    const outcome = await skillCore.readSkillBodyForSubagentRun({
      sessionId: input.sessionId,
      spawnTurnId: input.spawnTurnId,
      skillRef: ref,
      relativePath: "SKILL.md",
    });
    if (outcome.status === "ok") {
      output.body = outcome.body;
      output.truncated = outcome.truncated;
    } else if (outcome.status === "denied") {
      return { ok: false, text: `subagent_skill_read_denied: ${outcome.reasonCode}: ${outcome.reason}` };
    }
    // not-a-skill-file：正文不可得（Skill 系统未接入）→ 只返回元数据
  }
  return { ok: true, text: JSON.stringify(output) };
}

// ── 文件工具执行（Sandbox + 写 Lease）──────────────────────────

async function executeFileTool(
  input: BuildSubagentRunToolExecutorInput,
  call: { readonly name: string; readonly args: unknown; readonly signal?: AbortSignal },
): Promise<SubagentToolInvokeResult> {
  const policy = input.toolPolicy;
  if (policy === undefined) {
    return { ok: false, text: "subagent_sandbox_unavailable: 沙箱策略未就绪（fail-closed）" };
  }
  const args = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>;
  const rawPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
  const absPath = path.resolve(input.workspaceCwd, rawPath);

  try {
    if (call.name === "read") {
      // Skill 文件优先走受控读取（P0-3：哈希/预算/审计；denied 不回退裸读）
      if (input.skillCore !== undefined && input.snapshot.skills.length > 0) {
        const outcome: SkillFileReadOutcome = await input.skillCore.readSkillFileForSubagentRun({
          sessionId: input.sessionId,
          spawnTurnId: input.spawnTurnId,
          absPath,
        });
        if (outcome.status === "ok") {
          return { ok: true, text: outcome.body };
        }
        if (outcome.status === "denied") {
          return { ok: false, text: `subagent_skill_read_denied: ${outcome.reasonCode}: ${outcome.reason}` };
        }
      }
      policy.assertFilePath("read", absPath);
      const content = await readFileCapped(absPath, input.maxReadBytes ?? 256 * 1024);
      return { ok: true, text: content.text };
    }

    if (call.name === "ls") {
      policy.assertFilePath("read", absPath);
      const entries = await fs.promises.readdir(absPath, { withFileTypes: true });
      const lines = entries.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`).sort();
      return { ok: true, text: lines.join("\n") };
    }

    if (call.name === "find") {
      policy.assertFilePath("read", absPath);
      const glob = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : null;
      const out: string[] = [];
      await walk(absPath, (file) => {
        if (glob === null || globMatches(file, glob)) {
          out.push(file);
        }
      });
      return { ok: true, text: out.slice(0, 500).join("\n") };
    }

    if (call.name === "grep") {
      policy.assertFilePath("read", absPath);
      const pattern = typeof args.pattern === "string" ? args.pattern : null;
      if (pattern === null) {
        return { ok: false, text: "subagent_invalid_args: grep 缺少 pattern" };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (error) {
        return { ok: false, text: `subagent_invalid_args: 非法正则：${error instanceof Error ? error.message.slice(0, 120) : "unknown"}` };
      }
      const hits: string[] = [];
      const rootStat = await fs.promises.stat(absPath).catch(() => null);
      const files = rootStat !== null && rootStat.isDirectory() ? [] : [absPath];
      if (rootStat !== null && rootStat.isDirectory()) {
        await walk(absPath, (file) => {
          files.push(file);
        });
      }
      for (const file of files.slice(0, 200)) {
        const content = await readFileCapped(file, 512 * 1024).catch(() => null);
        if (content === null) {
          continue;
        }
        const lines = content.text.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (line !== undefined && regex.test(line)) {
            hits.push(`${path.relative(input.workspaceCwd, file)}:${i + 1}:${line.slice(0, 300)}`);
          }
        }
      }
      return { ok: true, text: hits.slice(0, 200).join("\n") || "(无匹配)" };
    }

    if (call.name === "write" || call.name === "edit") {
      // write 类：工作区访问必须是 write（防御：read Run 快照不应含 write 工具）
      if (input.snapshot.workspaceAccess !== "write") {
        return { ok: false, text: `subagent_write_denied: 本 Run 工作区访问为 ${input.snapshot.workspaceAccess}，写操作被拒绝（fail-closed）` };
      }
      // 独占写 Lease 校验（§18.3）：必须由本 Run（subagent_write）持有——
      // 父 Agent 写 permit 占用或 Lease 丢失 → fail-closed，绝不静默并发写
      if (!verifyRunWriteLease(input)) {
        return { ok: false, text: "subagent_write_lease_missing: 本 Run 未持有工作区独占写 Lease，写操作被拒绝（fail-closed）" };
      }
      policy.assertFilePath("write", absPath);
      if (call.name === "write") {
        const content = typeof args.content === "string" ? args.content : null;
        if (content === null) {
          return { ok: false, text: "subagent_invalid_args: write 缺少 content" };
        }
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        await fs.promises.writeFile(absPath, content, "utf8");
        return { ok: true, text: `已写入 ${path.relative(input.workspaceCwd, absPath) || absPath}` };
      }
      const oldString = typeof args.oldString === "string" ? args.oldString : null;
      const newString = typeof args.newString === "string" ? args.newString : null;
      if (oldString === null || newString === null) {
        return { ok: false, text: "subagent_invalid_args: edit 缺少 oldString/newString" };
      }
      const existing = await fs.promises.readFile(absPath, "utf8");
      if (!existing.includes(oldString)) {
        return { ok: false, text: "subagent_edit_not_found: oldString 在文件中不存在" };
      }
      await fs.promises.writeFile(absPath, existing.replace(oldString, newString), "utf8");
      return { ok: true, text: `已编辑 ${path.relative(input.workspaceCwd, absPath) || absPath}` };
    }

    return { ok: false, text: `subagent_ability_tool_unavailable: 文件工具 ${call.name} 未实现` };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "unknown";
    return { ok: false, text: message.startsWith("Sandbox") || message.includes("拒绝") ? message : `subagent_operation_failed: ${message}` };
  }
}

/** 写 Lease 校验：当前有效 lease 必须由本 run（subagent_write）持有 */
function verifyRunWriteLease(input: BuildSubagentRunToolExecutorInput): boolean {
  const leases = input.leases;
  if (leases === undefined) {
    return false;
  }
  const lease = leases.get(input.workspaceCwd);
  if (lease === null) {
    return false;
  }
  return lease.leaseKind === "subagent_write" && lease.ownerId === input.runId;
}

async function readFileCapped(absPath: string, maxBytes: number): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const handle = await fs.promises.open(absPath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    const text = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    return { text: truncated ? `${text}\n…（超出 ${maxBytes} 字节上限，已截断）` : text, truncated };
  } finally {
    await handle.close();
  }
}

async function walk(root: string, onFile: (file: string) => void | Promise<void>): Promise<void> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

/** 简单 glob（* 通配）：文件/目录名的后缀/包含匹配 */
function globMatches(relPath: string, glob: string): boolean {
  const name = path.basename(relPath);
  if (!glob.includes("*")) {
    return name === glob;
  }
  const parts = glob.split("*");
  const head = parts[0] ?? "";
  const tail = parts[parts.length - 1] ?? "";
  return name.startsWith(head) && name.endsWith(tail);
}
