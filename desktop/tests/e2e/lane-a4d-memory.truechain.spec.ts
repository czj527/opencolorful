/**
 * A4d lane · MEM-05 记忆维护条真链回归（@a4d）。
 *
 * MEM-05：打开记忆页 → 维护条「空闲」→ 经 harness API POST deep-dive（202 queued，
 * 服务端 Scheduler 串行队列；默认 deepDiveMode=script，零 LLM 确定性整理）→
 * 真实 SSE（GET /api/agents/:id/events 上 memory.agent.started/processing/completed）
 * → 维护条实时切换（MemoryPage 无轮询，唯一更新路径是 subscribeMemoryMaintenance 订阅）
 * → 「查看报告」出现 → 报告全文与文件系统 REPORT.md、GET memory/runs/:runId 真值一致（只读对照）。
 *
 * lane 内其余矩阵行的归属（不建用例，见任务报告）：
 * - MEM-01/02/03：L5 在 desktop/src/memory.mock.test.tsx（A2 既有 + A4d 补强/parity 修复）；
 *   L3 已有 memory-admin-api.test.ts 等覆盖。
 * - MEM-04：Desktop 无 flush UI（「立即整理」= deep-dive 而非 flush），不建用例。
 * - MEM-06：多助理切换数据隔离由 A4a AGENT-06 覆盖（2026-09-02），不重复建。
 * - MAGENT-01：L5 在 memory.mock.test.tsx（脚本化维护序列）；本文件 L6 补真链。
 */
import { expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/harness.js";
import { apiSend, type DeepDiveResponseWire, type MemoryRunWire } from "./fixtures/lane-a4d/api.js";
import { LaneMemoryPO } from "./fixtures/lane-a4d/pages/l6-memory.js";
import { configureStubProvider, createAgentViaApi } from "./fixtures/lane-a4d/provision.js";

/**
 * Node 侧对同一 SSE 流（GET /api/agents/:id/events）的只读订阅，收集 memory.agent.*
 * 事件类型序列。script 模式整轮仅毫秒级，UI 维护条可能从「空闲」直接跳到「整理完成」，
 * 中间 running 态由本 wire 级证据补足（started → processing → completed 各一次，
 * 见 resolver.ts runMaintenanceInner 的 emit 序列）。
 * 回放语义保证无时序竞态：连接时 getSince(streamId, 0) 会重放全部已保留事件。
 */
async function collectMemoryAgentEventTypes(
  serverUrl: string,
  agentId: string,
  until: (types: readonly string[]) => boolean,
  timeoutMs = 30_000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${serverUrl}/api/agents/${encodeURIComponent(agentId)}/events`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  if (!response.ok || response.body === null) {
    clearTimeout(timer);
    controller.abort();
    throw new Error(`SSE 订阅失败：HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const types: string[] = [];
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) {
            const type = line.slice("event: ".length).trim();
            if (type.startsWith("memory.agent.")) types.push(type);
          }
        }
        if (until(types)) return types;
        boundary = buffer.indexOf("\n\n");
      }
    }
    return types;
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader.cancel().catch(() => undefined);
  }
}

test.describe("@a4d MEM-05 记忆维护条真链", () => {
  test("MEM-05: 维护条空闲 → POST deep-dive → SSE 实时切换到整理完成 → 查看报告与 runs/:runId 真值一致", async ({ harness }) => {
    const runTag = Date.now().toString(36);
    // stub Provider 仅用于首启检测放行（deep-dive 默认 script 模式，不调用模型）
    await configureStubProvider(harness);
    const agent = await createAgentViaApi(harness, `oc-e2e-记忆整理-${runTag}`);

    let app: ElectronApplication | null = null;
    try {
      app = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(app);
      const memory = new LaneMemoryPO(page);

      // 打开记忆页（顶栏页签）
      await memory.open();
      await expect(memory.heading(agent.name)).toBeVisible({ timeout: 30_000 });

      // 维护条初始「空闲」（ipc getMemoryData.maintenance = null）
      await expect(memory.maintenanceValue()).toHaveText("空闲", { timeout: 15_000 });

      // Node 侧同流只读订阅（先订阅后触发；回放语义兜底时序），直到看到 completed
      const sseTypesPromise = collectMemoryAgentEventTypes(
        harness.serverUrl,
        agent.id,
        (types) => types.includes("memory.agent.completed"),
      );
      sseTypesPromise.catch(() => undefined); // 防 unhandled rejection；真实失败由 await 处理

      /* ---- harness API POST deep-dive：服务端 202 queued（fire-and-forget 排队）---- */
      const post = await apiSend<DeepDiveResponseWire>(
        harness,
        "POST",
        `/api/agents/${encodeURIComponent(agent.id)}/memory/deep-dive`,
      );
      expect(post.ok, `POST deep-dive 应 202：HTTP ${post.status} ${JSON.stringify(post.json)}`).toBe(true);
      expect(post.json.status).toBe("queued");

      /* ---- 真实 SSE 推进：memory.agent.started/processing/completed → 维护条实时切换。
           MemoryPage 无轮询、本用例不点刷新，唯一更新路径是 subscribeMemoryMaintenance
           的 SSE 订阅；中间 running 态（正在整理往事/正在核对记忆）随 script 模式执行
           速度可能一闪而过，此处先断言离开空闲，再收敛到「整理完成」。---- */
      await expect(memory.maintenanceValue()).not.toHaveText("空闲", { timeout: 30_000 });
      await expect(memory.maintenanceValue()).toHaveText("整理完成", { timeout: 30_000 });
      // runId 进入副标签（run <前 12 位>… · 时间）
      await expect(memory.maintenanceCard()).toContainText(/run run_/);

      // wire 级证据：SSE 流上 running→completed 序列真实推送（script 模式各一次，顺序固定）
      const sseTypes = await sseTypesPromise;
      expect(sseTypes, "SSE 应按序推送 started→processing→completed")
        .toEqual(["memory.agent.started", "memory.agent.processing", "memory.agent.completed"]);

      /* ---- 「查看报告」出现（status=completed 且 runId 存在）→ 报告全文渲染 ---- */
      await memory.reportButton().click();
      const reportBlock = memory.reportBlock();
      await expect(reportBlock).toBeVisible({ timeout: 15_000 });
      await reportBlock.locator("summary").click(); // details 默认折叠，展开后报告可见
      await expect(reportBlock.locator("pre")).toBeVisible({ timeout: 15_000 });
      const rendered = (await reportBlock.locator("pre").textContent()) ?? "";
      expect(rendered, "报告应包含运行状态行").toContain("状态：completed");

      /* ---- 真值对照（只读）①：agents/<id>/memory/runs/<runId>/ 落盘文件 ---- */
      const runsDir = path.join(harness.homeDir, "agents", agent.id, "memory", "runs");
      const runDirs = fs.readdirSync(runsDir).sort((a, b) => {
        const statA = fs.statSync(path.join(runsDir, a));
        const statB = fs.statSync(path.join(runsDir, b));
        return statB.mtimeMs - statA.mtimeMs;
      });
      expect(runDirs.length, "应至少落盘一次运行目录").toBeGreaterThanOrEqual(1);
      const newestRunId = runDirs[0]!;
      const runJson = JSON.parse(
        fs.readFileSync(path.join(runsDir, newestRunId, "run.json"), "utf8"),
      ) as { runId: string; status: string };
      expect(runJson.status, "run.json 状态真值").toBe("completed");
      const reportMd = fs.readFileSync(path.join(runsDir, newestRunId, "REPORT.md"), "utf8");
      expect(rendered, "渲染报告应与 REPORT.md 文件真值一致").toBe(reportMd);

      /* ---- 真值对照（只读）②：GET /api/agents/:id/memory/runs/:runId ---- */
      const truth = await harness.apiGet<MemoryRunWire>(
        `/api/agents/${encodeURIComponent(agent.id)}/memory/runs/${encodeURIComponent(runJson.runId)}`,
      );
      expect(truth.runId).toBe(runJson.runId);
      expect(truth.report, "渲染报告应与 GET runs/:runId 真值一致").toBe(rendered);
    } finally {
      if (app !== null) {
        await closeApp(app).catch(() => undefined);
      }
    }
  });
});
