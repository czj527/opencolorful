/**
 * L6 真链冒烟（@smoke）——矩阵 ONB-01 / AGENT-01 / SESS-01 / CHAT-01 / CHAT-03 / ABORT-01 合并链 + 重启持久化。
 *
 * 真链路径：preload → main IPC（desktop:api / desktop:sse-sub→SseProxyManager）
 *   → 真实 Agent Server（fixtures 以 startForegroundServer({ port: 0 }) 拉起，与 packaged 内嵌同一条代码路径）
 *   → SQLite / PI JSONL → Desktop projector → UI。
 *
 * 真值断言（只读）：Node 侧直接读临时 OPENCOLORFUL_HOME 下的 API 响应与 JSONL/配置文件；
 * 失败时 Playwright trace/截图 + 引导日志 + 目录清单留档 desktop/test-artifacts/。
 */
import { expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeApp, firstWindow, launchApp } from "./fixtures/app.js";
import { test } from "./fixtures/harness.js";
import { ChatPO } from "./pages/chat-po.js";
import { OnboardingPO } from "./pages/onboarding-po.js";

test.describe("@smoke 真链最小冒烟", () => {
  test("ONB-01+AGENT-01+SESS-01+CHAT-01+CHAT-03+ABORT-01 合并链：引导建助理 → 无 cwd 会话 → 首条消息 → 流式 → 中止 → 重启持久化", async ({ harness }) => {
    const runId = Date.now().toString(36);
    const agentName = `oc-e2e-助理-${runId}`;
    const messageOne = `oc-e2e-消息一：验证首条消息与流式回复-${runId}`;
    const messageTwo = `oc-e2e-消息二：中止后继续输入-${runId}`;
    const stubDoneReply = "oc-e2e-完成回复：第二轮回复完整返回，用于验证消息定稿与持久化。";
    const stubAbortReplyPrefix = "oc-e2e-中止回复";

    let currentApp: ElectronApplication | null = null;
    try {
      /* ---- Phase 1：干净临时 home 冷启动，断言进入首启引导（ONB-01）---- */
      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page = await firstWindow(currentApp);
      const onboarding = new OnboardingPO(page);
      await onboarding.expectStepAssistantVisible();

      // 四步引导：Provider 指向本地 stub（禁止真实 Provider 网络），工作目录刻意留空
      await onboarding.completeAllSteps({
        name: agentName,
        apiKey: harness.fakeApiKey,
        baseUrl: harness.stubUrl,
        modelId: "oc-e2e-model",
      });

      /* ---- AGENT-01 服务端真值：三文件落盘且无 defaultCwd ---- */
      // GET /api/agents 返回 AgentView 裸数组（src/server/routes/agents.ts:44）
      const agents = await harness.apiGet<Array<{ identity: { id: string; name: string }; settings?: { defaultCwd?: string | null } }>>("/api/agents");
      expect(agents, "引导后应恰好创建一个助理").toHaveLength(1);
      const agent = agents[0]!;
      expect(agent.identity.name).toBe(agentName);
      const agentDir = path.join(harness.homeDir, "agents", agent.identity.id);
      for (const file of ["identity.json", "base-color.json", "settings.json"]) {
        expect(fs.existsSync(path.join(agentDir, file)), `助理三文件应落盘：${file}`).toBe(true);
      }
      const agentSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as { defaultCwd?: string | null };
      expect(agentSettings.defaultCwd ?? null, "本用例要求无 defaultCwd 场景（SESS-01 cwd 兜底锚点）").toBeNull();

      // 引导完成 → 对话空态，草稿助理为新建助理
      await expect(page.getByRole("heading", { name: `要做什么，交给${agentName}吧` })).toBeVisible({ timeout: 30_000 });

      /* 模型确定性：引导中用户明确配置的 Provider/model 已写入 primary 默认；
       * 这里读取真实偏好与 Provider 真值，确保后续新会话不会静默借用其他模型。 */
      const providers = await harness.apiGet<Array<{ providerId: string; models: Array<{ modelId: string }> }>>("/api/settings/providers");
      expect(providers, "引导后应恰好一个自定义 Provider").toHaveLength(1);
      const stubModelId = providers[0]!.models[0]!.modelId;
      const preferences = await harness.apiGet<{ defaults: { model: { providerId: string; modelId: string } | null } }>("/api/settings/preferences");
      expect(preferences.defaults.model).toEqual({ providerId: providers[0]!.providerId, modelId: stubModelId });

      /* ---- SESS-01 + CHAT-01：无 cwd 发送首条消息（cwd 由服务端兜底解析）---- */
      const chat = new ChatPO(page);
      await chat.fill(messageOne);
      await chat.send();

      /* ---- CHAT-03：stub Provider 经真实 SSE/IPC 链路流式可见 ---- */
      await chat.expectStreaming();
      await chat.expectMessageVisible(stubAbortReplyPrefix, 30_000);
      await chat.expectDraftNoticeGone();

      /* ---- ABORT-01：流式中点停止 → 退出流式态，可继续输入 ---- */
      await chat.stop();
      await chat.expectIdle(30_000);
      await chat.fill(messageTwo);
      await chat.send();
      await chat.expectIdle(30_000);
      await chat.expectMessageVisible(stubDoneReply, 30_000);

      /* ---- SESS-01 服务端真值：cwd 三级兜底落到 per-agent workspace ---- */
      // GET /api/sessions 返回 SessionView 裸数组（src/server/routes/sessions.ts:29）
      const sessions = await harness.apiGet<Array<{ id: string; title: string; agentId: string | null; workspaceCwd: string | null; archived: boolean; model: { providerId: string; modelId: string } | null }>>("/api/sessions");
      expect(sessions, "首条消息后应恰好一个活跃会话").toHaveLength(1);
      const session = sessions[0]!;
      expect(session.agentId).toBe(agent.identity.id);
      expect(session.archived).toBe(false);
      // 会话模型真值：必须是 stub 的模型（防环境凭据内置模型兜底回归）
      expect(session.model?.modelId).toBe(stubModelId);
      const expectedWorkspace = path.join(agentDir, "workspace");
      expect(session.workspaceCwd).toBe(expectedWorkspace);
      expect(fs.existsSync(expectedWorkspace), "服务端应已创建 per-agent workspace 兜底目录").toBe(true);

      /* ---- Phase 2：重启应用（同一 home + 同一 user-data-dir）---- */
      await closeApp(currentApp);
      currentApp = null;
      currentApp = await launchApp({
        serverUrl: harness.serverUrl,
        homeDir: harness.homeDir,
        userDataDir: harness.userDataDir,
      });
      const page2 = await firstWindow(currentApp);
      // ONB-02 锚点：Agent 与凭据俱在，不再自动进入引导（同时是真链判别：mock 源不会出现 oc-e2e 会话）
      await expect(page2.getByText("给你的助理起个名字")).toHaveCount(0);
      // 重启后自动选中既有会话（App.tsx setThreadId(list[0]?.id)），不落空态草稿
      await expect(page2.getByText("发送首条消息后才会出现在会话列表")).toHaveCount(0);

      // CHAT-02：切换会话 → 历史重建（用户/中止回复/第二条/完整回复全部可见）
      const chat2 = new ChatPO(page2);
      await chat2.openSession("oc-e2e-消息一");
      await chat2.expectMessageVisible(messageOne, 30_000);
      await chat2.expectMessageVisible(stubAbortReplyPrefix, 30_000);
      await chat2.expectMessageVisible(stubDoneReply, 30_000);

      /* ---- 服务端真值：重启后会话与消息仍在 ---- */
      const reopened = await harness.apiGet<{ id: string; messages: string[] }>(`/api/sessions/${encodeURIComponent(session.id)}`);
      expect(reopened.id).toBe(session.id);
      expect(reopened.messages.some((text) => text.includes(messageOne)), "JSONL 重建应含首条消息").toBe(true);
      expect(reopened.messages.some((text) => text.includes(messageTwo)), "JSONL 重建应含第二条消息").toBe(true);
      expect(reopened.messages.some((text) => text.includes(stubDoneReply)), "JSONL 重建应含完整助手回复").toBe(true);

      /* ---- JSONL / 配置文件真值对照（只读）---- */
      const sessionsDir = path.join(agentDir, "sessions");
      const jsonlFiles = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl"));
      expect(jsonlFiles.length, "会话 JSONL 应存在于 agents/<id>/sessions/").toBeGreaterThanOrEqual(1);
      let jsonlText = "";
      for (const name of jsonlFiles) {
        const text = fs.readFileSync(path.join(sessionsDir, name), "utf8");
        for (const line of text.split("\n")) {
          if (line.trim() === "") continue;
          expect(() => JSON.parse(line), `JSONL 每行应为合法 JSON：${name}`).not.toThrow();
        }
        jsonlText += text;
      }
      expect(jsonlText).toContain(messageOne);
      expect(jsonlText).toContain(messageTwo);
      expect(jsonlText).toContain(stubDoneReply);
      // 红线：凭据不落入会话记录与配置文件（desktop-test-conventions §七）
      expect(jsonlText, "JSONL 不得包含 API Key").not.toContain(harness.fakeApiKey);
      const providersJsonPath = path.join(harness.homeDir, "config", "providers.json");
      expect(fs.existsSync(providersJsonPath), "引导第 2 步应写入 providers.json").toBe(true);
      expect(fs.readFileSync(providersJsonPath, "utf8"), "providers.json 不得包含 API Key").not.toContain(harness.fakeApiKey);
      const authJsonPath = path.join(harness.homeDir, "auth", "auth.json");
      if (fs.existsSync(authJsonPath)) {
        // AuthStorage 是凭据的法定存储（AGENTS.md：API Key 只入 AuthStorage），
        // 这里断言 key 确实落在 AuthStorage 而不是普通配置/JSONL（上方两条已断言不落）。
        expect(fs.readFileSync(authJsonPath, "utf8"), "API Key 应存入 AuthStorage").toContain(harness.fakeApiKey);
      }

      /* ---- 隔离自检：home 与 user-data 都必须位于临时目录 ---- */
      expect(harness.homeDir.startsWith(os.tmpdir()), "OPENCOLORFUL_HOME 必须位于临时目录").toBe(true);
      expect(harness.userDataDir.startsWith(os.tmpdir()), "user-data-dir 必须位于临时目录").toBe(true);
    } finally {
      if (currentApp !== null) {
        await closeApp(currentApp).catch(() => undefined);
      }
    }
  });
});
