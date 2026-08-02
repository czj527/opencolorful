import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  MEMORY_DAILY_STEPS,
  MEMORY_MD_EMPTY_PLACEHOLDER,
  MEMORY_MD_SECTION_TITLES,
  type MemoryDailyStep,
} from "../../contracts/memory.js";
import { SessionSummaryStore } from "../../storage/memory/summary-store.js";
import { MemoryDailyStateStore, MemoryWatermarkStore } from "../../storage/memory/recovery-store.js";
import { sanitizeSensitiveText } from "../sanitize.js";
import { instrument } from "../../observability/instrument.js";
import { extractSummarySection } from "./summary-format.js";
import {
  atomicWriteFile,
  deleteDailyFile,
  ensureMemoryDir,
  getLogicalDate,
  listDailyFiles,
  readSectionFile,
  writeDailyFile,
} from "./memory-files.js";
import { buildDailyPrompt, buildFactsPrompt, buildLongtermPrompt, buildTodayPrompt } from "./compile-prompts.js";

export interface CompleteMemoryTextInput { systemPrompt: string; prompt: string; maxTokens: number }
export type CompleteMemoryText = (input: CompleteMemoryTextInput) => Promise<string>;
export interface MemoryCompilePipelineDeps {
  summaryStore: SessionSummaryStore;
  dailyStateStore: MemoryDailyStateStore;
  watermarkStore: MemoryWatermarkStore;
  completeText?: CompleteMemoryText;
  now?: () => Date;
}
export interface MemoryCompileResult {
  date: string;
  revision: string;
  degraded: boolean;
  completed: MemoryDailyStep[];
  failures: Array<{ step: MemoryDailyStep; error: string }>;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}
function safe(text: string, max = 4000): string { return sanitizeSensitiveText(text, max).trim(); }
function summariesText(store: SessionSummaryStore, agentId: string, date?: string): string {
  return store
    .listByAgent(agentId)
    .filter((summary) => date === undefined || summary.updatedAt.startsWith(date))
    .map((summary) => summary.summary)
    .filter(Boolean)
    .join("\n\n");
}

export class MemoryCompilePipeline {
  constructor(private readonly deps: MemoryCompilePipelineDeps) {}

  async runDaily(agentId: string, memoryDir: string, logicalDate?: string, forceSteps: readonly MemoryDailyStep[] = []): Promise<MemoryCompileResult> {
    // Phase 11 T5：一次每日编译 = 一个 operation（后台 trace 由调用方 runAsBackground 提供）
    const date = logicalDate ?? getLogicalDate(this.deps.now?.());
    const lifecycle = instrument.startLifecycle({
      startEventName: "memory.compile.started",
      actor: { kind: "scheduler", id: "memory-ticker" },
      executor: { kind: "memory_agent", id: agentId },
      scope: { ownerAgentId: agentId },
      operationId: `compile-${agentId}-${date}-${randomUUID().slice(0, 8)}`,
      terminals: {
        completed: "memory.compile.completed",
        failed: "memory.compile.failed",
      },
      startPayload: { attributes: { date, forceSteps: forceSteps.join(",") } },
    });
    const result = await this.runDailyInner(agentId, memoryDir, date, forceSteps);
    if (result.failures.length > 0) {
      lifecycle.fail(`${result.failures.length} 个步骤失败`, {
        attributes: { steps: result.failures.map((f) => f.step) },
      });
    } else {
      lifecycle.complete({
        attributes: { date: result.date, revision: result.revision, degraded: result.degraded },
      });
    }
    return result;
  }

  private async runDailyInner(agentId: string, memoryDir: string, date: string, forceSteps: readonly MemoryDailyStep[]): Promise<MemoryCompileResult> {
    const forced = (step: MemoryDailyStep): boolean => forceSteps.includes(step);
    await ensureMemoryDir(memoryDir);
    const completed: MemoryDailyStep[] = [];
    const failures: Array<{ step: MemoryDailyStep; error: string }> = [];
    let degraded = false;
    const done = (step: MemoryDailyStep): boolean => this.deps.dailyStateStore.isStepDone(agentId, date, step);
    const finish = (step: MemoryDailyStep): void => { this.deps.dailyStateStore.markStepDone(agentId, date, step); completed.push(step); };
    const fail = (step: MemoryDailyStep, error: unknown): void => {
      degraded = true; failures.push({ step, error: error instanceof Error ? error.message : String(error) });
      this.deps.watermarkStore.upsert(agentId, "markdown", "", { date, step }, true);
    };
    const runLlm = async (request: { systemPrompt: string; prompt: string; maxTokens: number }): Promise<string> => {
      if (this.deps.completeText === undefined) throw new Error("LLM unavailable");
      return safe(await this.deps.completeText(request), 4000);
    };
    const allSummaries = summariesText(this.deps.summaryStore, agentId);
    const todaySummaries = summariesText(this.deps.summaryStore, agentId, date);
    const yesterdaySummaries = summariesText(this.deps.summaryStore, agentId, shiftDate(date, -1));

    if (!done("S0") || forced("S0")) {
      try {
        const yesterday = shiftDate(date, -1);
        const prior = await readSectionFile(memoryDir, "today.md");
        const body = await runLlm({ ...buildDailyPrompt({ date: yesterday, yesterday: prior, summaries: yesterdaySummaries }), maxTokens: 180 });
        await writeDailyFile(memoryDir, yesterday, body);
        finish("S0");
      } catch (error) { fail("S0", error); }
    }
    if (!done("S1") || forced("S1")) {
      try {
        const body = await runLlm({ ...buildTodayPrompt(todaySummaries), maxTokens: 500 });
        await atomicWriteFile(path.join(memoryDir, "today.md"), `${body}\n`);
        finish("S1");
      } catch (error) { fail("S1", error); }
    }
    if (!done("S2") || forced("S2")) {
      try {
        const files = await listDailyFiles(memoryDir);
        const cutoff = shiftDate(date, -6);
        const old = files.filter((item) => item.date < cutoff);
        if (old.length > 0) {
          const existing = await readSectionFile(memoryDir, "longterm.md");
          const folded = await runLlm({ ...buildLongtermPrompt(existing, old.map((item) => item.content).join("\n")), maxTokens: 600 });
          await atomicWriteFile(path.join(memoryDir, "longterm.md"), `${folded}\n`);
          for (const item of old) await deleteDailyFile(memoryDir, item.date);
        }
        finish("S2");
      } catch (error) { fail("S2", error); }
    }
    if (!done("S3") || forced("S3")) {
      try {
        const recent = (await listDailyFiles(memoryDir)).filter((item) => item.date >= shiftDate(date, -6));
        const factsSource = [allSummaries, ...recent.map((item) => item.content)].join("\n\n");
        const facts = await runLlm({ ...buildFactsPrompt(factsSource), maxTokens: 300 });
        await atomicWriteFile(path.join(memoryDir, "facts.md"), `${facts}\n`);
        finish("S3");
      } catch (error) { fail("S3", error); }
    }
    if (!done("S4") || forced("S4")) {
      try {
        const today = await readSectionFile(memoryDir, "today.md");
        const facts = await readSectionFile(memoryDir, "facts.md");
        const longterm = await readSectionFile(memoryDir, "longterm.md");
        const files = (await listDailyFiles(memoryDir)).filter((item) => item.date <= date).slice(-6);
        let week = files.map((item) => `## ${item.date}\n${item.content}`).join("\n\n");
        week = week.slice(Math.max(0, week.length - 1200));
        const sections = [
          ["facts", facts], ["today", today], ["week", week], ["longterm", longterm],
        ] as const;
        const memory = sections.map(([key, value]) => `## ${MEMORY_MD_SECTION_TITLES[key]}\n${safe(value) || MEMORY_MD_EMPTY_PLACEHOLDER}`).join("\n\n") + "\n";
        await atomicWriteFile(path.join(memoryDir, "week.md"), `${safe(week, 1200)}\n`);
        await atomicWriteFile(path.join(memoryDir, "memory.md"), memory);
        const revision = createHash("sha256").update(memory).digest("hex").slice(0, 12);
        this.deps.watermarkStore.upsert(agentId, "markdown", "", { date, revision }, false);
        finish("S4");
        return { date, revision, degraded, completed, failures };
      } catch (error) { fail("S4", error); }
    }
    const memory = await readSectionFile(memoryDir, "memory.md");
    const revision = createHash("sha256").update(memory).digest("hex").slice(0, 12);
    return { date, revision, degraded, completed, failures };
  }

  async refreshToday(agentId: string, memoryDir: string, logicalDate?: string): Promise<MemoryCompileResult> {
    const date = logicalDate ?? getLogicalDate(this.deps.now?.());
    for (const step of ["S1", "S4"] as const) {
      // Refresh deliberately reruns these stages even after a daily compile.
      const done = this.deps.dailyStateStore.isStepDone(agentId, date, step);
      if (done) {
        // There is no delete operation in the frozen state contract; S4 remains idempotent.
      }
    }
    return this.runDaily(agentId, memoryDir, date, ["S1", "S4"]);
  }
}
