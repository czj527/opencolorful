# Phase 0：项目骨架和协议契约

## 实施状态

**已完成（2026-07-21）**

| 任务 | 提交 | 结果 |
|---|---|---|
| P0-01 | `8052486` | TypeScript ESM、Vitest、固定依赖和构建脚本 |
| P0-02 | `0b29329` | 运行目录、环境 fallback 和 API Error |
| P0-03 | `9d72174` | 平台事件、命令、Schema 和序号守卫 |
| P0-04 | `1b38e24` | SQLite WAL、迁移和 Session 元数据索引 |
| P0-05 | `68c6861` | PI SDK Adapter、版本探针和 import 边界 |
| P0-06 | `ae709d2` | Hono 健康检查和本地 Server 生命周期 |

最终验证：`npm run check` 通过，共 6 个测试文件、29 个测试用例；Windows 后台
start/status/health/stop/logs 手动链路通过。

## 目标

建立可构建、可测试、可启动的基础项目，并锁定 PI SDK Adapter、平台事件、配置
目录、SQLite 元数据和 Server 生命周期的最小契约。Phase 0 不调用真实模型。

## 完成定义

- `npm install`、`npm run build`、`npm run typecheck`、`npm test` 可执行；
- PI SDK 版本和 import 边界有自动检查；
- 平台事件和 API Error 可验证；
- SQLite 可以创建、关闭和重新打开；
- `agent server start` 和 `start --foreground` 可启动健康检查；
- `agent server stop/status/logs` 可管理本地 Server；
- 没有 Provider Key、真实 Session 或 Web UI。

## 任务顺序

### P0-01：工具链基线

**创建文件**

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `tsconfig.build.json`
- `vitest.config.ts`
- `src/index.ts`
- `tests/smoke/project.test.ts`

**工作内容**

- 初始化单 package TypeScript ESM 项目；
- 固定 Node、TypeScript、Vitest 和 PI SDK 版本；
- 添加 `build`、`typecheck`、`test`、`check` 脚本；
- 增加一个无网络 smoke test；
- 记录 Node 版本约束。

**验证**

```powershell
npm install
npm run check
```

预期：安装完成，构建、类型检查和测试全部通过。

**提交**：`chore: initialize TypeScript project`

### P0-02：配置目录和错误类型

**创建文件**

- `src/config/paths.ts`
- `src/config/environment.ts`
- `src/contracts/api-error.ts`
- `tests/unit/config-paths.test.ts`

**工作内容**

- 实现默认 `~/.person-agent` 路径；
- 支持 `PERSON_AGENT_HOME` 开发覆盖；
- 对所有运行时子目录使用集中路径函数；
- 定义稳定的 `ApiError` 结构和错误码；
- 禁止调用方自行拼接用户数据路径。

**验证**

```powershell
npx vitest run tests/unit/config-paths.test.ts
```

预期：Windows 路径、环境覆盖和默认路径用例通过。

**提交**：`feat: add runtime path contracts`

### P0-03：平台事件契约

**创建文件**

- `src/contracts/events.ts`
- `src/contracts/commands.ts`
- `src/contracts/validation.ts`
- `tests/contract/events.test.ts`

**工作内容**

- 使用 TypeBox 定义 `PlatformEventEnvelope`；
- 定义 health、session status、message、tool、turn 和 error 事件；
- 定义 Abort、Compact、Subscribe 和 Resume 命令；
- 校验 `protocolVersion`、Session ID、stream ID 和递增序号；
- 为未知事件保留显式拒绝行为。

**验证**

```powershell
npx vitest run tests/contract/events.test.ts
```

预期：合法事件通过，缺少身份、无效时间和非法序号被拒绝。

**提交**：`feat: define platform event protocol`

### P0-04：SQLite 元数据仓库

**创建文件**

- `src/storage/database.ts`
- `src/storage/migrations.ts`
- `src/storage/session-index.ts`
- `tests/integration/session-index.test.ts`

**工作内容**

- 创建 `metadata.sqlite` 并启用 WAL；
- 建立 schema version 表；
- 建立 Session 元数据表和唯一 Session ID；
- 实现 create、get、list、touch 和 archive；
- 测试关闭后重新打开仍可读取；
- 消息正文不得写入该数据库。

**验证**

```powershell
npx vitest run tests/integration/session-index.test.ts
```

预期：迁移幂等、Session 重开可读、归档过滤正确。

**提交**：`feat: add session metadata index`

### P0-05：PI SDK Adapter 边界

**创建文件**

- `src/pi-sdk/index.ts`
- `src/pi-sdk/version.ts`
- `src/pi-sdk/types.ts`
- `scripts/verify-pi-sdk-imports.mjs`
- `tests/contract/pi-sdk-adapter.test.ts`

**工作内容**

- 从 Adapter 集中导出 Session、Auth、Model 和工具工厂；
- 验证已安装 PI SDK 版本；
- 扫描 `src/`，禁止 Adapter 之外直接 import `@earendil-works/pi-*`；
- 用 PI faux provider 或 in-memory Session 完成无网络兼容测试；
- 不 import SDK 私有深路径，除非有明确兼容注释和测试。

**验证**

```powershell
node scripts/verify-pi-sdk-imports.mjs
npx vitest run tests/contract/pi-sdk-adapter.test.ts
```

预期：边界检查和无网络 Session 测试通过。

**提交**：`feat: establish PI SDK adapter`

### P0-06：Server 健康检查和本地生命周期

**创建文件**

- `src/server/app.ts`
- `src/server/start.ts`
- `src/server/runtime-state.ts`
- `src/cli/main.ts`
- `src/cli/server-command.ts`
- `tests/integration/server-health.test.ts`

**工作内容**

- 创建 Hono app 和 `/api/health`；
- 支持前台 `agent server start --foreground`；
- 支持后台 `agent server start`，Windows 后台进程必须隐藏窗口；
- 支持 `agent server stop`、`status` 和 `logs`；
- 将 PID、端口、版本和状态原子写入 `runtime/server.json`；
- 默认只监听 `127.0.0.1`；
- 异常退出后 status 能识别陈旧 PID。

**验证**

```powershell
npx vitest run tests/integration/server-health.test.ts
npm run cli -- server start --foreground
npm run cli -- server status
npm run cli -- server stop
```

预期：测试可启动临时端口并收到健康响应；手动命令显示 online，停止后显示 stopped。

**提交**：`feat: add server health lifecycle`

### P0-07：Phase 0 质量门和标签

**修改文件**

- `README.md`
- `docs/architecture.md`
- `plans/phase-00.md`

**工作内容**

- 更新真实命令和目录结构；
- 运行完整检查；
- 确认 Git 中没有 `.env`、数据库、日志或 Session；
- 记录 Phase 0 完成结果和已知限制；
- 创建本地标签 `phase-0-complete`。

**验证**

```powershell
npm run check
git status --short
git ls-files | Select-String -Pattern '\.env|\.sqlite|sessions|\.log'
```

预期：检查通过，工作区干净，敏感运行数据未被跟踪。

**提交**：`docs: complete phase 0 foundation`

## 风险控制

- 如果 PI npm 发布版与本地参考源码存在差异，先在 Adapter 测试中明确，不复制 SDK。
- better-sqlite3 安装失败时先解决 Node ABI，不替换成临时 JSON 双写方案。
- Phase 0 不注册系统服务，不加入真实模型请求、TUI 或 Web UI。

## 已知限制

- 本阶段的 faux provider 和内存凭据仅用于无网络兼容验证；
- Provider 设置、持久化凭据和真实 PI JSONL Session 属于 Phase 1；
- Server 当前只有健康检查，尚无 SSE、WebSocket 和认证；
- 日志暂不轮转，远程访问暂不开放。
