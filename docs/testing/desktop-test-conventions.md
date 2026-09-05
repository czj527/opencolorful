# Desktop 测试约定（L5 / L6 共同契约）

**建立：2026-09-01（P1 波次 A · 任务 A1）**
**权威计划：** [`plans/p1-quality-model-usage.en.md`](../../plans/p1-quality-model-usage.en.md)（A2/A3 任务简报）
**配套矩阵：** [`test-asset-matrix.md`](test-asset-matrix.md)
**维护规则：** A2/A3 实施时如与本约定发生偏差，必须回写计划的实施记录并同步修订本文件；不得静默偏离。

## 一、范围与现状

- **L5（Desktop Mock）**：渲染层回归。`MockDataSource` 注入状态，无后端、无 Electron，运行快、可断言全部可见状态。
- **L6（Desktop Electron 真链）**：Playwright `_electron` 启动真实应用，走 preload → main IPC → Supervisor/Server → SQLite/PI JSONL → Desktop 投影的完整路径。
- **现状**：`desktop/package.json` 目前没有任何测试脚本与测试依赖（仅 dev/build/pack）。本文件是 A2/A3 派发前的固定契约；两者落地时按此建立工程，不得另起炉灶。

## 二、工程落点（A2/A3 建立时生效）

| 项 | 约定 |
|---|---|
| L5 运行命令 | `npm run test --workspace=@opencolorful/desktop`（A2 在 desktop 包新增 `test` 脚本：`vitest run`） |
| L5 测试位置 | `desktop/src/**/*.test.ts(x)` 与 `desktop/tests/fixtures/**`（fixture 与 Page Object） |
| L6 运行命令 | `npx playwright test --config desktop/tests/e2e/playwright.config.ts` |
| L6 测试位置 | `desktop/tests/e2e/*.spec.ts`（Playwright `_electron`） |
| 质量门接入 | A2/A3 合入后把两条命令加入 `docs/development.md` §九 与 A9 的验收清单；CI 至少接入 L6 smoke |

## 三、用例 ID 与选择器约定

1. **用例 ID**：与矩阵行号一一对应（`CHAT-01`、`ONB-04`…）。一个矩阵行至少对应一个测试；一个测试可覆盖多行，但报告必须逐行标注结果。
2. **定位手段优先级**：`data-testid` > `role` + `name` > 文本。新增交互控件必须带 `data-testid`，前缀 `oc-`（如 `oc-composer-send`、`oc-session-row`）；**禁止**用 CSS 类名或纯文案定位。
3. **Page Object**：每个页面/常驻组件一个 Page Object（`OnboardingPage`、`SidebarPO`、`ComposerPO`…），放在 `desktop/tests/fixtures/pages/`（L5）与 `desktop/tests/e2e/pages/`（L6）；Page Object 只暴露用户动作与可见断言，不暴露内部 state。
4. **命名**：L5 文件 `<area>.mock.test.tsx`；L6 文件 `<area>.truechain.spec.ts`。area 与矩阵模块码小写对应（`chat`、`onb`、`mem`…）。

## 四、Mock fixture 约定（L5）

1. Mock 只实现 `DesktopDataSource` 接口（`desktop/src/data/source.ts`），**不得**为测试修改生产组件语义或接口形状。
2. 每个数据域提供状态注入表：`loading`、`empty`、`streaming`、`offline`、`error`、`retry`、`persistence-after-reload`、`malformed-response`。矩阵中标注"Mock 不支持"的行为（如断线语义、多助理隔离）不得用 Mock 假装覆盖。
3. **wire-shape parity**：Mock 返回的数据形状必须与 IPC 实现同路径的真实响应形状一致；发现形状分歧时记录为缺陷（repair 生产或 mock，二选一），不允许测试绕过。
4. Mock 流式回放用固定事件序列（录制自真实 SSE 样本，脱敏后入库 `desktop/tests/fixtures/sse/`），保证断言确定性。

## 五、隔离与数据约定（L6）

1. 每个用例独立临时 `OPENCOLORFUL_HOME` 与 Electron `--user-data-dir`；由 fixture 统一创建与清理，**禁止**使用作者真实 home 与凭据。
2. 测试数据一律使用 `oc-e2e-` 前缀（目录名、Agent 名、会话标题），teardown 后按前缀清扫兜底。
3. Provider 一律使用 PI faux provider（或本地 stub HTTP 端点）；**禁止**真实 Provider 网络与本机 API Key。
4. 对后端的真值断言只读：直接读临时 home 下的 API 响应、PI JSONL、SQLite（只读连接），先取事实再断言 UI，或反之；两处必须一致。
5. 只有韧性 lane（RES）允许注入进程失败（kill server、断端口）；普通用例不得重启共享服务。
6. 长任务写入结果文件后轮询读取，不在 PowerShell 中用分号串联关键验证。

## 六、证据与状态回写

1. 失败必须留存 artifact：截图 + Playwright trace + 应用日志 + 环境 metadata，统一写 `desktop/test-artifacts/`（加入 `.gitignore`）。
2. 每次真实执行后，把结果（状态词 + 日期 + 证据路径）回写矩阵对应行；状态词只用 `PASS / FAIL / BLOCKED-ENV / SKIP`。
3. **状态不得隐式升级**：CI 全绿、lint 通过、代码合入都不能替代某行目标层的真实执行记录。
4. Mock（L5）通过不证明 IPC（L6）通过；L6 通过不证明安装版可用（L7）。三档证据不可互相替代。

## 七、红线

- 不为让测试通过而修改生产行为；发现产品缺陷时 FAIL + 立项，不 SKIP 掩盖。
- 不在 L5 断言"Mock 成功 = IPC 成功"；parity 缺口必须显式记录。
- 不在测试中记录/断言任何 API Key、Authorization、Cookie 值。
- 子 Agent 只写归属文件；测试结果报告不作为验收证据，主 Agent 复核 diff 并重跑命令。
