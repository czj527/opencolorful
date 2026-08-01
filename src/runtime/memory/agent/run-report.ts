import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeSensitiveText } from "../../sanitize.js";
import type { MemoryMutationProposal } from "../../../contracts/memory.js";
export interface RunReportInput {
  runId: string; agentId: string; agentsDir: string; batchIds: readonly string[];
  proposals: readonly MemoryMutationProposal[]; iterations: number; status: string; reason?: string;
  startedAt: string; completedAt: string; tokenEstimate: number; issues: readonly string[];
  /** report_run 工具的整理总结（脱敏） */ report?: { summary: string; issues: readonly string[] };
  /** 输入快照：运行前 batch revision 与 pending intent 数 */ inputSnapshot?: { batches: Array<{ id: string; revision: Record<string, unknown> }>; pendingIntents: number };
}
export async function writeMemoryRunReport(input: RunReportInput): Promise<{ error?: string }> {
  const dir = path.join(input.agentsDir, input.agentId, "memory", "runs", input.runId);
  try {
    await fs.mkdir(dir, { recursive: true });
    const json = {
      runId: input.runId,
      batches: input.batchIds,
      proposals: input.proposals.map((p) => ({ id: p.id, type: p.type, targetId: p.targetId, status: p.status })),
      iterations: input.iterations,
      status: input.status,
      ...(input.reason ? { reason: sanitizeSensitiveText(input.reason) } : {}),
      ...(input.report !== undefined ? { report: { summary: sanitizeSensitiveText(input.report.summary, 2000), issues: input.report.issues.map((x) => sanitizeSensitiveText(x, 500)) } } : {}),
      ...(input.inputSnapshot !== undefined ? { inputSnapshot: input.inputSnapshot } : {}),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    };
    await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(json, null, 2), "utf8");
    const lines = [
      "# 记忆整理运行报告",
      `状态：${input.status}`,
      `批次：${input.batchIds.join(", ") || "无"}`,
      `迭代：${input.iterations}，预算估算：${input.tokenEstimate} tokens`,
      ...(input.report !== undefined ? ["", "## 整理总结", `- ${sanitizeSensitiveText(input.report.summary, 2000)}`, ...input.report.issues.map((x) => `- 遗留：${sanitizeSensitiveText(x, 500)}`)] : []),
      "", "## 提案",
      ...input.proposals.map((p) => `- ${p.type} ${p.targetId ?? ""}：${sanitizeSensitiveText(p.reason, 500)}`),
      "", "## 未解决问题",
      ...input.issues.map((x) => `- ${sanitizeSensitiveText(x, 500)}`),
    ];
    await fs.writeFile(path.join(dir, "REPORT.md"), lines.join("\n"), "utf8");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "运行报告写入失败" };
  }
}
