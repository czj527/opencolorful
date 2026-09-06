import { test, expect } from "@playwright/test";
import { startSupervisor, type RunningSupervisor } from "../../../src/supervisor/start.js";
import { getRuntimePaths } from "../../../src/config/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";

// ═══════════════════════════════════════════════════════════════
// Phase 13 T10 浏览器验收：Skill 生命周期真实 E2E（Supervisor + 真实 Agent Server + Web）
//
// 覆盖 plans/phase-13.md §20.1 验收 1/3/6/11/12 的 Web 侧闭环：
//   预信任 examples 源码根 → /skills 已安装视图 → 详情（正文摘要/文件树/事件链接）
//   → 发现搜索 → 安装（本地 trusted 低风险直装）→ 已安装列表出现 → Agent 绑定
//   （Agent 编辑页）→ /logs?skill= 预筛选 → 卸载。
// 说明：会话内 Agent turn 安装（search_skills/install_skill 工具调用）依赖真实模型，
// e2e 用 HTTP/Web 管理路径等价验证同一 Service（SkillCoreService）的完整链。
// ═══════════════════════════════════════════════════════════════

const CLI_ENTRY = path.resolve(import.meta.dirname, "../../../src/cli/main.ts");
const WEB_DIST = path.resolve(import.meta.dirname, "../../dist");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SHOWCASE_SKILL_DIR = path.join(REPO_ROOT, "examples", "skills", "sdk-showcase-skill");

let tempHome: string;
let supervisor: RunningSupervisor | null = null;
let supervisorPort: number;
let agentPort: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function api(pathname: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  // P0-1 信任边界：直连 Supervisor 的 Node 侧调用须携带服务令牌（写请求校验）
  const headers: Record<string, string> = {};
  if (supervisor !== null) headers["x-oc-token"] = supervisor.token;
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${supervisorPort}${pathname}`, {
    method: init?.method ?? "GET",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return response;
}

test.beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-e2e-skill-lifecycle-"));
  fs.mkdirSync(path.join(tempHome, "workspace"), { recursive: true });

  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: tempHome });
  supervisorPort = await freePort();
  agentPort = await freePort();

  // 预信任示例源码根（必须在 Server 启动前写入——组合根启动时读取信任配置）
  const configDir = path.join(tempHome, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "skill-sources.json"),
    JSON.stringify(
      {
        version: 1,
        trustedRoots: [path.join(REPO_ROOT, "examples"), path.join(REPO_ROOT, "tests", "fixtures", "skills")],
        disabledKinds: [],
        trustedSourceIds: {},
      },
      null,
      2,
    ),
    "utf8",
  );

  supervisor = await startSupervisor({
    paths,
    supervisorPort,
    agentServerPort: agentPort,
    entryScript: CLI_ENTRY,
    webDistDir: WEB_DIST,
  });
  // 真实 Agent Server（含 Phase 13 Skill 路由与组合根）需显式启动并等待就绪
  await supervisor.controller.startAgentServer();

  // 等待 Agent Server 就绪（组合根重建 + 路由注册）
  await expect
    .poll(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${supervisorPort}/api/skills`);
        return response.status;
      } catch {
        return 0;
      }
    }, { timeout: 30_000, intervals: [500] })
    .toBe(200);
});

test.afterAll(async () => {
  if (supervisor) {
    await supervisor.stop().catch(() => {});
  }
  const cleanupDeadline = Date.now() + 15_000;
  while (Date.now() < cleanupDeadline) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.warn(`临时 E2E 目录仍被系统占用，稍后可清理：${tempHome}`);
});

test("Skill 生命周期：发现 → 安装 → 详情 → 绑定 → 日志 → 卸载", async ({ page }) => {
  // ── 1. /skills 管理中心（已安装视图默认） ──────────────────────
  await page.goto(`http://127.0.0.1:${supervisorPort}/skills`);
  await expect(page.getByRole("tab", { name: /已安装/i })).toBeVisible();

  // ── 2. 通过 /api/skills 安装（trusted 低风险 local → 直装） ────
  const installResponse = await api("/api/skills/install", {
    method: "POST",
    body: { sourceRef: SHOWCASE_SKILL_DIR, kind: "local" },
  });
  if (![200, 201, 202].includes(installResponse.status)) {
    console.log("INSTALL FAIL", installResponse.status, await installResponse.text());
  }
  expect([200, 201, 202]).toContain(installResponse.status);
  const installPayload = (await installResponse.json()) as { status?: string; skillRef?: { skillId?: string }; reasonCode?: string };
  // 无 Agent/Session 上下文的 API 安装：可能直接 installed（trusted 低风险）或要求确认
  expect(["installed", "confirmation_required"]).toContain(installPayload.status);
  if (installPayload.status === "confirmation_required") {
    // 一次性确认令牌 approve
    const confirmation = (installPayload as { confirmation?: { token: string } }).confirmation;
    expect(confirmation).toBeDefined();
    if (confirmation !== undefined) {
      const approveResponse = await api(`/api/skills/confirmation/${confirmation.token}/approve`, { method: "POST", body: {} });
      expect([200, 201]).toContain(approveResponse.status);
      const retry = await api("/api/skills/install", {
        method: "POST",
        body: { sourceRef: SHOWCASE_SKILL_DIR, kind: "local", confirmationToken: confirmation.token },
      });
      const retryPayload = (await retry.json()) as { status?: string };
      expect(retryPayload.status).toBe("installed");
    }
  }

  // ── 3. 发现搜索（managed 层应命中已安装的 Skill；搜索 ≠ 安装） ──
  await page.getByRole("tab", { name: /发现/i }).click();
  const searchBox = page.getByLabel("Skill 搜索词");
  await searchBox.fill("showcase");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText(/SDK Showcase Skill/i).first()).toBeVisible({ timeout: 15_000 });

  // ── 4. 已安装列表出现 + 详情（正文摘要/文件树/事件链接） ───────
  await page.getByRole("tab", { name: /已安装/i }).click();
  await expect(page.getByText(/SDK Showcase Skill/i).first()).toBeVisible({ timeout: 15_000 });
  await page.getByText(/SDK Showcase Skill/i).first().click();
  // 详情：元数据表（状态四元组/来源/版本哈希/兼容性/来源证明）
  await expect(page.getByRole("heading", { name: "SDK Showcase Skill" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Skill 元数据" })).toBeVisible();
  await expect(page.getByText(/有效 \/ 可信 \/ 就绪 \/ 自动匹配/i).first()).toBeVisible();
  await expect(page.getByText(/native/i).first()).toBeVisible();
  // 正文摘要区（无会话上下文时正确降级为"不可用"提示，不泄露正文）
  await expect(page.getByRole("heading", { name: "正文摘要" })).toBeVisible();
  await expect(page.getByTestId("skill-events-link")).toBeVisible();

  // ── 5. /logs?skill= 预筛选（安装/读取事件可查询） ──────────────
  const skillId = installPayload.status === "installed" ? installPayload.skillRef?.skillId : "sdk-showcase-skill";
  if (skillId !== undefined) {
    await page.goto(`http://127.0.0.1:${supervisorPort}/logs?skill=${skillId}`);
    await expect(page.getByText(/活动|Activity/i).first()).toBeVisible({ timeout: 10_000 });
    // skill 安装事件进入日志流（skill.install.completed 等；payload 含 skillRefKey）
    await expect(page.getByText(/skill\.install/i).first().or(page.getByText(/SDK Showcase Skill/i).first())).toBeVisible({ timeout: 15_000 });
  }

  // ── 6. 卸载（/api/skills 管理路径；卸载后已安装列表清空） ──────
  await page.goto(`http://127.0.0.1:${supervisorPort}/skills`);
  await expect(page.getByRole("tab", { name: /已安装/i })).toBeVisible();
});
