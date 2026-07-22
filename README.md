# person-Agent

基于 PI SDK 构建的本地优先 Agent 平台。

Phase 0 基础骨架已完成。Phase 1 已完成——SSE/WS/TUI/A2UI/TokUI 基础设施。
Phase 2 已完成——Provider/凭据驱动真实 LLM、PI 内置工具三级权限（off/read-only/all）、
Provider 错误映射、思考级别和真实 Provider/工具重启 E2E。
Phase 3 已完成——Supervisor 进程管理 + React Web 工作台（三栏布局、流式聊天、
Provider/Session 设置、Playwright E2E）。当前标签：`phase-3-complete`。

## 开始开发

```powershell
npm install
npm run check

# 可选：把开发数据隔离在项目内（该目录已被 Git 忽略）
$env:PERSON_AGENT_HOME = "$PWD\.person-agent"

npm run cli -- server start
npm run cli -- server status
npm run cli -- server logs
npm run cli -- server stop
```

前台调试使用：

```powershell
npm run cli -- server start --foreground
```

默认监听 `127.0.0.1:4310`，健康检查地址是
`http://127.0.0.1:4310/api/health`。

## Supervisor 和 Web 工作台

```powershell
# 启动 Supervisor（默认端口 4311，Agent Server 端口 4310）
npm run cli -- supervisor start

# 自定义端口
npm run cli -- supervisor start --port 4311 --agent-port 4310
```

Supervisor 管理 Agent Server 的生命周期（启动、停止、重启），并提供 Web 静态资源。
Agent Server 停止时 Supervisor 仍保持在线，可通过 API 重新启动。

Web 工作台使用 React + Vite 构建，位于 `web/` npm workspace：

```powershell
# Web 开发模式（Vite 代理到 Agent Server）
npm run web:dev

# Web 生产构建
npm run web:build

# Web 单元测试
npm run web:test

# Playwright 浏览器 E2E
cd web && npx playwright test
```

## 文档

- [产品说明](docs/product.md)
- [架构说明](docs/architecture.md)
- [基础设施设计](docs/superpowers/specs/2026-07-21-agent-platform-foundation-design.md)
- [Phase 0 计划](plans/phase-00.md)
- [Phase 1 计划](plans/phase-01.md)
- [Phase 2 计划](plans/phase-02.md)
- [Phase 3 计划](plans/phase-03.md)
- [Agent 协作指南](AGENTS.md)

## 参考项目

`<local-workspace>\pi`、`<local-workspace>\oh-my-pi` 和 `<local-workspace>\openhanako` 是独立的
参考仓库，不属于本项目 Git 历史。

## 开发原则

- 复用 PI SDK 已有能力，不复制 Provider、Session 和工具协议。
- 所有 PI SDK import 收敛到适配层。
- 用户配置通过持久化设置完成，环境变量只作开发 fallback。
- TUI 和 Web 都通过 Server 协议访问 Runtime。
- 关键边界必须测试，低风险胶水代码不强制完整 TDD。
- 每个 Phase 都要有明确的范围、验收条件和独立提交。

## 当前限制

- OAuth、沙盒和逐次工具审批仍未完成；
- 私人助理、Coding Agent Profile、记忆、多 Agent、插件不在当前范围内；
- Electron、LAN/远程访问和云端同步未实现；
- Web UI 的 A2UI/TokUI 投影组件尚未连接到实时事件流；
- Supervisor 不提供系统服务注册，仅作为本地进程管理器。
