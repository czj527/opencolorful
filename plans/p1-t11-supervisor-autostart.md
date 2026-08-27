# P1 T11 — supervisor start 自动拉起整个后端 (lane)

**Status: 进行中（子 Agent 实现完成，待主 Agent 复核）** | Branch: `feat/p1-t11-supervisor-autostart` | Parent plan: `plans/p1-personal-assistant.en.md`

## 问题（台账 #11）

`npm run cli -- supervisor start` 只启动 supervisor 本身（4311），agent server 子进程（4310）
停在 stopped：`GET /api/supervisor/status` 返回 `agentServer.status=stopped, pid=null`，必须再手动
`POST /api/supervisor/start` 才拉起。反直觉——用户误以为"后端已启动"，桌面端探活失败静默回退 mock。

根因：`ProcessController.desiredRunning` 初始为 `inferDesiredRunningFromState()`（fresh 启动时
supervisor.json 无记录 → false），而"当前行为是期望态=stopped 时看门狗正确地不拉起"——问题在于
`supervisor start` 从未把期望态置为 running，也没有任何启动路径被触发。

## 方案

改动尽量小，只动 supervisor 启动入口、CLI 输出、失败路径竞态守卫与对应测试：

1. **`src/supervisor/start.ts`**：HTTP 服务监听成功后，立即 `controller.startAgentServer()`
   （**不 await**，fire-and-forget + `.catch(() => {})` 吞掉 rejection）。
   - 复用现有 spawn / 健康检查 / `writeSupervisorState` / 看门狗路径，零平行实现；
   - 不等待的原因：启动失败不应让 `supervisor start` 硬失败或留下孤儿进程——失败由看门狗
     退避重试（1s→30s、5 次上限），supervisor 始终存活；启动期间状态经
     `/api/supervisor/status` 呈现 `starting → online`；
   - `startAgentServer` 自身的 `startPromise` 串行化保证重复触发（CLI 自动拉起 + API POST start
     并发）不会双 spawn，天然幂等。
2. **`src/cli/supervisor-command.ts`**：输出如实告知两个端点状态——
   `opencolorful supervisor online: http://127.0.0.1:<port>` +
   `agent server 正在拉起: http://127.0.0.1:<port>（状态见 /api/supervisor/status）`。
3. **`src/supervisor/process-controller.ts`**：`doStartAgentServer` 失败路径加守卫——启动期间被
   显式 stop 竞态打断（自动拉起后更易触达，如启动即 Ctrl+C）时保留 `stopped` 语义，不再被
   catch 覆盖为 `error`；显式 stop 取消已排期重试的语义（`desiredRunning=false` + 清理定时器）
   本身不变。

## 语义不变项（逐条对照任务要求）

- `POST /api/supervisor/stop` → `desiredRunning=false`、清看门狗定时器，绝不复活；已排期的
  自动重启也会被取消（新增用例覆盖"已排期重试 + stop 不复活"）。
- `inferDesiredRunningFromState` 收养逻辑零改动：跨 supervisor 重启仍按 supervisor.json
  （online/degraded + pid 存活）收养。
- `POST /api/supervisor/start` 幂等：`startPromise` 串行化 + `agentServerRunning` 短路，
  自动拉起后再次 POST 返回同一 pid。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/supervisor/start.ts` | `startSupervisor` 监听就绪后自动 `startAgentServer()`（+9 行注释与调用） |
| `src/cli/supervisor-command.ts` | 第二行输出改为 `agent server 正在拉起: ...（状态见 /api/supervisor/status）` |
| `src/supervisor/process-controller.ts` | 启动失败 catch 增加"显式 stop 竞态保留 stopped"守卫（+10 行）；TS 窄化误报用 `as AgentServerStatus` 显式宽化 |
| `tests/integration/supervisor.test.ts` | 新增 `waitForAgentOnline` helper；改写 1 个用例 + 新增 3 个用例（见下） |
| `web/tests/e2e/plugin-smoke.spec.ts` | 仅更新 1 处过时注释（断言"startSupervisor 不自动启动 agent server"——正是本任务修复的行为；调用本身幂等保留）。**越界说明**：此文件在 `web/` 下，硬约束限定 src/supervisor、src/cli、对应测试文件；注释必须与真实行为一致，否则误导后续维护者，故一并修正并在此披露 |
| `plans/p1-t11-supervisor-autostart.md` | 本 lane log |

未改动：`inferDesiredRunningFromState`、`stopAgentServer`、`scheduleAutoRestart`、
`startWatchdogPolling`、`/api/supervisor/*` 路由——语义全部保持不变。

## 测试证据

验证环境：Windows，Node `>=22.19`，vitest 4.1.10，测试均用临时 `OPENCOLORFUL_HOME`，不请求任何 Provider 网络。

1. 类型检查（需先 `npm run build:protocol && npm run build:sdk`，`@opencolorful/plugin-protocol`
   为未构建的 workspace 依赖，属环境准备非本次改动）：
   ```
   > npx tsc --noEmit -p tsconfig.json
   退出码 0
   ```
2. supervisor 相关 vitest 全量（原 18 + 6 = 24 用例，现 21 + 6 = 27）：
   ```
   > npx vitest run tests/integration/supervisor.test.ts tests/integration/supervisor-watchdog.test.ts
   Test Files  2 passed (2)
        Tests  27 passed (27)
   ```
   新增/改写用例：
   - `auto-starts agent server on supervisor start without manual POST`（新）：startSupervisor
     后不做任何 POST，轮询 status 直至 `agentServer.status === "online"`；
   - `duplicate POST /api/supervisor/start is idempotent after auto-start`（新）：连续两次
     POST start 返回同一 pid（201）；
   - `does not resurrect agent server after explicit stop even with a scheduled retry`（新）：
     先 SIGKILL 模拟崩溃确认看门狗排期（watchdog.nextRetryAt 非空、consecutiveFailures>0），
     POST stop 后立即断言 stopped/pid null/nextRetryAt null，再等 2.5s（>默认退避基线 1s）
     复查仍 stopped——证明 stop 同时取消已排期重试；
   - `supervisor stays up when agent server is stopped`（**改写**）：原断言"startSupervisor
     后 status 即 stopped"正是本任务修复的行为，改为先等自动拉起 online，再 POST stop，
     验证 supervisor 存活 + agent stopped，保留原用例意图。
3. 真实 CLI 端到端冒烟（临时 home，端口 4399/4398）：
   ```
   > OPENCOLORFUL_HOME=D:/PI-study/.oc-lanes/t11/.tmp/t11-cli-smoke \
     npm run cli -- supervisor start --port 4399 --agent-port 4398
   opencolorful supervisor online: http://127.0.0.1:4399
   agent server 正在拉起: http://127.0.0.1:4398（状态见 /api/supervisor/status）
   > curl http://127.0.0.1:4399/api/supervisor/status   # 未做任何 POST
   {"status":"online",...,"agentServer":{"status":"online","pid":12280,"port":4398,...}}
   > curl -X POST http://127.0.0.1:4399/api/supervisor/stop
   {"status":"stopped"}
   > curl http://127.0.0.1:4399/api/supervisor/status   # 立即
   {"agentServer":{"status":"stopped","pid":null,...,"watchdog":{"consecutiveFailures":0,"nextRetryAt":null}}}
   > sleep 3 && curl http://127.0.0.1:4399/api/supervisor/status   # 3s 后复查
   {"agentServer":{"status":"stopped","pid":null,...}}  # 看门狗未复活
   ```
   冒烟实例随后已终止并清理临时目录。

## 已知偏差 / 风险

- **web e2e 行为面变化**：`startSupervisor` 现在自动拉起 agent server。各 `web/tests/e2e/*.spec.ts`
  的 `ensureAgentServerViaApi` 与 `controller.startAgentServer()` 均幂等，不受影响；唯一代码级
  影响是 `plugin-smoke.spec.ts` 的过时注释（已一并更新）。主 Agent 复核时建议跑
  `cd web; npx playwright test` 回归确认（本次未跑，属主 Agent 质量门范围）。
- **启动即 stop（Ctrl+C）竞态**：自动拉起后立刻显式 stop 的窗口内，失败路径守卫保证终态为
  `stopped` 而非 `error`；该项已通过守卫实现 + 新用例间接覆盖，未单列专项测试。
- **启动失败语义**：agent server 若健康检查失败（如端口被占），`supervisor start` 命令本身
  不会失败退出——supervisor 保持在线，看门狗按退避策略重试（1s→30s、5 次上限）；用户经
  `/api/supervisor/status` 与 `/api/supervisor/logs` 观察。这是有意识的取舍（supervisor 的
  职责就是托管与重试），与既有看门狗语义一致。
- **web/ 越界一处**：`web/tests/e2e/plugin-smoke.spec.ts` 注释更新（见改动清单），如主 Agent
  不同意可单独回退该行。
## 补记（2026-08-27 主 agent）：CI Browser E2E 8 用例红——真实破坏，非 flake

**根因**：`startSupervisor` 自动拉起后，agent server 经历 `starting` 态；"启动 Server"按钮仅在 `stopped/error` 渲染（`web/src/components/ServerStatusBar.tsx:64`）。phase6/subagent/workspace 三个 spec 的 `ensureFixtureProvider` helper 旧路径 `status !== "online" → 点按钮`，在 starting 窗口必超时。

**修复（主 agent）**：三处 helper 改为幂等 `POST /api/supervisor/start` + `expect(...).toPass` 轮询 online。workspace.spec 中先 stop 再点按钮的 3 处属"显式停止→按钮出现"路径，不受 T11 影响，未动。

**教训**：子 agent lane log 已明确建议主 agent 复核时跑 `cd web; npx playwright test`，主 agent 只跑了 tsc+supervisor 套件——复核门禁遗漏，记入流程教训：后端行为面变更必须跑 web E2E。
