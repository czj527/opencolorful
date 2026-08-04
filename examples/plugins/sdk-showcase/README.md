# SDK Showcase

OpenColorful Phase 12 官方 SDK 示例插件：覆盖全部 12 类扩展点声明与
dev loop 场景，不依赖任何付费外部服务，不承担 Browser / Office / Media
业务实现。

## 内容

| 类别 | contribution id | 说明 |
|---|---|---|
| restricted Tool | `echo` | 低风险，原样返回输入 |
| 需要确认 Tool | `delete-file` | riskLevel=high，平台要求权限确认 |
| Command | `showcase-summary` | 命令描述示例 |
| Route | `info-route` | namespaced 路由 `/api/plugins/example.sdk-showcase/info` |
| Settings Page | `settings-page` | `ui/settings.html` |
| Widget | `status-widget` | `ui/widget.html` |
| Chat Surface | `chat-example` | `ui/chat.html` |
| Background | `heartbeat` | 后台任务声明 |
| Hook | `session-observer` | `session.started` observe |
| Config | `showcase-config` | JSON Schema 非敏感配置 |
| Secret | `api-key` | 只声明名称与用途，不存值 |
| Context Attachment | `code-snippet` | 结构化附件 Schema |
| Custom Activity | `showcase-events` | `plugin.example.sdk-showcase.events.<action>` |
| Skill Bundle | `skills` | 只登记、不激活 |
| dev scenario | `dev/scenarios/*.json` | echo / open-surfaces / destructive 示例 |

## 本地校验

```bash
node scripts/verify-plugin-package.mjs examples/plugins/sdk-showcase
```

## Dev Loop

```bash
# 启动 Server 后（T10 接线 dev 端点前会返回明确错误）
ocf plugins dev install examples/plugins/sdk-showcase
ocf plugins dev run-scenario example.sdk-showcase echo-basic --agent <agentId>
```
