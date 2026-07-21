# person-Agent

基于 PI SDK 构建的本地优先 Agent 平台。

Phase 0 基础骨架已经完成。Phase 1 正在实施，已完成 Provider/凭据持久化、PI JSONL
Session 生命周期，以及基于真实 PI AgentSession + faux provider 的 Prompt、流式事件
归一化和 Abort。下一步是 Replay Store 与可恢复 SSE，然后进入 WebSocket 和 TUI。

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

## 文档

- [产品说明](docs/product.md)
- [架构说明](docs/architecture.md)
- [基础设施设计](docs/superpowers/specs/2026-07-21-agent-platform-foundation-design.md)
- [Phase 0 计划](plans/phase-00.md)
- [Phase 1 计划](plans/phase-01.md)
- [Agent 协作指南](AGENTS.md)

## 参考项目

`<local-workspace>\pi`、`<local-workspace>\oh-my-pi` 和 `<local-workspace>\openhanako` 是独立的
参考仓库，不属于本项目 Git 历史。

## 开发原则

- 复用 PI SDK 已有能力，不复制 Provider、Session 和工具协议。
- 所有 PI SDK import 收敛到适配层。
- 用户配置通过持久化设置完成，环境变量只作开发 fallback。
- TUI 和未来 Web 都通过 Server 协议访问 Runtime。
- 关键边界必须测试，低风险胶水代码不强制完整 TDD。
- 每个 Phase 都要有明确的范围、验收条件和独立提交。

## 当前限制

- Provider 设置和凭据已可持久化，但真实 Provider Prompt 的生产组合尚未接入；
- 当前 AgentSession Prompt 闭环使用 faux provider；
- 生产 Server 尚未组装新增 Service，直接启动仍只开放健康检查；
- SSE、WebSocket、TUI、A2UI/TokUI 和 Web UI 尚未完成；
- 当前 Server 仅面向本机 loopback，不提供远程认证。
