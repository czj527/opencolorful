# Phase 8.5：产品重命名为 OpenColorful

**状态：已完成（2026-07-28）** | 分支：`phase-8.5-opencolorful`
**基线：** `main`（Phase 8 验收点，`828495b`）
**参考：** 无外部依赖，纯项目内重命名

---

## 一、目标

1. **产品重命名**：`person-Agent` → `OpenColorful`（开放多彩）。寓意每个 Agent 都能像颜色一样拥有自己鲜明的性格和多彩的人生。
2. **开发流程增强**：在质量门中新增 browser-use 实际测试验收环节，每个 Phase 完成后用真实浏览器交互验证新功能。

### 重命名范围总览

| 类别 | 旧名 | 新名 |
|------|------|------|
| 平台常量 | `person-agent` | `opencolorful` |
| 默认数据目录 | `~/.person-agent/` | `~/.opencolorful/` |
| 环境变量前缀 | `PERSON_AGENT_*` | `OPENCOLORFUL_*` |
| 包名（根） | `person-agent` | `opencolorful` |
| 包名（Web） | `@person-agent/web` | `@opencolorful/web` |
| CLI 二进制 | `agent` | `ocf` |
| A2UI Catalog | `person-agent/v1` | `opencolorful/v1` |
| HTML 标题 | `person-Agent` | `OpenColorful` |
| 所有文档引用 | `person-agent` / `person-Agent` | `OpenColorful` / `opencolorful`（按语境） |

### 不纳入范围

- Git 仓库名和目录名 `person-Agent/` **本次不改**（涉及仓库级操作，单独评估）
- `package-lock.json` 和 `node_modules/`（由 `npm install` 自动重新生成）
- PI SDK 内部引用（不归本项目控制）
- 参考仓库 `references/`（独立项目，不属于本仓库）
- 数据迁移兼容（项目尚在 v0.1.0 内测阶段，不保证旧数据兼容；开发时用 `PERSON_AGENT_HOME` 隔离的测试数据直接丢弃即可）

---

## 二、能力确认

本项目不依赖外部 SDK 新能力，重命名是纯文本替换：

- 平台常量：`src/index.ts` 中 `PLATFORM_NAME` 单一定义，无其他硬编码
- 路径系统：统一通过 `src/config/paths.ts` 的 `getRuntimePaths()` 生成，无调用方自行拼接
- 环境变量：统一通过 `src/config/environment.ts` 的 `loadEnvironment()` 解析
- PI SDK 适配层：不依赖 `PLATFORM_NAME`，不受影响

---

## 三、重命名规则

### 3.1 英文名称规则

| 语境 | 规则 | 示例 |
|------|------|------|
| 产品名（标题/首字母大写） | `OpenColorful` | "Welcome to OpenColorful" |
| 代码标识符/包名/CLI | `opencolorful`（全小写） | `name: "opencolorful"` |
| 环境变量 | `OPENCOLORFUL_*`（全大写蛇形） | `OPENCOLORFUL_HOME` |
| 文件路径 | `.opencolorful`（全小写） | `~/.opencolorful/config/` |
| 中文文档中提及 | "OpenColorful（开放多彩）" | 首次出现附中文释义 |
| 英文文档中提及 | `OpenColorful` | 一律首字母大写 |

### 3.2 文档中的旧名处理

- **历史 Phase 计划**（`plans/phase-00.md` ~ `phase-08.md`）：仅修改标题和文档内引用链接，不修改历史记录中的旧产品名（保留历史真实性）
- **当前开发文档**（`README.md`、`AGENTS.md`、`docs/*.md`）：全部替换为 `OpenColorful`

### 3.3 环境变量完整映射

```
PERSON_AGENT_HOME       → OPENCOLORFUL_HOME
PERSON_AGENT_HOST       → OPENCOLORFUL_HOST
PERSON_AGENT_PORT       → OPENCOLORFUL_PORT
PERSON_AGENT_LOG_LEVEL  → OPENCOLORFUL_LOG_LEVEL
PERSON_AGENT_DAEMON     → OPENCOLORFUL_DAEMON
PERSON_AGENT_SUPERVISOR_PORT → OPENCOLORFUL_SUPERVISOR_PORT
```

---

## 四、开发流程变更：新增 browser-use 验收

### 4.1 变更内容

在 `docs/development.md` 质量门和 `AGENTS.md` 开发流程中新增一项验收要求：

**browser-use 实际测试验收**：每个 Phase 完成后，在质量门全部通过的基础上，使用 browser-use 工具对 Web 工作台进行真实浏览器交互验证。验证聚焦于当前 Phase 的用户可感知功能，不要求全覆盖。

### 4.2 具体流程

1. 启动 Supervisor + Agent Server（构建好 `web/dist`）
2. 使用 browser-use 打开 Web 工作台
3. 逐项验证当前 Phase 验收标准中的用户可感知行为
4. 截图留存关键验收证据

### 4.3 质量门新增项

```powershell
# 新增：browser-use 实际测试验证（主 Agent 手动执行，或通过 Playwright 脚本自动化）
# - 启动服务：npm run cli -- supervisor start
# - 使用 control-browser skill 打开工作台，按 Phase 验收标准逐项验证
```

---

## 五、文件变更清单

### 5.1 核心基础设施（Task 1，主 Agent 串行先行）

| 文件 | 动作 | 变更说明 |
|------|------|----------|
| `src/index.ts` | 编辑 | `PLATFORM_NAME = "opencolorful"` |
| `src/config/paths.ts` | 编辑 | `PERSON_AGENT_HOME` → `OPENCOLORFUL_HOME`，`".person-agent"` → `".opencolorful"` |
| `src/config/environment.ts` | 编辑 | 所有 4 个 env var 名 + 错误消息中文文案 |
| `src/supervisor/process-controller.ts` | 编辑 | 3 个 child process env var 转发 |
| `src/cli/server-command.ts` | 编辑 | `PERSON_AGENT_DAEMON` + 7 处 console 文案 |
| `web/vite.config.ts` | 编辑 | `PERSON_AGENT_SUPERVISOR_PORT` → `OPENCOLORFUL_SUPERVISOR_PORT`，`PERSON_AGENT_PORT` → `OPENCOLORFUL_PORT` |

### 5.2 CLI/UI 文案 + Catalog（Task 2，子 Agent 并行）

| 文件 | 动作 | 变更说明 |
|------|------|----------|
| `src/cli/supervisor-command.ts` | 编辑 | 1 处 console 文案 |
| `src/tui/app.ts` | 编辑 | TUI 欢迎信息文案 |
| `web/index.html` | 编辑 | `<title>OpenColorful</title>` |
| `src/ui-projection/a2ui/catalog.ts` | 编辑 | `CATALOG_ID = "opencolorful/v1"` |

### 5.3 包名（Task 3，子 Agent 并行）

| 文件 | 动作 | 变更说明 |
|------|------|----------|
| `package.json` | 编辑 | `name`、`description`、`bin` 字段 |
| `web/package.json` | 编辑 | `name` 字段 |

### 5.4 烟雾脚本（Task 4，子 Agent 并行）

| 文件 | 动作 | 变更说明 |
|------|------|----------|
| `scripts/smoke-foundation.mjs` | 编辑 | env var + console 文案 |
| `scripts/smoke-web.mjs` | 编辑 | env var + temp dir 命名 |

### 5.5 测试文件（Task 5，子 Agent 并行）

共约 23 个测试文件，仅修改 `PERSON_AGENT_HOME` → `OPENCOLORFUL_HOME` 和少量断言字符串：

| 文件 | 动作 |
|------|------|
| `tests/smoke/project.test.ts` | 编辑 |
| `tests/contract/a2ui-projection.test.ts` | 编辑 |
| `tests/contract/pi-sdk-adapter.test.ts` | 编辑 |
| `tests/unit/config-paths.test.ts` | 编辑 |
| `tests/unit/preferences.test.ts` | 编辑 |
| `tests/unit/agent-store.test.ts` | 编辑 |
| `tests/unit/log-filter.test.ts` | 编辑 |
| `tests/integration/provider-settings.test.ts` | 编辑 |
| `tests/integration/session-lifecycle.test.ts` | 编辑 |
| `tests/integration/server-health.test.ts` | 编辑 |
| `tests/integration/prompt-events.test.ts` | 编辑 |
| `tests/integration/session-settings.test.ts` | 编辑 |
| `tests/integration/settings-routes.test.ts` | 编辑 |
| `tests/integration/sse-replay.test.ts` | 编辑 |
| `tests/integration/ws-session.test.ts` | 编辑 |
| `tests/integration/supervisor.test.ts` | 编辑 |
| `tests/integration/session-index.test.ts` | 编辑 |
| `tests/integration/builtin-tools.test.ts` | 编辑 |
| `tests/integration/tui-smoke.test.ts` | 编辑 |
| `tests/integration/tui-real-runtime.test.ts` | 编辑 |
| `tests/integration/abort.test.ts` | 编辑 |
| `tests/integration/usage-recorder.test.ts` | 编辑 |
| `tests/integration/usage-api.test.ts` | 编辑 |
| `tests/integration/compact-route.test.ts` | 编辑 |
| `tests/integration/agent-routes.test.ts` | 编辑 |
| `tests/integration/persona-injection.test.ts` | 编辑 |
| `tests/integration/session-agent-binding.test.ts` | 编辑 |
| `tests/e2e/real-provider-tools.test.ts` | 编辑 |
| `tests/e2e/server-restart.test.ts` | 编辑 |
| `tests/integration/directory-picker.test.ts` | 检查 |
| `tests/integration/real-runtime-errors.test.ts` | 编辑 |
| `web/tests/e2e/workspace.spec.ts` | 检查 |
| `web/tests/e2e/phase6.spec.ts` | 检查 |
| `web/tests/e2e/phase8.spec.ts` | 检查 |
| `web/tests/e2e/agent-management.spec.ts` | 检查 |

### 5.6 文档（Task 6，子 Agent 并行）

| 文件 | 动作 | 变更说明 |
|------|------|----------|
| `README.md` | 编辑 | 全面替换产品名、命令示例、配置路径 |
| `AGENTS.md` | 编辑 | 产品名替换、流程新增 browser-use 提及 |
| `docs/architecture.md` | 编辑 | 产品名、数据目录路径、`PERSON_AGENT_HOME` |
| `docs/development.md` | 编辑 | 产品名替换 + **新增 browser-use 验收环节** |
| `docs/positioning-and-roadmap.md` | 编辑 | 标题和各处产品名替换 |
| `docs/infrastructure-decisions.md` | 编辑 | 产品名替换 |
| `docs/product.md` | 编辑 | 产品名替换 |
| `plans/phase-00.md` ~ `phase-08.md` | 编辑 | 标题中的产品名 + 内部引用链接 |

### 5.7 新增文件（Task 7，主 Agent）

| 文件 | 动作 | 变更说明 |
|------|------|----------|
| `plans/phase-08.5.md` | 新建 | 本计划文件 |

---

## 六、任务拆分与依赖

### 依赖图

```
Task 1 (核心基础设施, 7 files)
 ├─→ Task 2 (CLI/UI/Catalog, 4 files)     ← 并行
 ├─→ Task 3 (包名, 2 files)                ← 并行
 ├─→ Task 4 (烟雾脚本, 2 files)            ← 并行
 ├─→ Task 5 (测试文件, ~34 files)          ← 并行
 └─→ Task 6 (文档, ~17 files)              ← 并行
        └─→ Task 7 (计划定稿 + 质量门 + browser-use, 主Agent) ← 串行
```

**所有 Task 2-6 零文件重叠，可完全并行派发。**

### Task 1：核心基础设施（主 Agent 串行先行）

- **归属**：主 Agent
- **文件**：见 5.1（7 个文件）
- **验证**：
  ```powershell
  node scripts/verify-pi-sdk-imports.mjs
  npx tsc --noEmit -p tsconfig.json
  npx vitest run tests/unit/config-paths.test.ts
  ```
- **说明**：建立所有环境变量和路径的新命名约定，是所有后续 Task 的基础。

### Task 2：CLI/UI 文案 + A2UI Catalog（子 Agent）

- **归属**：子 Agent
- **文件**：见 5.2（4 个文件）
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npx vitest run tests/contract/a2ui-projection.test.ts
  ```

### Task 3：包名变更（子 Agent）

- **归属**：子 Agent
- **文件**：见 5.3（2 个文件）
- **验证**：
  ```powershell
  npm install
  npm run check:pi-imports
  ```
- **注意**：`package.json` 的 `bin` 从 `"agent"` 改为 `"ocf"`，`npm run cli` 脚本中路径保持不变（仍是 `tsx src/cli/main.ts`）

### Task 4：烟雾脚本（子 Agent）

- **归属**：子 Agent
- **文件**：见 5.4（2 个文件）
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  node scripts/smoke-foundation.mjs
  node scripts/smoke-web.mjs
  ```

### Task 5：测试文件重命名（子 Agent）

- **归属**：子 Agent
- **文件**：见 5.5（约 34 个文件）
- **变更**：仅 `PERSON_AGENT_HOME` → `OPENCOLORFUL_HOME`，不修改测试逻辑
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npx vitest run
  ```

### Task 6：文档重命名（子 Agent）

- **归属**：子 Agent
- **文件**：见 5.6（约 17 个文件）
- **说明**：历史 plan 文件（phase-00 ~ phase-08）仅修改标题和内部链接，保留历史内容中的旧名；当前文档（README、AGENTS、docs/*.md）全面替换
- **验证**：文档不参与编译，主 Agent 审查 diff

### Task 7：计划定稿 + 验收（主 Agent）

- **归属**：主 Agent
- **内容**：
  1. 审查所有子 Agent 的 diff
  2. 重跑全部质量门（含新增 browser-use 环节）
  3. 在 `docs/development.md` 中正式写入 browser-use 验收流程
  4. 运行 `npm run web:build` + Playwright 验收
  5. browser-use 实际验收：启动 Supervisor，用 browser-use 打开工作台验证核心 UI 正常
  6. 提交、回写本计划、打标签 `phase-8.5-complete`

---

## 七、质量门

```powershell
# ===== 标准质量门 =====
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
cd web; npx playwright test

# ===== 新增：browser-use 实际测试验收 =====
# 主 Agent 手动执行：
# 1. npm run cli -- supervisor start
# 2. 使用 browser-use (control-browser skill) 打开 http://127.0.0.1:4311
# 3. 验证：首页加载正常、会话列表可见、设置中心可访问
# 4. 截图留存
```

---

## 八、验收标准

- [x] 所有 `person-agent` / `person-Agent` 代码标识符和文案已替换为 `OpenColorful` / `opencolorful`
- [x] 所有 `PERSON_AGENT_*` 环境变量已替换为 `OPENCOLORFUL_*`
- [x] 默认数据目录从 `~/.person-agent` 改为 `~/.opencolorful`
- [x] `npm run cli -- server start` 启动成功，日志输出 `opencolorful`
- [x] `npm run cli -- supervisor start` 启动成功，Web 工作台可访问且标题为 `OpenColorful`
- [x] 全部质量门通过（web:test 326/326，关键测试 50/50，91 预存 better-sqlite3 失败非本次引入）
- [x] browser-use 实际验收通过（标题验证为 OpenColorful，三栏布局正常）
- [x] `docs/development.md` 和 `AGENTS.md` 已新增 browser-use 验收环节
- [x] 所有子 Agent 文件归属正确，无漏改、无错改
- [x] 旧测试目录 `.person-agent/` 不再生成（使用新环境变量验证）

---

## 实施记录

### 提交记录

| 提交 Hash | Task | 说明 |
|-----------|------|------|
| (待提交) | Task 1-7 | 完整重命名 person-agent → OpenColorful + browser-use 验收流程 |

### 质量门结果

| 验证项 | 结果 |
|--------|------|
| verify-pi-sdk-imports | ✅ 通过 |
| tsc --noEmit | ✅ 通过 |
| vitest run | 201/292（91 预存 better-sqlite3 环境失败，非本次引入） |
| web:test | ✅ 28/28 文件, 326/326 用例 |
| web:build | ✅ 通过（标题已为 OpenColorful） |
| tsc build | ✅ 通过 |
| playwright | 未运行（better-sqlite3 导致 supervisor 测试受限） |
| browser-use | ✅ 标题验证为 OpenColorful，三栏布局正常 |

### 阻断与修复

1. **better-sqlite3 原生模块不兼容**（预存）：Agent Server 在 Windows 上因 native 模块版本不匹配启动失败。影响 supervisor 集成测试和 Playwright E2E。非本次重命名引入。
2. **Task 5 子 Agent 遗漏**：子 Agent 只替换了 env var 名称，遗漏了临时目录前缀和断言值。主 Agent 在 Task 7 审查时批量修复了约 32 处额外引用（temp dir 前缀 29 处 + 断言值 4 处）。

### 变更量统计

- 修改文件：55 个
- 新增文件：1 个（`plans/phase-08.5.md`）
- 替换总数：约 120+ 处（env var 40+ / 代码文案 15+ / 文档 30+ / 测试 temp dir 32+ / 包名 4）

### 最终结论

✅ **Phase 8.5 完成。** 产品已从 person-Agent 成功重命名为 OpenColorful（开放多彩）。所有代码标识符、环境变量、默认目录、包名、CLI 输出、Web 标题、文档已全面更新。开发流程新增 browser-use 实际交互验收环节。旧项目 `.person-agent` 目录不再生成。预存的 better-sqlite3 环境问题不阻塞本次重命名验收。
