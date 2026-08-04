# OpenColorful 插件开发指南

面向插件开发者的 Phase 12 开发者文档（plans/phase-12.md §十五 / §十六）。
本文只介绍**插件作者视角**的用法；平台内部架构见 [架构说明](architecture.md)。

## 目录

1. [快速开始](#快速开始)
2. [Manifest v1 参考](#manifest-v1-参考)
3. [SDK 包与辅助函数](#sdk-包与辅助函数)
4. [脚手架](#脚手架)
5. [Dev Loop（开发循环）](#dev-loop开发循环)
6. [Dev Scenario（开发场景）](#dev-scenario开发场景)
7. [权限模型](#权限模型)
8. [安全说明](#安全说明)
9. [发布校验](#发布校验)

---

## 快速开始

```bash
# 1. 用 SDK 脚手架生成插件骨架（生成 manifest.json + 目录结构）
node -e "import('@opencolorful/plugin-sdk').then(({createPlugin}) => createPlugin({ id: 'my.org-plugin', name: 'My Plugin', outDir: 'my-plugin', includeTool: true }))"

# 2. 编辑 my-plugin/manifest.json 与资源（工具、Surface、配置等）

# 3. 本地质量门校验
node scripts/verify-plugin-package.mjs my-plugin

# 4. 启动 Server 后进入开发循环（T10 完成 Server 端点接线后可用）
ocf plugins dev install my-plugin
ocf plugins dev run-scenario my.org-plugin echo-basic --agent <agentId>
```

最小 bundle 插件目录：

```text
my-plugin/
├─ manifest.json             必须
├─ skills/                   技能（只登记、不激活）
├─ dev/scenarios/*.json      dev scenario 文件
├─ ui/                       Settings Page / Widget / Chat Surface 静态资源
└─ src/index.js              （node-process 代码插件时）worker 入口
```

## Manifest v1 参考

`manifest.json` 顶层字段（未知字段默认拒绝）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `manifestVersion` | 是 | 恒为 `1` |
| `id` | 是 | 全局稳定，`^[a-z0-9][a-z0-9._-]{0,127}$`，不可因更新改变 |
| `name` | 是 | 显示名，≤128 |
| `version` | 是 | SemVer |
| `description` | 否 | ≤1024 |
| `author` | 否 | `{ name, email?, url? }` |
| `license` | 否 | ≤128 |
| `compatibility` | 是 | `{ opencolorful: ">=0.1.0", pluginApi: 1 }` |
| `trust` | 是 | `restricted` 或 `full-access`；代码运行时必须 `full-access` |
| `runtime` | 是 | `{ kind, entry? }`；kind ∈ `bundle` / `mcp` / `node-process` / `python-process` |
| `permissions` | 是 | 能力请求数组（能力族见下文），≤256 |
| `contributions` | 是 | 12 类扩展点声明 |
| `config` | 否 | 非敏感配置 JSON Schema（Secret 只声明不存值） |
| `dev` | 否 | `{ sourceDir?, engines? }` 开发提示 |

### 12 类扩展点（`contributions`）

| kind | 必填字段 | 说明 |
|---|---|---|
| `tool` | `id`, `name` | `riskLevel`、`inputSchema`/`outputSchema`、`requiredCapabilities` |
| `command` | `id`, `name` | `argumentsSchema` |
| `route` | `id`, `name`, `path` | namespaced 路径，禁止占用平台保留段 |
| `page` / `widget` / `chat-surface` | `id`, `name` | `entry` 静态资源入口、`hostCapabilities` |
| `background` | `id`, `name` | `maxConcurrency`、`maxRetries`、`timeoutMs` |
| `hook` | `id`, `name`, `point` | 平台冻结时点；`behavior: block\|observe` |
| `config` | `id`, `name` | `schema`（JSON Schema 子集） |
| `secret` | `id`, `name`, `secretName` | 只声明名称与用途，不保存值 |
| `context-attachment` | `id`, `name` | `schema` 结构化附件类型 |
| `custom-activity` | `id`, `name`, `eventNamespace` | `plugin.<pluginId>.<domain>`，默认 routine |
| `skill-bundle` | `id`, `name` | `skillsDir` 只登记、不激活 |

官方 `sdk-showcase`（`examples/plugins/sdk-showcase`）覆盖全部 12 类，是
Manifest 的权威示例。

## SDK 包与辅助函数

三个独立 SDK 包（import boundary 由 `scripts/verify-plugin-imports.mjs` 强制，
**不得 import Server 内部实现**）：

- `@opencolorful/plugin-sdk`：插件开发辅助 + 协议类型 re-export。
- `@opencolorful/plugin-runtime`：Node worker 侧 JSON-RPC 服务端骨架。
- `@opencolorful/plugin-components`：iframe UI SDK 类型与 Host request 契约
  （本阶段只有类型/接口 + 文档，真实桥后续阶段实现）。

### plugin-sdk 辅助函数

```ts
import {
  definePlugin, defineTool, defineRoute, defineSurface,
  defineConfig, defineSecret, defineBackground, defineHook,
  defineAttachment, defineActivity, defineSkillBundle,
  type ManifestV1, type ToolContribution,
} from "@opencolorful/plugin-sdk";

const manifest: ManifestV1 = definePlugin({
  id: "my.org-plugin",
  name: "My Plugin",
  version: "1.0.0",
  permissions: [{ capability: "tool.register" }],
  contributions: {
    tool: [defineTool({ id: "echo", name: "Echo", riskLevel: "low" })],
    route: [defineRoute({ id: "info", name: "Info", path: "info" })],
    page: [defineSurface({ id: "settings", name: "Settings", entry: "ui/settings.html" }, "page")],
    secret: [defineSecret({ id: "api-key", name: "API Key", secretName: "api_key" })],
  },
});
```

辅助函数在开发期做 fail-closed 校验（非法字段立即抛 `PluginSdkError`）。
`definePlugin` 会填充默认值（`compatibility.opencolorful`、`trust: restricted`、
`runtime: bundle`）并全量校验。

### plugin-runtime（Node worker 骨架）

```js
import { createRuntimeServer } from "@opencolorful/plugin-runtime";

const server = createRuntimeServer({});
server.registerMethod("echo", (params) => {
  return { echoed: params?.text ?? "" };
});
server.start().catch((error) => { console.error(error); process.exit(1); });
```

把 `manifest.json` 的 `runtime` 改为 `{ "kind": "node-process", "entry": "src/index.js" }`
并声明 `trust: "full-access"` 后即可运行。worker 经 JSON-RPC/stdio 与 Host 握手，
stderr 不作为协议通道。

### plugin-components（iframe UI 类型声明）

```ts
import type { SurfaceContext, SurfaceHostApi, ThemeTokens } from "@opencolorful/plugin-components";
```

本阶段 `useHostApi` / `defineSurfaceComponent` 调用即抛
`PluginComponentsNotImplementedError`（真实 iframe 桥后续阶段实现）。

## 脚手架

`@opencolorful/plugin-sdk` 的 `createPlugin` 从空目录生成可安装骨架：

- `manifest.json`（当前 Manifest/API 版本）；
- `README.md`；
- `skills/` 示例技能（只登记）；
- `dev/scenarios/echo.json`（`includeTool: true` 时）；
- `src/index.js`（`runtimeKind: "node-process"` 时附带最小 worker 骨架）。

```ts
import { createPlugin } from "@opencolorful/plugin-sdk";
const { dir, files, manifest } = createPlugin({
  id: "my.org-plugin",
  name: "My Plugin",
  outDir: "my-plugin",
  includeTool: true,
});
```

目标目录非空且不是脚手架生成时默认拒绝（`overwrite: true` 覆盖）。

## Dev Loop（开发循环）

```text
ocf plugins dev install <sourceDir> [--full-access]
ocf plugins dev reload <pluginId>
ocf plugins dev enable <pluginId>
ocf plugins dev disable <pluginId>
ocf plugins dev reset <pluginId>
ocf plugins dev uninstall <pluginId>
ocf plugins dev diagnostics <pluginId>
ocf plugins dev invoke-tool <pluginId> <toolName> --agent <agentId> [--arg k=v ...]
ocf plugins dev list-surfaces
ocf plugins dev describe-surface <pluginId> <surfaceId>
ocf plugins dev run-scenario <pluginId> <scenarioName> [--agent <id>] [--destructive] [--approve]
```

要点：

- **dev 安装写入独立 dev 目录**（`<OPENCOLORFUL_HOME>/plugins-dev/<pluginId>`），
  不写正式插件目录；
- **每次 install / reload 生成新 `devRunId`**：旧运行上下文不能操作新实例
  （invoke-tool / run-scenario 携带 devRunId 校验，不匹配即拒绝）；
- **invoke-tool 复用真实权限与 Trace 包装**：指定 Agent/Session scope，
  复用 EffectivePolicy（manifest × grant × binding × session × sandbox）
  与 RuntimeHost 包装（`plugin.execution.*` 生命周期）；插件未绑定到该
  Agent 时返回"未绑定"错误，不 bypass 权限；
- **full-access 开发插件按 dev slot 或逐次授权**：`install --full-access`
  授予全部能力（含高风险）；否则只授予 manifest 请求中的非高风险能力；
- **dev.* Activity 自动记录**：`plugin.dev.installed` / `plugin.dev.reloaded` /
  `plugin.dev.scenario_completed` / `plugin.dev.scenario_failed`；config/secret
  变更走既有 `audit.plugin.config_change_*` / `audit.plugin.secret_change_*`
  三阶段严格审计。

> Server 的 `/api/plugins/dev/*` 端点由主 Agent（T10）接线；接线前 CLI 返回
> 明确错误"dev 端点未接线"。

## Dev Scenario（开发场景）

场景文件位于插件 `dev/scenarios/<name>.json`：

```json
{
  "name": "echo-basic",
  "description": "调用 echo 工具并断言结果",
  "destructive": false,
  "steps": [
    {
      "kind": "invoke-tool",
      "tool": "echo",
      "args": { "text": "hello" },
      "expect": { "result": { "echoed": "hello" }, "requireConfirmation": false }
    },
    { "kind": "open-surface", "surface": "settings-page" }
  ]
}
```

- `steps.kind`：`invoke-tool`（工具调用 + `expect.result` deep-equal 断言 +
  `expect.requireConfirmation` 断言）或 `open-surface`（Surface 登记与受控
  asset 校验，触发 `plugin.surface.opened`）；
- `destructive: true` 的场景必须显式批准：`run-scenario ... --approve`，
  或先调用 Dev Host 的 `approveDestructive(pluginId, devRunId, scenarioName)`；
  未批准 → 场景失败并记录 `plugin.dev.scenario_failed`（reasonCode
  `destructive-approval-required`）；
- 场景通过 → `plugin.dev.scenario_completed`；任一步失败 → 场景立即终止并
  记录 `plugin.dev.scenario_failed`（含 stepIndex）。

## 权限模型

```text
effective capability
= manifest 请求
  ∩ 平台级授权（plugin_grants，dev 安装自动授予非高风险请求能力）
  ∩ Agent 绑定（agent_plugin_bindings，必须绑定且启用）
  ∩ Session/Runtime 策略
  ∩ Phase 9 Sandbox 策略
```

- 能力族枚举：`filesystem.read/write`、`network.connect`、`process.spawn`、
  `secret.read-own`、`tool.register`、`route.register`、`ui.surface`、
  `ui.host.*`、`resource.open/pick`、`background.run`、`hook.register`、
  `activity.emit`、`provider.register`；
- 高风险能力（`secret.read-own` / `process.spawn` / `network.connect` /
  `filesystem.write`）必须用户显式确认（dev 下为 `--full-access`）；
- 绑定只引用授权（`grantRevision`），不替代授权；
- 插件不能自报平台权威字段（actor/scope/trace/eventId/audit 等）；
  自定义 Activity 只能使用 `plugin.<pluginId>.<domain>.<action>` namespace。

## 安全说明

- 代码运行时（node-process / python-process）必须在独立进程中运行，且
  manifest 必须声明 `trust: full-access`——独立进程不能冒充安全边界；
- 插件不能直接打开平台 SQLite、Replay Store、spool、AuthStorage 或 Audit
  ledger；不能修改 Agent 底色、长期记忆、Provider 凭据或平台设置；
- 安装器不运行来源包中的任何命令（postinstall/脚本一律不执行）；
- Secret 值绝不进入日志/Trace/payload/错误消息；UI 不获得 Secret 原文；
- dev 安装只写入 `plugins-dev/`，卸载/重置会清理 dev 目录并保留 Audit 事实。

## 发布校验

```bash
node scripts/verify-plugin-package.mjs <plugin-dir> [<plugin-dir> ...]
```

校验 manifest 顶层字段、id/version/兼容范围、trust/runtime、permissions
能力枚举、contributions 逐类字段与必填项、config/dev、代码运行时 entry、
Surface entry、skills 目录、dev/scenarios 文件结构。任何错误以非零码退出。
