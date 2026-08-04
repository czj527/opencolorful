# Phase 12：通用插件系统与生态兼容层

**状态：已实施（T1-T10 完成 + 评审修复轮 T11 完成，2026-08-04），待用户真实验收** | 建议分支：`phase-12-plugin-system`
**基线：** `main`（Phase 10.5 / Phase 11 合并点，`2d15610`）
**架构权威：** 本文（审定后）；如实施期拆出 `docs/plugin-architecture.md`，该文档只承载稳定架构，范围与验收仍以本计划为准
**路线图依据：** [docs/positioning-and-roadmap.md](../docs/positioning-and-roadmap.md) Phase 12
**参考：** openhanako `PLUGINS.md` / `PLUGIN_SDK.md` / `core/plugin-manager.ts`；OpenClaw `docs/plugins/`；Hermes `plugins/` 与 `hermes_cli/plugins.py`

> 本文审定后可交给开发 Agent 继续拆分实现任务；不替 Phase 13、14 做设计。

---

## 一、目标

Phase 12 建立 OpenColorful 的通用插件基础设施，使平台能力可以由插件提供、替换和组合，并让开发者获得接近 OpenHanako 的本地插件开发体验。

本阶段不以 Browser Use 或任何单一业务能力作为目标。官方示例使用 `sdk-showcase`，验证插件协议、运行时、配置、权限、UI、日志和开发循环，而不是验证浏览器能力。

Phase 12 必须交付：

1. OpenColorful 原生插件 Manifest v1，以及 Plugin Protocol、Runtime SDK、Server SDK 和 UI SDK；
2. §八 的 10 类扩展点（Tool、Command、Provider、Route、Page/Widget/Chat Surface、Background/Lifecycle Hook、Config/Secret、Context Attachment、Custom Activity、Skill Bundle 登记）；
3. Bundle、MCP、Node process、Python process 四类运行形态；
4. 插件发现、检查、安装、启用、禁用、更新、回滚、卸载和诊断；
5. 插件权限审查、Agent 绑定和不可变运行时权限快照；
6. OpenClaw 插件/市场来源适配器和 Hermes 插件/生态来源适配器；
7. Claude/Codex/Cursor 兼容 Bundle 与通用 MCP 导入；
8. Web 插件中心、兼容性报告、权限确认、配置和开发诊断页面；
9. OpenHanako 风格的开发态 install/reload/invoke/diagnostics/scenario 循环；
10. Phase 9 Sandbox 与 Phase 11 Activity/Audit/Trace/Diagnostic 全链路接入；
11. 不依赖付费外部服务的官方 `sdk-showcase` 示例插件和开发文档。

## 二、用户可感知变化

- 设置中新增完整“插件”工作页，包含已安装、发现、权限、开发和来源管理；
- 用户可以从本地目录、ZIP、Git、兼容市场来源检查并安装插件；
- 安装前可看到来源、版本、兼容等级、缺失能力、代码执行风险和权限请求；
- 用户可以启用/禁用、更新、回滚、卸载插件，并查看健康状态和诊断；
- Agent 编辑页可以绑定已启用插件，并配置该 Agent 的具体能力授权；
- 插件绑定和配置变化明确提示从下一 turn 生效，不改变当前 in-flight turn；
- 插件可以提供独立 Page、设置页、Widget 或 Chat Surface，但失败不会拖垮主界面；
- 开发者可以在 Web/CLI 中完成开发态安装、热重载、工具调用、Surface 检查和场景测试；
- 外部插件不兼容时显示精确诊断，不出现“安装成功但能力静默缺失”。

## 三、范围与非目标

本阶段明确不做：

- Browser Use、云浏览器、远程浏览器池或浏览器代理服务；
- Web 阶段的内置浏览器；本地 Core 浏览器延后到 Electron 产品化阶段；
- 技能发现、渐进披露、技能注入和技能市场；插件携带的 Skills 只登记为未激活资源；
- 技能自创、自动优化或从长期记忆生成技能；
- Subagent Runtime、多 Agent 协作、Channel、ACP 或任务 DAG；
- 自动运行插件安装脚本、`postinstall` 或来源仓库中的任意命令；
- 自动导入用户日常浏览器 Profile、Cookie、密码或 Token；
- 对 OpenClaw、Hermes 或其他生态承诺 100% 二进制/行为兼容；
- 允许插件直接打开平台 SQLite、Replay Store、spool、AuthStorage 或 Audit ledger；
- 允许插件修改 Agent 底色、长期记忆、Provider 凭据或平台设置，除非未来有专门受审 Host API。

## 四、核心架构决策

1. **本地优先**：安装、运行、配置和插件数据默认保存在本机；不依赖付费远程运行时。
2. **Bundle 优先**：能用声明式 Skills/MCP/配置解决时，不加载任意代码。
3. **Code 受控**：Node/Python 插件在独立进程中运行，不注入 Server 主进程。
4. **兼容但不伪装**：明确展示兼容等级、缺失能力和降级行为，不声称所有外部插件可直接运行。
5. **平台重新盖章**：权限、身份、Trace、Activity 和 Audit 由平台生成，插件不能自报。
6. **安装不等于启用**：安装、启用、绑定 Agent、授予权限是不同状态。
7. **扩展 Core，而不绕过 Core**：插件必须复用 Phase 9 Sandbox 和 Phase 11 Observability，不建立平行安全或日志系统。
8. **Source Adapter 与 Runtime Adapter 分离**：市场只负责发现和获取 Artifact，不能直接启用或执行插件。
9. **Web UI 使用 iframe 隔离**：当前阶段不动态 import 第三方 React 代码进入宿主 bundle。
10. **任意代码如实标记风险**：没有真实 OS 沙箱时，Node/Python 代码插件必须是 `full-access`，独立进程不能冒充安全边界。
11. **平台边界自动埋点**：安装器、Grant、Runtime、Contribution 和 Dev Host 公共 wrapper 自动记录 started/terminal；完整性不依赖插件作者手工写日志。

## 五、术语和状态

### 5.1 插件形态

```text
Bundle Plugin      Skills、MCP、配置、命令描述和静态资源
Tool Plugin        一个或多个 Agent Tool
Runtime Plugin     生命周期、后台任务、EventBus、动态注册
UI Plugin          Settings Page、Page、Widget、Chat Surface
Provider Plugin    模型、搜索、媒体、存储等可替换后端
Hook Plugin        Session、消息、Prompt、工具和生命周期 Hook
MCP Plugin         本地/远程 MCP Server 与可选 UI Resource
```

一个插件可以组合多种形态，但每个 contribution 必须单独声明权限和兼容状态。

### 5.2 生命周期状态

```text
discovered   仅发现元数据，未下载或未复制
staged       已解包到暂存区，尚未安装
installed    已持久化安装记录，但不运行
enabled      允许创建 Runtime，但不代表任何 Agent 可见
degraded     部分 contribution 不兼容或运行失败
disabled     保留安装与配置，不再运行
failed       安装/启动/迁移失败，可诊断或回滚
removed      已卸载，保留 Audit 和来源记录
```

`installed`、`enabled`、`bound`、`granted` 必须是四个不同概念：

- `installed`：插件存在于平台；
- `enabled`：平台允许加载它；
- `bound`：指定 Agent 可以使用它；
- `granted`：所需能力已经获得用户授权。

## 六、总体架构

```text
Plugin Sources
  ├─ OpenColorful Registry / Local Folder / ZIP / Git
  ├─ OpenClaw / ClawHub / npm-compatible source
  ├─ Hermes repository / Python source
  ├─ Claude / Codex / Cursor compatible bundle
  └─ MCP configuration
             │
             ▼
PluginSourceAdapter
             │
             ▼
NormalizedPluginManifest
             │
       ┌─────┴─────────┐
       ▼               ▼
Compatibility      Permission
Analyzer           Planner
       └─────┬─────────┘
             ▼
Staged Installer + Provenance
             │
             ▼
Plugin Registry / Grant Registry
             │
       ┌─────┼───────────────┐
       ▼     ▼               ▼
Bundle/MCP  Process Runtime  UI Surface Host
             │               │
             └──────┬────────┘
                    ▼
          Observability + Sandbox
```

`PluginManager` 只处理规范化后的插件模型，不直接包含 ClawHub、GitHub、npm 或 Hermes 仓库的专属逻辑。

## 七、Manifest v1 与持久化模型

### 7.1 Manifest v1

原生插件使用 `manifest.json`，第一版必须包含以下结构：

```json
{
  "manifestVersion": 1,
  "id": "example.sdk-showcase",
  "name": "SDK Showcase",
  "version": "1.0.0",
  "description": "OpenColorful plugin SDK example",
  "author": { "name": "OpenColorful" },
  "license": "MIT",
  "compatibility": {
    "opencolorful": ">=1.0.0",
    "pluginApi": 1
  },
  "trust": "restricted",
  "runtime": { "kind": "bundle" },
  "permissions": [],
  "contributions": {},
  "config": {},
  "dev": {}
}
```

Manifest 设计要求：

- `id` 全局稳定且不可因更新改变；
- `version` 使用 SemVer；
- `pluginApi` 明确宿主协议版本；
- 未知字段默认拒绝或发出明确诊断，不静默忽略高风险字段；
- Manifest 不能声明“已授权”或伪造平台安装状态；
- 外部生态 Manifest 先转换为 `NormalizedPluginManifest`，原始文件作为 provenance 保存；
- 配置 Schema 使用 JSON Schema/TypeBox 可验证子集；
- Secret 字段只能声明名称、用途和校验规则，不在 Manifest 保存值。

### 7.2 本地目录布局

```text
${OPENCOLORFUL_HOME}/
├─ plugins/
│  ├─ installed/<pluginId>/<version>/   不可变安装 Artifact
│  ├─ staging/<operationId>/            安装/更新暂存区
│  ├─ data/<pluginId>/                  插件业务数据
│  └─ cache/                            可清理的来源与包缓存
├─ plugins-dev/
│  └─ <pluginId>/                       开发态 Runtime copy
├─ plugin-dev-sources/                  可选开发源码目录
├─ config/
│  └─ plugin-sources.json               来源配置，不保存 Secret
└─ auth/
   └─ plugin-secrets.json               插件专属 Secret Store
```

目录要求：

- 所有路径由 `src/config/paths.ts` 统一生成，调用方不得自行拼接；
- 安装 Artifact 版本目录不可原地修改，更新通过新版本目录和 active version 切换；
- staging、ZIP 解包、Git checkout 和插件数据目录全部经过 PathGuard、canonical path 和 symlink/Junction 检查；
- 插件卸载默认保留 `data/<pluginId>`，只有用户显式选择时才删除业务数据；
- cache 可按预算清理，provenance、Audit 和安装历史不可随 cache 删除。

### 7.3 持久化与事实来源

SQLite migration v10 新增规范化状态表，至少包含：

```text
plugin_installations       已安装版本、active version、状态、来源、hash
plugin_grants              平台级权限授权与 revision
plugin_configs             全局/per-Agent 非敏感配置与 revision
agent_plugin_bindings      Agent 绑定、允许的 contributions、配置引用
plugin_runtime_instances   运行实例、版本、健康、最近失败和 restart budget
plugin_source_cache        来源元数据、版本索引和过期时间
plugin_operations          安装/更新/回滚/卸载操作与补偿状态
```

事实来源冻结为：

- 安装 Artifact 中的原始 Manifest 是包内容事实；
- SQLite `plugin_installations` 是安装、active version 和启用状态事实；
- SQLite plugin_grants / agent_plugin_bindings 是权限和 Agent 可见性事实；
- SQLite plugin_configs 是非敏感全局/per-Agent 插件配置及 revision 的事实来源；
- `auth/plugin-secrets.json` 的 `PluginSecretStore` 是插件 Secret 唯一事实来源；PI Provider AuthStorage 不承担插件 Secret；
- `plugins/data/<pluginId>` 是插件业务文件所有者目录；
- Activity/Audit 只记录行为证据，不替代 Registry 和 Grant 状态；
- Web 缓存、Source cache 和 Runtime 内存状态均不是权威数据。

### 7.4 版本与迁移

- Manifest、Plugin Protocol、Runtime IPC 和 UI Host API 分别版本化；
- 插件声明支持的 `pluginApi` 范围，平台拒绝不兼容 major；
- 插件配置迁移只能运行该插件声明且经用户授权的迁移入口；
- 任意代码迁移按代码插件风险等级执行，不允许安装器自动运行来源脚本；
- 更新失败时 active version、Grant 和 Agent binding 保持旧 revision；
- Registry migration 必须幂等，并覆盖全新数据库、旧版本升级和中断恢复。

## 八、扩展点契约

### 8.1 Tool

- 声明名称、描述、输入 Schema、输出类型、风险等级和所需能力；
- 工具名称在 Agent 可见层使用稳定 namespace，避免不同插件冲突；
- 工具调用由平台包装，自动记录 started/terminal、耗时、错误和权限结果；
- 插件不能自行决定是否需要用户确认；风险策略由平台目录和 Manifest 共同决定；
- 输出必须通过 Schema、大小限制和脱敏检查。

### 8.2 Command

- 注册用户明确触发的命令；
- Command 不自动绕过模型或工具权限；
- UI、CLI 和未来桌面端可共享同一命令描述；
- 命令执行仍进入统一 Trace。

### 8.3 Provider

- Provider 只通过稳定 Port 注册能力和配置 Schema；
- 凭据通过插件专属 Secret namespace 保存；
- 不允许插件直接读取其他 Provider 凭据；
- Provider 健康检查、模型目录和请求日志必须走平台接口。

### 8.4 Route

- 路由固定命名空间 `/api/plugins/:pluginId/*`；
- 平台注入 PluginRequestContext、身份、Agent/Session scope 和 Trace；
- 路由不能注册到根路径或覆盖 Core API；
- Body、Query、Response 全部进行 Schema 和大小限制；
- UI 调用插件 Route 使用短期 Surface Session，不使用永久票据。

### 8.5 Page / Widget / Chat Surface

- 当前 Web 阶段统一使用 sandboxed iframe，不动态 import 第三方 React 代码进宿主 bundle；
- 插件静态资源走受控 asset route；
- UI SDK 只暴露 Host mediated API，例如 theme、toast、plugin API、resource picker、clipboard 和 external open；
- iframe 默认禁止任意 top navigation、同源逃逸、直接文件系统和平台 Cookie；
- 每项 Host capability 单独声明和授权；
- 不允许卡片或页面通过原始 HTML 注入聊天主界面。

### 8.6 Background Service / Lifecycle Hook

- 服务和 Hook 必须有明确的启动、停止、超时和取消契约；
- Hook 按平台冻结的时点注册，不能任意 monkey patch Agent Loop；
- before Hook 失败默认阻止其负责的变更，after Hook 失败记录 degraded，不回滚已经完成且不可补偿的外部动作；
- 后台任务必须声明并发、重试、幂等键和资源预算；
- 插件禁用、更新或崩溃时必须终止其后台任务。

### 8.7 Config / Secret

- 插件配置和 Secret 分库存储；
- UI 不获得 Secret 原文；
- Runtime 只能读取自身声明并已授权的 Secret；
- Secret 不进入 Activity、Diagnostic、Trace payload 或错误信息；
- 配置更新使用 started → write → completed/failed 严格 Audit 生命周期；
- `auth/plugin-secrets.json` 采用与 PI AuthStorage 相同的权限策略（仅当前用户可读）；明文存储但不做额外加密，UI/日志/support bundle 一律不返回原文——与 Phase 11 hash chain 立场一致，不声称加密保护。

### 8.8 Context Attachment

- 插件可以定义结构化附件类型，但不能直接修改 Prompt；
- 平台验证附件 Schema、大小、来源和当前 Session 权限；
- Context Builder 决定如何将附件投影给模型；
- 附件必须可删除、可显示来源，并在引用失效时标记 stale。

### 8.9 Custom Activity

- Manifest 声明事件 namespace、版本和 payload Schema；
- 自定义事件默认只能是 `routine` Activity；
- 插件不能生成 Audit、`notable` 或 `milestone`；
- 平台重新生成 eventId、recordedAt、actor、executor、scope、trace 和 producer。

### 8.10 Skill Bundle

- Phase 12 只识别并登记插件携带的 `skills/` 目录；
- 不执行技能发现、注入、市场搜索或自动启用；
- UI 明确显示“等待技能系统支持”；
- Phase 12 不定义技能系统的 Skill precedence、snapshot 或 prompt budget——技能系统阶段未定（roadmap 已后移为"另行确定"），其契约由该阶段定义。

## 九、Runtime 与进程边界

### 9.1 Runtime 类型

```text
bundle          无任意代码，只加载声明式资源
mcp             通过 MCP Transport 调用
node-process    独立 Node 子进程
python-process  独立 Python 子进程
```

### 9.2 IPC

- Node/Python Runtime 使用版本化 JSON-RPC/stdio；
- 请求包含平台签发的一次性调用 token 和只读 Trace carrier；
- token 绑定 `pluginId + runtimeInstanceId + operationId`，单次消费；
- 插件返回的 actor、executor、ownerAgentId、sessionId、traceId 一律不可信，由平台覆盖；
- stdout/stderr 不作为协议通道，统一捕获为限长 Diagnostic；
- Runtime 崩溃必须被检测、记录并按预算重启，不能拖垮 Server。

### 9.3 Restricted 与 Full Access

- `restricted` 只适用于 Bundle、MCP broker 或真正受 OS/进程沙箱约束的 Runtime；
- 在 OS 级插件沙箱尚未闭环前，能直接调用 Node/Python 标准库的第三方代码必须标记 `full-access`；
- 不得用“独立进程”冒充安全隔离；独立进程首先解决故障隔离，不自动解决权限隔离；
- `full-access` 仍受 Host API、Agent grant、Audit 和用户确认约束；
- 平台必须在安装页明确说明代码插件等价于在本机运行第三方代码。

## 十、权限模型

权限结果按交集计算：

```text
effective capability
= manifest request
∩ installed plugin grant
∩ agent binding grant
∩ session/runtime policy
∩ Phase 9 sandbox policy
```

权限族至少包括：

```text
filesystem.read / filesystem.write
network.connect
process.spawn
secret.read-own
provider.register
tool.register
route.register
ui.surface
ui.host.external-open
ui.host.clipboard
resource.open / resource.pick
background.run
hook.register
activity.emit
```

高风险权限变更必须 fail-closed，并与授权结果写入同一严格 Audit 生命周期。

## 十一、Agent 绑定和生效时机

- 插件安装在平台级，能力授权和可见性在 Agent 级；
- Agent 设置保存插件绑定列表、允许的 contributions 和配置引用；
- 不在 Agent identity/base-color 中保存插件状态；
- 无 Agent Session 默认只获得 Core 能力和用户明确配置的全局默认插件；
- 插件绑定、配置或版本变更从下一 turn 生效；
- in-flight turn 使用不可变 `PluginExecutionSnapshot`，不能中途换工具实现；
- 每次工具调用记录实际插件版本和 snapshot id，便于回放和诊断；
- 插件更新失败时，旧版本继续可用或整体回滚，不允许同一 Runtime 半新半旧。

## 十二、安装来源与生态适配

### 12.1 Source Adapter

统一接口至少包含：

```text
search(query)
resolve(sourceRef)
listVersions(sourceRef)
fetchArtifact(sourceRef, version)
verifyArtifact(artifact)
readProvenance(artifact)
```

首批来源：

- 本地文件夹；
- ZIP；
- Git 仓库与固定 commit/tag；
- npm-compatible package；
- OpenClaw/ClawHub 来源；
- Hermes Git/Python 来源；
- MCP 配置导入。

不允许来源适配器直接启用插件；它只能返回 Artifact、元数据和 provenance。

### 12.2 兼容等级

```text
L1 discovery   名称、版本、作者、描述、来源和依赖
L2 resources   Skills、命令、模板、资源
L3 MCP         MCP Server 与工具描述
L4 tools       工具 Schema 与调用适配
L5 runtime     原生 Node/Python 运行时适配
L6 UI          Page、Widget、Chat Surface
```

安装前必须显示：

- 当前支持等级；
- 不支持的 contributions；
- 需要转换的字段；
- 所需 Runtime 和依赖；
- 权限请求；
- 是否需要 full-access；
- 更新来源和锁定版本。

### 12.3 OpenClaw

Phase 12 对 OpenClaw 的最低验收：

- 识别 `openclaw.plugin.json` 和兼容 bundle；
- 支持来源发现、版本解析、provenance 和权限预览；
- 导入可映射的 Tools、MCP、配置、命令和静态 Skills 资源；
- 对 OpenClaw 专属 Gateway、Channel、ACP、Hook 或内部 API 给出精确诊断；
- 受支持的 Node 工具可以通过兼容 worker 执行；
- 不把 OpenClaw 的 allow/deny 结果直接当成 OpenColorful 授权。

### 12.4 Hermes

Phase 12 对 Hermes 的最低验收：

- 识别 Hermes 插件目录、元数据和 Python 入口；
- 导入静态 Skills/资源；
- 受支持的工具通过 Python worker 暴露为 OpenColorful Tool；
- Python 依赖进入插件专属环境或受控解释器，不污染 Server；
- 依赖 Hermes Agent Loop、Gateway、全局单例或内部数据库的插件标记为部分兼容/不可运行；
- Python 异常、stderr 和超时进入统一 Diagnostic/Trace。

### 12.5 Claude/Codex/Cursor Bundle 与 MCP

- 支持导入静态 Skills、命令和 MCP 配置；
- Host 专属 Hooks、Agents、Commands 或 UI 不静默映射；
- MCP Server 使用平台 MCP broker、权限、超时和日志，不让配置绕过 Plugin Registry；
- Phase 12 只登记 Skills，不启用技能语义。

## 十三、安装、更新和卸载

```text
discover
→ inspect
→ fetch into staging
→ hash/provenance verification
→ normalize manifest
→ compatibility report
→ permission review
→ transactional install
→ health check
→ enable
```

要求：

- 同一 pluginId 的 install/update/rollback/uninstall 必须串行（per-plugin 操作锁或 operation 队列），并发冲突返回冲突状态，禁止并行写 active pointer 与版本目录；
- 安装目录使用不可变版本目录和独立 active pointer；
- 安装过程不执行来源包中的 postinstall；
- 更新先并行安装新版本，通过 health check 后原子切换；
- 保留上一可用版本用于回滚；
- completed Audit 失败时补偿恢复旧状态；
- 卸载先停止 Runtime/后台任务/Surface Session，再清理 active pointer 和授权；
- 插件业务数据默认保留并提供显式删除选项；
- provenance、Audit 和安全事件不随卸载删除。

## 十四、Web 插件中心

当前 Web 阶段提供真正可用的插件中心，不依赖 Electron：

```text
Installed      已安装、状态、版本、健康、更新、启停
Discover       来源搜索、详情、兼容等级、安装
Permissions    平台级和 Agent 级授权
Development    本地开发插件、重载、诊断、场景测试
Sources        市场/仓库来源和可信策略
```

交互要求：

- 使用独立详情页展示 Manifest、来源、兼容性和权限，不用简单确认弹窗承载复杂信息；
- 安装确认必须同时显示来源、版本、校验、代码执行风险和权限；
- 不兼容项区分 `unsupported`、`degraded`、`blocked`；
- Agent 编辑页可以绑定/解绑已启用插件并配置 per-Agent grant；
- 绑定变更明确提示“下一 turn 生效”；
- UI Surface 加载失败不能影响聊天和设置主页面；
- iframe 错误、CSP 拒绝和 Host capability 拒绝进入诊断视图。

## 十五、开发者 SDK 与 Dev Loop

参考 OpenHanako，提供：

```text
plugin dev install
plugin dev reload
plugin dev enable / disable
plugin dev reset / uninstall
plugin dev diagnostics
plugin dev invoke-tool
plugin dev list-surfaces
plugin dev describe-surface
plugin dev run-scenario
```

要求：

- 开发源码位于工作区或专用 dev source 目录；
- Runtime copy 位于独立 dev 安装目录，不写正式插件目录；
- 每次 install/reload 生成 `devRunId`，旧运行上下文不能操作新实例；
- `invoke-tool` 支持指定 Agent/Session scope，并复用真实权限和 Trace 包装；
- `run-scenario` 支持 tool invocation、结果断言、Surface 打开和 destructive 标记；
- Agent 可见的插件开发工具默认关闭，需用户显式启用；
- full-access 开发插件必须逐次或按 dev slot 明确授权；
- 提供 TypeScript 类型、JSON Schema、示例、脚手架和发布校验命令。

## 十六、SDK Showcase

官方示例插件只用于验证平台能力，至少包含：

- 一个 restricted Tool；
- 一个需要权限确认的 Tool；
- 一个 JSON Schema 配置；
- 一个插件 Secret；
- 一个 Settings Page；
- 一个 Widget 或 Chat Surface；
- 一个 namespaced Route；
- 一个后台任务或 Lifecycle Hook；
- 一个 Context Attachment；
- 一个 Custom Activity；
- 一个 dev scenario；
- 一个仅登记、不激活的 `skills/` 示例目录。

示例不得依赖外部付费服务，不承担 Browser、Office、Media 等业务实现。

## 十七、日志与可观测性接入契约

Phase 11 是插件系统唯一的日志、活动、审计和 Trace 底座。Phase 12 不建设 `plugin.log`、插件专属 SQLite、独立 Audit 文件或平行事件总线；插件、worker、Source Adapter 和 UI Surface 都不能直接写 Observability Store 或 spool。

### 17.1 平台自动记录原则

完整性不能依赖插件作者或各任务开发者“记得写日志”。以下平台边界必须由公共 wrapper 自动记录：

- Source 搜索、Artifact 获取、校验和兼容分析；
- 安装、更新、回滚、启用、禁用和卸载；
- 权限申请、授权、拒绝、撤销和 Agent 绑定；
- Runtime 启动、退出、崩溃、重启和健康变化；
- Tool、Command、Provider、Route、Hook、Background、Surface 的 started/terminal；
- Sandbox/PathGuard/Network/Process/Secret/Host capability 拒绝；
- dev install、reload、invoke、scenario 和 destructive approval；
- 补偿、恢复、quarantine、integrity failure 和 degraded 状态。

领域实现只补充平台无法推导的语义字段，不自行生成权威 Envelope。

### 17.2 事件目录

沿用 phase-11.md §7.2 规划的基础事件名。注意：Phase 11 目前实际只注册了 `plugin.permission.granted/denied/revoked`、`plugin.crashed` 及 3 个 audit 镜像（`event-catalog.ts`）；其余（installed/updated/enabled/disabled/uninstalled、process.*、execution.*、integrity.failed、sandbox.denied 等）由 **T1 统一登记进 Catalog**，并校验与既有事件命名不冲突：

```text
plugin.installed / plugin.updated / plugin.enabled / plugin.disabled / plugin.uninstalled
plugin.process.started / plugin.process.exited
plugin.execution.started / plugin.execution.completed
plugin.execution.failed / plugin.execution.cancelled
plugin.permission.requested / plugin.permission.granted
plugin.permission.denied / plugin.permission.revoked
plugin.integrity.failed
plugin.sandbox.denied
```

Phase 12 可以在统一 Catalog 中增加：

```text
plugin.discovered / plugin.staged / plugin.degraded
plugin.rollback.started / plugin.rollback.completed / plugin.rollback.failed
plugin.process.crashed / plugin.process.restarted
plugin.execution.timed_out / plugin.execution.interrupted
plugin.surface.opened / plugin.surface.failed / plugin.surface.capability_denied
plugin.source.fetch_failed / plugin.source.quarantined
plugin.dev.installed / plugin.dev.reloaded / plugin.dev.scenario_completed / plugin.dev.scenario_failed
```

`plugin.execution.*` 通过 payload 中的 `contributionKind` 区分 tool、command、provider、route、hook、background 和 surface，不为每类 contribution 建设互不兼容的平行生命周期。

插件自定义事件只能使用注册 namespace：

```text
plugin.<pluginId>.<domain>.<action>
```

Manifest 声明事件名、版本和 payload Schema；自定义事件默认只能是 `routine` Activity，不能自行生成 Audit、`notable` 或 `milestone`。

### 17.3 严格 Audit

以下行为必须使用 Phase 11 的 started → 领域修改 → completed/failed 生命周期，并满足 durable-or-reject 或可靠补偿：

```text
audit.plugin.install.*
audit.plugin.update.*
audit.plugin.rollback.*
audit.plugin.uninstall.*
audit.plugin.permission_change.*
audit.plugin.agent_binding_change.*
audit.plugin.config_change.*
audit.plugin.secret_change.*
audit.plugin.source_trust_change.*
```

要求：

- audit 事件命名与既有 Catalog 镜像风格统一（Phase 11 已注册镜像为下划线式，如 `audit.plugin.permission_granted`）；T1 冻结时确定点号式/下划线式最终约定并全部落地，不得新旧混用；
- 同库 Registry/Grant/Binding 修改与 Audit 放在同一 SQLite 事务；
- 文件、Artifact pointer、Secret 或外部进程操作使用审计先行、可验证补偿和终态；
- Audit 未配置、rejected、spool 达到上限或 completed 无法持久化时，高风险操作 fail-closed；
- 插件和 worker 无权调用 `appendStrict`，只能请求 Host 执行领域操作；
- failed Audit 必须带稳定 `reasonCode` 和补偿结果，不能记录虚假 allowed/completed。

### 17.4 Trace 与跨进程上下文

```text
Agent Turn span
└─ Platform Tool/Command span
   └─ Plugin execution span
      ├─ Runtime IPC span
      ├─ Provider/MCP/Route child span
      └─ Compensation/Retry span
```

- Web/API/Agent 入口继承现有 Agent、Session、Turn、trace 和 operation 上下文；
- AsyncLocalStorage 不跨进程，平台向 worker 发放只读、短期、一次性的 trace carrier；
- carrier 绑定 `pluginId + version + runtimeInstanceId + operationId`，校验后单次消费；
- 插件提交的 eventId、recordedAt、actor、executor、scope、trace、producer、ownerAgentId 和 sessionId 一律忽略，由平台重新盖章；
- 安装/更新/权限等非 Turn 操作建立独立 trace，并用 operationId/correlationId 关联 started 与 terminal；
- retry、restart、rollback 和 compensation 建立子 span，不覆盖原失败 span。

### 17.5 Payload、脱敏与输出限制

事件只保存诊断和追踪所需的安全摘要：

- 保存 pluginId、version、sourceType、runtimeKind、contributionKind/id、duration、attempt、status、errorCode、reasonCode 和资源引用；
- 不保存 Secret 原文、Authorization、Cookie、完整 Header、Provider Key、完整 Prompt、完整记忆、文件正文或任意插件输入输出；
- URL 默认移除 query/fragment 或按安全 allowlist 保留；
- 文件路径按 Phase 11 路径策略脱敏，外部响应不暴露平台绝对目录；
- 工具输入输出只记录 Schema 允许的安全摘要、大小和结果引用；
- stdout/stderr 只进入 Diagnostic，平台捕获、脱敏、限长、折叠和限速，不作为 IPC 或 Activity payload；
- 插件异常 stack、Python traceback 和 MCP error 必须经过统一 Error normalize；
- support bundle 对插件配置、诊断、Manifest 和来源信息执行第二遍整树脱敏。

### 17.6 失败、取消、超时和恢复

- 每个 `plugin.*.started` 必须有唯一 terminal：completed、failed、cancelled、timed_out、interrupted 或 exited；
- Runtime 崩溃时结束所有 in-flight execution span，并记录 process.crashed；
- restart 必须创建新 runtimeInstanceId，并以 trace link/related resource 关联旧实例；
- disable/update/uninstall 引起的取消使用稳定 reasonCode，不伪装成用户 Abort；
- Server 不可用时，worker 不能直接打开 Store/spool；由 Host/Server 记录，无法确认 Activity accepted 时返回明确 degraded/failed；
- Audit spool 满时拒绝高风险操作；Routine Activity 达到预算时暴露 critical health，不静默声称完整记录；
- 启动恢复扫描未终结 plugin operation 和孤儿 Runtime，补写 interrupted/failed 或执行补偿。

### 17.7 查询、UI 和派生指标

`/logs` 和 ObservabilityQuery 必须支持按以下字段筛选：

```text
pluginId / pluginVersion / sourceType
runtimeInstanceId / runtimeKind
contributionKind / contributionId
agentId / sessionId / operationId / traceId
status / errorCode / reasonCode / time range
```

插件详情和开发诊断页只展示 ObservabilityQuery 的受限投影，并提供跳转到预筛选 `/logs` 的入口，不直接读取原始日志文件。

至少可派生：

- 安装/更新/回滚成功率与耗时；
- execution 调用量、错误率、拒绝率、P50/P95 延迟；
- Runtime crash/restart 次数与 degraded 时长；
- 各 contribution 类型调用量；
- 权限 requested/granted/denied/revoked 数量；
- Source fetch/integrity/quarantine 失败；
- dev reload/scenario 成功率。

指标只从 Activity/Audit 派生，不由插件自报累计值。

### 17.8 可观测性测试要求

- Catalog 必须覆盖所有平台 wrapper 的 started/terminal 和 payload Schema；
- 同 operationId 生命周期唯一、幂等 terminal 和冲突 terminal fail-closed；
- 并发 Agent/Session/Runtime 不串 trace 或 owner scope；
- 伪造 carrier、重复 carrier、跨实例 carrier 被拒；
- stdout/stderr 洪泛、恶意 stack、嵌套对象和 Token 夹具完成脱敏；
- Runtime crash/restart、install compensation、rollback 和 startup recovery trace 完整；
- 插件自定义事件不能升级 significance 或产生 Audit；
- Observability 不可用、Audit rejected 和 spool 满的故障注入符合 fail-closed 契约；
- Web 插件详情、开发诊断和 `/logs` 过滤使用真实生产事件，不用前端 mock 伪造通过。
## 十八、API 与事件契约

至少提供：

```text
GET    /api/plugins
GET    /api/plugins/:id
POST   /api/plugins/inspect
POST   /api/plugins/install
POST   /api/plugins/:id/enable
POST   /api/plugins/:id/disable
POST   /api/plugins/:id/update
POST   /api/plugins/:id/rollback
DELETE /api/plugins/:id
GET    /api/plugins/:id/diagnostics
GET    /api/plugin-sources
POST   /api/plugin-sources/search
PUT    /api/agents/:agentId/plugins/:pluginId
DELETE /api/agents/:agentId/plugins/:pluginId
```

开发态 API 使用独立 `/api/plugins/dev/*` namespace。

跨 Web/Server/worker 的 Schema 先定义平台类型再实现。新增 SSE 事件必须进入 Replay Store，并同步 Web 端已知事件目录。

## 十九、文件变更清单（规划归属）

以下路径是实施期建议归属；开发 Agent 可在不改变契约边界的前提下调整文件名，但不得把插件代码散落回现有 Session/Route/UI 模块。

### 19.1 协议与 SDK

```text
packages/plugin-protocol/       Manifest、IPC、Contribution、Host API 类型
packages/plugin-runtime/        Node/Python worker Runtime SDK
packages/plugin-sdk/            插件 Server/Tool/Route 开发 API
packages/plugin-components/     iframe UI SDK、主题与 Host request
```

根 `package.json` 需要显式扩展 workspaces；四个 package 必须保持独立 import boundary，不得 import Server 内部实现。

### 19.2 Server 与持久化

```text
src/contracts/plugin-*.ts
src/config/paths.ts
src/storage/plugin-*.ts
src/runtime/plugins/
src/server/routes/plugins.ts
src/server/routes/plugin-dev.ts
src/platform/plugin-*.ts
src/observability/catalog/plugin-events.ts
```

`src/runtime/plugins/` 内再按 `registry/`、`installer/`、`grants/`、`sources/`、`runtimes/`、`contributions/`、`surfaces/` 分层，避免形成单一超大 `plugin-manager.ts`。

### 19.3 Web

```text
web/src/features/plugins/
web/src/lib/plugin-api.ts
web/src/lib/plugin-types.ts
web/src/app/routes/plugins.tsx
web/src/features/agents/              Agent 插件绑定入口
web/src/features/settings/            插件导航入口
```

插件 iframe 资源由 Server namespaced route 托管；Web 宿主不直接加载插件源码模块。

### 19.4 CLI、示例与文档

```text
src/cli/commands/plugins.ts
examples/plugins/sdk-showcase/
docs/plugin-development.md
scripts/verify-plugin-imports.mjs
scripts/verify-plugin-package.mjs
tests/fixtures/plugins/
```

### 19.5 测试归属

```text
tests/contracts/plugin-*.test.ts
tests/integration/plugin-*.test.ts
tests/security/plugin-*.test.ts
web/src/features/plugins/*.test.tsx
web/tests/e2e/plugin-*.spec.ts
```
## 二十、实施任务与依赖

### T1：协议、Manifest、路径与 migration（主 Agent 串行）

**前置依赖：** 无。其他任务不得在本任务冻结共享契约前实现生产逻辑。

- 冻结 Manifest v1、Normalized Manifest、Compatibility Report、Plugin Source Ref；
- 冻结 Contribution、Permission、Grant、Agent Binding、Runtime Snapshot 和 IPC Schema；
- 增加插件目录、staging、versions、data、dev source、dev runtime 路径；
- 增加 SQLite migration v10、旧版本归一化、损坏恢复和 API 版本协商；
- 建立 `packages/plugin-protocol` 和 import boundary；
- 冻结 Phase 11 基础插件事件和 Phase 12 扩展事件的 Catalog、payload Schema、lifecycle 与安全摘要。

**完成条件：** 契约正反例、Manifest fixture、全新/升级/中断 migration、路径 canonicalization 测试通过；Server/Web/worker 消费同一份协议类型。

### T2：Registry、Source Adapter 与事务安装器

**前置依赖：** T1。与 T3 可并行，但不得修改 T1 已冻结的 Schema。

- 实现 Plugin Registry、版本目录、active pointer 和 operation 状态；
- 实现 Local/ZIP/Git/npm-compatible Source Adapter；
- 实现 staged inspect、hash、provenance、兼容性报告和来源缓存；
- 实现事务安装、版本切换、更新、回滚、卸载和补偿验证；
- 实现 health、degraded、failed 和 diagnostics 状态机；
- 安装器/Source wrapper 自动记录 source、integrity、install/update/rollback/uninstall Activity 和严格 Audit 生命周期。

**完成条件：** 安装失败不留半状态；更新可原子切换并回滚；ZIP Slip、symlink/Junction、重复 id、hash 变化和版本不兼容夹具通过。

### T3：Permission、Grant 与 Sandbox Bridge

**前置依赖：** T1。与 T2 可并行，共享 migration/paths 由主 Agent 统一合并。

- 建立 capability catalog、平台级 grant、Agent 级 grant 和 revision；
- 实现 `PluginExecutionSnapshot` 与下一 turn 生效规则；
- 实现 full-access 审核、撤销和 fail-closed Audit；
- 接入 Phase 9 PathGuard、Process、Network 和 Secret 访问入口；
- 建立 Host capability broker，插件不能直接调用平台内部对象；
- Grant/Binding/Secret/Source trust wrapper 自动记录权限 Activity、严格 Audit 和补偿终态。

**完成条件：** 权限交集、跨 Agent 隔离、revision 竞态、Audit rejected、伪造 scope/trace 和未授权 Host capability 测试通过。

### T4：Runtime Host 与 IPC

**前置依赖：** T1、T3。MCP runtime 可先实现；Node/Python 代码 runtime 必须等待 full-access 语义冻结。

- 实现 bundle、MCP、Node process、Python process Runtime；
- 实现版本化 JSON-RPC/stdio、一次性 token、Trace carrier、超时、取消和大小限制；
- 实现 stdout/stderr 捕获、脱敏、折叠、限速和 Diagnostic；
- 实现 Runtime health、崩溃检测、restart budget、safe shutdown 和 update handoff；
- 增加 Plugin Runtime import boundary，禁止 worker import Server 内部模块；
- Runtime Host 自动记录 `plugin.process.*`、`plugin.execution.*`、崩溃、重启、取消和超时终态。

**完成条件：** 四类 Runtime 都有最小端到端夹具；重复/跨实例 token 被拒；崩溃、超时和洪泛不影响 Server 与其他插件。

### T5：Contribution Registry 与 Host API

**前置依赖：** T1、T3、T4。先实现 Tool/Config/Route，再扩展 UI/Hook/Background。

- 实现 Tool、Command、Provider 和 Route contribution；
- 实现 Page、Widget、Chat Surface 与受控 asset route；
- 实现 Background Service、Lifecycle Hook 和取消语义；
- 实现 Config/Secret、Context Attachment、Custom Activity；
- 实现 Skills inventory-only，不进入 Prompt 或技能发现；
- 为每类 contribution 接入权限、Trace、生命周期和禁用清理；
- 所有 contribution 统一经过 Instrument wrapper，自动生成 `plugin.execution.*`，payload 用 contributionKind/id 区分。

**完成条件：** 每类 contribution 至少有一个协议测试和一个 Runtime 集成测试；插件禁用/更新后旧 contribution 不再可调用；Core API 不可被覆盖。

### T6：OpenClaw 来源与兼容适配

**前置依赖：** T2、T4、T5。与 T7 可并行，Compatibility Report Schema 不得分叉。

- 解析 OpenClaw Manifest、Bundle、版本与来源元数据；
- 接入 ClawHub/npm/Git 来源的固定 fixture 和 provenance；
- 映射 Tools、MCP、config、commands 和 static skills；
- 为选定 Node Tool 实现 L5 worker 兼容层；
- 对 Gateway、Channel、ACP、专属 Hook/内部 API 生成精确诊断；
- Source/Compatibility/Runtime Adapter 只提交语义结果，由平台 wrapper 记录来源、兼容等级和执行事件。

**完成条件：** L1-L4 fixture 全部与报告一致；至少一个选定 Node Tool 完成 L5 调用；不支持 contribution 不安装、不启用、不静默丢弃。

### T7：Hermes 来源与 Python 兼容适配

**前置依赖：** T2、T4、T5。与 T6 可并行，Python 环境不得污染根依赖。

- 发现 Hermes 插件目录、`plugin.yaml`、Python 入口和版本元数据；
- 建立插件专属 Python 环境/解释器与 worker；
- 解释器发现：优先插件声明且校验过的解释器路径/venv，其次系统 python3，禁止安装器自动下载解释器；
- 映射 Tool Schema、调用结果、异常、超时和取消；
- 登记 static skills/资源，不激活技能；
- 诊断 Hermes Agent Loop、Gateway、全局单例和内部数据库依赖；
- Python Adapter 不直接写日志，异常、traceback、兼容结果和执行终态全部回到 Host Recorder。

**完成条件：** L1-L4 fixture 与报告一致；至少一个选定 Python Tool 完成 L5 调用；依赖冲突、worker 崩溃和 stderr 脱敏测试通过。

### T8：Web 插件中心、UI Surface 与 Agent 绑定

**前置依赖：** T2、T3、T5。可与 T6/T7 并行，API/Schema 由 T1/T5 冻结。

- 实现 Installed、Discover、Permissions、Development、Sources 五个视图；
- 实现插件详情、兼容报告、权限审查、配置、Secret、健康和诊断；
- 在 Agent 编辑页增加插件绑定、contribution 选择和下一 turn 生效提示；
- 实现 iframe Surface Host、Surface Session、asset route 和 UI SDK；
- 实现 CSP、Host capability、主题、Toast、resource picker 和错误隔离；
- 插件详情与开发诊断提供按 pluginId/runtimeInstanceId 预筛选跳转到 `/logs`，不读取原始日志文件。

**完成条件：** 桌面与移动 Web 无溢出；Surface 崩溃不影响主页面；跨插件 ticket、过期 session、CSP 逃逸和未授权 Host request 被拒。

### T9：开发者 SDK、Dev Loop 与 Showcase

**前置依赖：** T4、T5、T8。脚手架必须生成当前 Manifest/API 版本，不复制内部 Server 类型。

- 完成 plugin-sdk、plugin-runtime、plugin-components 和发布校验；
- 实现 dev install/reload/enable/disable/reset/uninstall；
- 实现 diagnostics、invoke-tool、list/describe surface 和 run-scenario；
- 实现 `devRunId`、开发槽权限、destructive scenario 审批；
- 完成 `sdk-showcase`、脚手架和 `docs/plugin-development.md`；
- Dev Host 自动记录 install/reload/invoke/scenario/destructive approval 的 Activity/Audit/Trace。

**完成条件：** 从空目录脚手架到 dev install → reload → invoke → scenario → uninstall 全链路通过；旧 devRunId 无法操作新实例；Showcase 不依赖付费外部服务。

### T10：Observability、恢复、质量门与真实验收（主 Agent 串行）

**前置依赖：** T1-T9 全部完成。不得与共享契约或 migration 修改并行。

- 审查 Activity/Audit/Trace/Diagnostic Catalog 完整性，并验证 T2-T9 公共 wrapper 已有生产调用方；
- 验证安装中断、Runtime 崩溃、更新失败、Audit 失败和补偿恢复；
- 接入 retention、support bundle、脱敏和插件健康；
- 独立复核所有 diff，运行全量质量门和真实 Web 验收；
- 回写提交、测试数量、已知偏差、评审问题和最终结论。

**完成条件：** 第二十二至二十四章全部通过并有证据；工作树只包含本阶段预期变化；计划状态和 checkbox 与真实实现一致。

## 二十一、并行规则与文件归属

### 21.1 依赖图

```text
T1
├─ T2
└─ T3
   └─ T4

T2 + T3 + T4 → T5
T2 + T4 + T5 → T6 || T7
T2 + T3 + T5 → T8
T4 + T5 + T8 → T9
T1-T9 → T10
```

实际执行约束：

- T1 必须由主 Agent 串行完成并冻结共享协议；
- T2 与 T3 可并行，但 migration、`paths.ts` 和组合根由主 Agent 持有；
- T6 与 T7 可并行，分别只修改自己的 Source/Runtime Adapter 与 fixture；
- T8 可在 T5 API 稳定后与 T6/T7 并行；
- T9 依赖 Runtime、Contribution 和 Web Surface，不得提前固化 SDK；
- T10 只在其他任务全部合并后执行。

### 21.2 共享文件归属

| 共享区域 | 唯一归属 | 规则 |
|---|---|---|
| `package.json` / lockfile / workspaces | 主 Agent | 子任务只报告依赖需求，不并行编辑 |
| Manifest/IPC/Contribution Schema | T1 / 主 Agent | 其他任务不得复制或分叉类型 |
| SQLite migration 与 schema version | T1 / 主 Agent | 单提交串行推进 |
| `src/config/paths.ts` | T1 / 主 Agent | 统一增加路径，不由 Adapter 拼接 |
| Server 组合根与 start wiring | T10 / 主 Agent | 各任务只提供 Service/Port |
| Agent tool catalog / turn snapshot | T5 + 主 Agent 合并 | 不能由 Adapter 直接注册全局工具 |
| Observability event catalog | T1 / 主 Agent | 先冻结 Phase 11 基础事件和 Phase 12 扩展事件；T10 只做完整性验收 |
| Web router / Settings nav | T8 | 其他任务不并行修改导航 |
| OpenClaw Adapter/fixtures | T6 | 不修改 Hermes 目录 |
| Hermes Adapter/fixtures | T7 | 不修改 OpenClaw 目录 |

### 21.3 子任务验收规则

- 子任务只在归属文件内实现并运行针对性测试；
- 子任务不得自行提交、修改 Plan 状态或勾选最终验收项；
- 主 Agent 必须独立审查 diff、重跑质量门并处理共享契约合并；
- 外部兼容 fixture 固定版本/hash，禁止测试时拉取 latest；
- 任何发现需要扩大权限、增加 Core bypass 或修改 Phase 13/14 契约的工作立即停下并回到本计划评审。
## 二十二、测试矩阵

### 22.1 协议和安装

- Manifest 合法/未知字段/版本不兼容/恶意路径；
- ZIP Slip、symlink/Junction、超大包、重复 id、版本降级；
- 安装中断、Audit rejected、health 失败、回滚恢复；
- 更新原子切换和旧版本保留；
- 卸载清理 Runtime/Surface/Grant，保留 Audit。

### 22.2 权限和隔离

- 未授权文件、网络、Process、Secret、Host capability 全部拒绝；
- Agent A 的插件授权不能被 Agent B 使用；
- 插件伪造 actor/scope/trace/producer 被覆盖；
- full-access 未确认不得启动；
- Plugin Runtime 不能直接访问 Store/spool/Audit；
- Surface Session 过期、跨插件复用和伪造全部拒绝。

### 22.3 Runtime

- Node/Python 启动、调用、取消、超时、崩溃和重启；
- IPC Schema 错误、重复 token、过期 token、跨实例 token；
- stdout/stderr 洪泛限速；
- disable/update 时 in-flight 调用按契约完成或取消；
- Runtime 崩溃不影响 Server、Session 和其他插件。

### 22.4 生态兼容

- OpenClaw 原生插件、bundle、MCP、Node tool 和不兼容 Hook；
- Hermes Python tool、依赖错误、超时和内部 Runtime 依赖；
- Claude/Codex/Cursor bundle 只导入支持部分；
- Compatibility Report 与实际安装/运行结果一致；
- 不支持能力不会被静默启用。

### 22.5 UI 和开发循环

- iframe CSP、asset route、host request、theme 和错误隔离；
- 安装详情、权限、配置、Secret、Agent 绑定；
- dev install → reload → invoke → diagnostics → scenario → uninstall；
- `devRunId` 防止旧上下文操作新实例；
- SDK Showcase 所有扩展点真实工作。

### 22.6 日志与可观测性

- Phase 11 基础插件事件名保持兼容，Phase 12 扩展事件全部登记 Catalog 和 payload Schema；
- Source/Installer/Grant/Runtime/Contribution/Surface/Dev Host 公共 wrapper 自动产生 started/terminal；
- 生命周期 operationId 唯一、幂等 terminal、冲突 terminal fail-closed；
- Audit 失败导致高风险操作 fail-closed 或可靠补偿，不产生虚假成功账本；
- Trace 覆盖 Agent → Tool/Command → Plugin Runtime → Provider/MCP/Route，并覆盖 retry/rollback/compensation；
- 并发 Agent/Session/Runtime 不串 trace、ownerAgentId 或 runtimeInstanceId；
- 伪造、重复、过期和跨实例 trace carrier 被拒；
- Runtime crash/restart、startup recovery 和孤儿 operation 都有完整终态；
- stdout/stderr 洪泛、Python traceback、MCP error 和嵌套 payload 经脱敏、限长、折叠和限速；
- Secret、Authorization、Cookie、完整 Header、Prompt、记忆、文件正文和完整插件输入输出不进入日志；
- 插件自定义事件不能升级为 Audit/notable/milestone，也不能直接写 Store/spool；
- `/logs` 能按 pluginId/version/runtime/contribution/status/operation/trace 查询真实事件；
- Observability 不可用、Audit rejected、spool 满和 recorder failure 故障注入符合 Phase 11 契约。

## 二十三、质量门

验收时以下命令必须逐条单独运行并读取退出码，不得用 PowerShell 分号或后续成功命令掩盖失败：

```powershell
node scripts/verify-pi-sdk-imports.mjs
```

```powershell
node scripts/verify-plugin-imports.mjs
```

```powershell
npx tsc --noEmit -p tsconfig.json
```

```powershell
npx vitest run
```

```powershell
npm run web:test
```

```powershell
npm run web:build
```

```powershell
npx tsc -p tsconfig.build.json
```

```powershell
Set-Location web
npx playwright test
Set-Location ..
```

```powershell
node scripts/verify-plugin-package.mjs examples/plugins/sdk-showcase
```

```powershell
git diff --check
```

Phase 12 专项门：

- Manifest/Schema 正反例与版本兼容；
- Plugin Protocol/Runtime/SDK import boundary；
- Bundle/MCP/Node/Python worker 集成；
- 恶意插件、越权、供应链和路径攻击夹具；
- OpenClaw/Hermes 固定版本兼容 fixture；
- Web 插件中心和 SDK Showcase Playwright E2E；
- 安装/更新/回滚/卸载 fail-closed 与补偿；
- Activity/Audit/Trace/Diagnostic 脱敏和生命周期完整性。

所有自动化测试默认离线，不访问真实市场、Git、npm、Provider 或外部服务。市场和生态测试使用固定 fixture/本地 registry；真实网络只做人工验收且不得成为 CI 必需条件。

真实 Web 交互验收可以使用仓库现有 browser-use 验收工具，但它只是开发验收手段，不是 Phase 12 产品插件或运行时依赖。验收至少覆盖：发现固定本地来源、查看兼容报告、安装 Showcase、权限确认、绑定 Agent、下一 turn 调用工具、打开 Surface、热重载、查看 Trace、禁用与卸载。

## 二十四、验收标准

### 24.1 协议、安装与运行时

- [ ] 原生 Manifest v1、Plugin Protocol、SDK 和 Runtime IPC 已冻结并版本化；
- [ ] Bundle、MCP、Node process、Python process 四类 Runtime 可用；
- [ ] 安装、启用、Agent 绑定和权限授予彼此独立；
- [ ] 安装/更新/回滚/卸载事务性、可补偿、可审计；
- [ ] active version 切换失败不会产生半新半旧 Runtime；
- [ ] full-access 代码插件风险被明确展示并要求用户授权。

### 24.2 扩展点与 Agent

- [ ] 插件可以贡献 Tool、Command、Provider、Route、UI Surface、Background、Hook、Config/Secret、Attachment 和 Activity；
- [ ] Skills 只登记，不被 Phase 12 注入、发现或执行；
- [ ] Agent 绑定变更从下一 turn 生效，in-flight turn 使用不可变 snapshot；
- [ ] 无 Agent Session 不会获得未配置的 Agent 专属插件；
- [ ] 插件禁用/更新后旧 contribution 和 Runtime 按契约终止。

### 24.3 生态兼容

- [ ] OpenClaw 静态/工具映射达到 L1-L4，并有选定 Node Tool 的 L5 受控 worker 验收；
- [ ] Hermes 静态/工具映射达到 L1-L4，并有选定 Python Tool 的 L5 受控 worker 验收；
- [ ] Claude/Codex/Cursor Bundle 与 MCP 只导入明确支持的部分；
- [ ] 不兼容 contribution 有精确诊断，不静默假装兼容；
- [ ] 来源、版本、hash、作者和安装 provenance 可查询。

### 24.4 Web、开发者体验与可观测性

- [ ] Web 插件中心支持发现、安装、权限、配置、诊断和开发循环；
- [ ] iframe Surface 不能访问未授权 Host API、平台 Cookie 或其他插件 Session；
- [ ] SDK Showcase 在无付费外部服务环境中完成端到端验收；
- [ ] dev install → reload → invoke → diagnostics → scenario → uninstall 全链路通过；
- [ ] 插件不能绕过 Phase 9 Sandbox、Phase 11 Audit/Trace 和 Agent/Session 隔离；
- [ ] Source、安装、权限、Runtime、Contribution、Surface 和 Dev Host 全部通过公共 wrapper 自动记录 started/terminal；
- [ ] `/logs` 可以按 pluginId、版本、Runtime、contribution、Agent/Session、operationId 和 traceId 查询真实事件；
- [ ] 插件和 worker 不能直接写 Observability Store/spool，不能伪造平台权威字段或提升自定义事件 significance；
- [ ] Secret、Authorization、Cookie、完整 Header、Prompt、记忆、文件正文和完整插件输入输出不进入日志或 support bundle；
- [ ] Server、Web、Playwright 和插件专项质量门全部通过。

### 24.5 范围

- [ ] Browser Use、远程浏览器和 Electron Core Browser 未进入本阶段实现；
- [ ] 技能系统和 Subagent 未被提前实现或固化；
- [ ] SDK Showcase 未演变为 Office、Media、Browser 或其他业务插件。

## 二十五、风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| Node/Python 任意代码无真实 OS 隔离 | 读取本机数据、启动进程或绕过 Host API | 无 OS 沙箱时强制 `full-access`；安装页明确风险；默认 Bundle/MCP 优先；禁止注入 Server 主进程 |
| 独立进程被误认为安全沙箱 | 产生虚假安全承诺 | 文档和 UI 明确“进程隔离主要解决故障隔离”；权限安全依赖真实 OS sandbox/受控 broker |
| OpenClaw/Hermes 格式漂移 | 兼容适配持续破坏 | Source Adapter 独立；记录 source format version；固定版本/hash fixture；不测试 latest |
| 市场供应链攻击 | 恶意包、同名接管、更新投毒 | provenance、hash、版本固定、来源信任策略、自动更新默认关闭、更新前重新审权限差异 |
| 安装/更新中断 | 半安装、active version 与 Runtime 不一致 | staging + immutable version + 原子 active pointer + operation journal + 补偿验证 |
| 插件伪造身份/Trace/Audit | 日志失真、越权归属 | 平台重新盖章；一次性 IPC token；忽略插件提交的权威字段；严格 Audit |
| Agent 间权限串线 | A 的插件读取 B 数据 | Agent grant + Session scope + Runtime snapshot 交集；跨 Agent 复现测试 |
| iframe 被当作 Runtime 安全边界 | UI 通过 Host/网络间接越权 | CSP、Surface Session、Host capability allowlist、namespaced route；Runtime 权限独立检查 |
| Secret 泄露到 UI/日志 | 凭据暴露 | Secret 分库存储；UI 不返回原文；平台脱敏；错误、stdout/stderr、support bundle 二次清洗 |
| Hook/后台服务拖垮主链路 | Turn 卡死、资源泄漏 | 超时、取消、并发/重试预算、禁用清理、健康状态和 circuit breaker |
| Phase 12 范围膨胀 | 插件底座迟迟不可验收 | SDK Showcase 只验证协议；浏览器、技能、Subagent、Office/Media 业务明确排除 |
| 插件绕过统一日志或日志洪泛 | 行为不可追踪、磁盘/Store 被耗尽 | 强制 Observability Port；平台 wrapper 自动埋点；插件不可写 Store/spool；stdout/stderr 与自定义事件限速限额 |
| Observability 故障时继续高风险操作 | Audit 缺口和账本谎言 | 沿用 Phase 11 durable-or-reject、Audit spool 上限和可验证补偿；故障注入锁定 |
| 市场暂时不可访问 | 安装页或 CI 不稳定 | 本地 fixture/registry 为自动化事实源；真实市场只人工验收；Source cache 可降级 |

---

## 实施记录

> T1 由主 Agent 串行冻结共享契约（plan §21.1）；T2/T3 并行子 Agent；T6/T7/T8 并行；子 Agent 报告不作为验收证据，主 Agent 独立复核。

### 提交记录

| Task | 提交 Hash | 说明 |
|---|---|---|
| T1 | `267c5d2` | 协议、Manifest、路径与 migration v10、插件事件目录 |
| T1 修复 | `74cc5d7` | TypeBox 1.3.6 Static map-union → never，改显式字面量 union |
| T2/T3 | `5d1894e` | Registry、Source Adapter、事务安装器、Permission/Grant/Sandbox Bridge |
| T4 | `750f42e` | Runtime Host 与 IPC（四类 Runtime） |
| T5 | `89c35ff` | Contribution Registry 与 Host API（11 类贡献） |
| T6/T7/T8 | `1966fa8` | OpenClaw/Hermes 适配、Web 插件中心与 Agent 绑定 |
| T9 | `e50eeb0` | Dev SDK 与 Showcase |
| T10 | `b5c5c1e` | 组合根接线（PluginFacade + /api/plugins 路由 + app/start） |
| T11 | `待定` | 评审修复轮：A1 激活接线/E1 Hermes 安装/C1 恢复扫描/C2 grant 原子性/C3 卸载清理/E3 dev 授权/B1-B3 Web 契约/F4 沙箱/E2 崩溃竞态（详见下”评审与修复记录”） |

### 质量门结果

- **T1-T10 全量质量门（逐条独立执行）**：verify-pi-sdk-imports ✓、verify-plugin-imports ✓、verify-plugin-package ✓、tsc ×2 ✓、vitest 109 files / 1225 tests ✓、build ✓、web tsc/vitest 361/build ✓、Playwright e2e 54/54 ✓、git diff --check ✓。
- **T11 修复轮质量门**：全量质量门在修复后统一复跑（tsc ×2 / vitest 全量 / build / web tsc+vitest / e2e），结果见”最终验收结论”。

### 真实 Web 验收

待实施（人工步骤，合并前由创建者执行）：隔离 `OPENCOLORFUL_HOME`、安装 sdk-showcase → 权限确认 → 绑定 Agent → 启用后经 dev invoke / HostBroker 调用工具 → 热重载 → 禁用卸载；记录关键截图和清理结果。

### 已知偏差

任何与本计划不一致但被接受的实现必须记录原因、影响、补偿和后续处理，不允许以”功能等价”一句带过安全或数据边界变化。

**T10 记录（6 条）**：
1. OpenClaw/Hermes 生态包安装走 compat 转换路径（installNormalized），installer.prepare 仍只处理原生 manifest.json——受控分叉，生态包 fixture 已锁定。
2. Custom Activity 经 ExtensionObservabilityPort 发出，插件自定义事件（plugin.&lt;pluginId&gt;.*）的动态登记由运行时 wrapper 处理（extension-allowed），T1 目录只含平台事件。
3. `plugin_runtime_instances` 表未写（RuntimeHost 实例状态在内存），持久化接线留待后续；plugin-secrets.json 用 InMemorySecretStore 占位。
4. openclaw-compat 保留 NormalizedPluginManifestMirror/CompatibilityReportMirror 显式镜像（facade 层收敛为协议类型）。
5. /logs 的 ?plugin= 预筛选参数为 best-effort（/logs 页未解析，入口已提供）。
6. MCP 来源 sourceType 标记 supported:false（MCP runtime 已实现，来源直装接线留待后续）。

**T11 修复轮新增/更新的偏差**：
7. **Agent turn 工具回路未接入**：插件工具已登记并经 `/api/plugins/dev/invoke-tool` 可调用，但 session-runtime 的工具列表（pi-sdk `tools/extraTools` 只是模型可见工具名，无自定义工具 handler 分发）尚未包含插件工具——“绑定 Agent 后下一 turn 直接调用插件工具”需 pi-sdk 自定义工具 handler 支持，留后续阶段（A1 已闭环服务端生命周期：启用即登记贡献+启动运行时）。
8. **auditMirror 镜像行 decision 硬编码 'allowed' 且 INSERT 不含 event_name**（`activity-recorder.ts:372`，Phase 11 既有，被 Phase 12 权限变更事件首次触发）：denied/revoked 会在账本留下 decision='allowed' 镜像行。修复涉及 Phase 11 事件管道，记为遗留偏差，后续阶段处理。
9. **HostBroker 白名单 API（config/secret/attachment/custom-activity）与插件 worker 的带 id 请求**：`registerHostBrokerApis` 与 `HostBroker.call` 尚无生产调用点（dev invoke 与工具经 ToolService 直连 runtimeHost 可用）；custom-activity 贡献与 broker 动态能力留待后续接线。
10. **network.connect 目标 allowlist**（`sandbox-bridge.ts`）：承诺留 T4/T5 但未落地且未进入 T10 偏差清单——授权后插件可连任意目标；作为安全边界记录，allowlist 留后续阶段。
11. **其余 50 分级评审项（不阻塞合并，随后续阶段处理）**：command/background/hook 空 requiredCapabilities 跳过授权层（D4）、HostBroker/SandboxBridge 能力校验省略 manifest 声明层（D5）、started 审计 decision 取值不统一（D3）、plugin_operations CHECK 枚举与 store 常量分叉（F3）、npm-source 注释与实现矛盾（F5）、plugin.crashed 僵尸事件（G2）、tool 输出脱敏死代码（G3）、timed_out 终态 errorCode/reasonCode 键名不统一（G4）、paths 死常量（G5）。

### 评审与修复记录

**T11 修复轮（2026-08-04，代码审查后主 Agent 规划 + 子 Agent 开发 + 主 Agent 集成复核）**——审查发现 4 条 ≥80 分 + 8 条 75 分高置信问题，本轮修复 12 项：

| 编号 | 问题 | 修复 |
|---|---|---|
| A1 | 生产路径插件运行时从未激活（activatePlugin 死代码） | start 启动激活 enabled 插件（`activateAllEnabled`）+ enable/disable/update/rollback/uninstall 生命周期钩子（activate/deactivate）+ dispose 停用全部运行时 |
| E1 | Hermes 带工具插件必然安装失败（_ocf/worker.py 缺失） | installer `prepareEntry` 钩子 + facade 注入 hermes materialize（安装/更新在 healthCheck 前具体化 L5 worker） |
| B1 | Web/Server 契约错配（TypeError/空列表） | server list/detail 富化（name/trust/runtimeKind/enabled/grants/bindings/secretStatus/surfaces/runtime）+ web 类型对齐与防御性解引用 |
| B2 | 来源搜索恒空 | facade.search 接线 adapter（单来源失败容错）+ 路由解析 sourceType/query |
| B3 | dev 两个路由 404 | 补 `GET /api/plugins/dev/surfaces` 与 `POST /api/plugins/dev/:pluginId/describe-surface` |
| C1 | 中断安装无启动恢复（插件永久锁死） | registry.recoverOpenOperations（audit failed + finishOperation + activity）+ start 启动恢复扫描 |
| C2 | grant 先于安装提交无补偿 | 改为先装后授：安装失败不留授权；授权失败回滚安装 |
| C3 | 卸载不清理 grants/bindings/config | registry.uninstall 同库事务清理（grantStore/configStore/bindingStore.removeByPlugin）+ 绑定清理验证 |
| E3 | dev full-access 授权永久残留 | dev uninstall 撤销授权（GrantService.removeAll 三阶段审计） |
| F4 | Phase 9 SandboxBridge 未接线 | EffectivePolicy.sandboxCheck 注入（base policy 防递归；pathGuard 未配置文件操作 fail-closed） |
| E2 | 启动崩溃竞态孤儿进程 | startInternal/restartInstance 的 map 删除加实例身份校验 |
| A2/G1 | shutdown 不 dispose / 文档状态陈旧 | start dispose 停用插件运行时；本文档状态/占位表/偏差更新 |

**验证**：T11 针对性测试（plugin-facade 10、plugin-registry 22、plugin-grant 15、plugin-binding 9、plugin-dev-host 14、plugin-runtime-host +3、observability-plugin-catalog 10 等）+ 全量质量门复跑，见”最终验收结论”。

### 最终验收结论

自动化质量门全部通过（T1-T10 与 T11 修复轮）；评审发现的阻断项已修复；`phase-12-plugin-system` 分支待用户（创建者）审查验证后决定是否合并到 main。真实验收（浏览器安装 Showcase → 权限确认 → 绑定 Agent → 调用工具 → 热重载 → 禁用卸载）与已知偏差 #7（Agent turn 工具回路）作为人工验收与后续阶段内容。
### T1 实施记录（2026-08-04，主 Agent 串行冻结）

**内容**：协议包、Manifest v1、路径、migration v10、插件事件目录、import boundary 全部冻结。

**关键冻结决策**：
- **协议包构建链**：`packages/plugin-protocol`（@opencolorful/plugin-protocol）独立 workspace 包，独立 tsc build（dist + .d.ts）；根 workspaces 扩为 `["web", "packages/*"]`；`build:protocol` 在 check 链最前；Server 通过 `src/contracts/plugin-protocol.ts` re-export 消费（只走包名，不 import dist 深路径）。typebox 1.3.6 的 `Value` 从 `typebox/value` 子模块导入。
- **事件命名约定**（T1 冻结，不得新旧混用）：activity 事件点号式（`plugin.execution.timed_out` 等复合词内允许下划线）；audit 事件下划线式（`audit.plugin.install_started/completed/failed`）。Phase 11 已注册的 4 个 plugin activity 事件 + 3 个 audit 镜像保持兼容，迁入 `catalog/plugin-events.ts` 统一维护。
- **Status 映射**：SQLite `activity_events.status` CHECK 枚举无 exited/crashed/timed_out → 插件进程/执行终态映射：exited→completed、crashed→failed、timed_out→failed（payload reasonCode 表达精确语义）、interrupted→interrupted、cancelled→cancelled。
- **Migration v10**：7 张插件状态表（installations/grants/configs/bindings/runtime_instances/source_cache/operations），`CURRENT_SCHEMA_VERSION = 10`；operations 表预留补偿状态（started/completed/failed/compensated）满足中断恢复与可验证补偿。
- **目录拆分**：`src/observability/catalog/shared.ts`（entry/routine/notable 辅助）+ `plugin-events.ts`（Phase 11 基础 + Phase 12 扩展 Activity/Audit 事件），event-catalog.ts spread 合并（保持单一权威注册表）。
- **verify-plugin-imports.mjs**：强制 packages/* 不得 import Server 内部（src/ 相对路径）与 @earendil-works/pi-*；Server src 不得 import 协议包 dist 深路径。已加入根 check 链。

**针对性测试**（不依赖全量）：tests/contracts/plugin-protocol.test.ts（Manifest v1 正反例/能力族枚举/扩展点种类/grant/binding/snapshot/source-ref/IPC/compatibility/normalized 20 例）、tests/integration/plugin-migration.test.ts（全新库/9→10 升级/中断恢复幂等/拒绝高版本 5 例）、tests/unit/observability-plugin-catalog.test.ts（命名约定/生命周期配对/audit 三阶段/auditMirror 存在性/Phase 11 不回归 10 例）、config-paths 插件路径断言。

**质量门**：tsc ×2 ✓、verify-plugin-imports ✓、vitest 81 files / 865 tests ✓（全量一次，契约冻结验证）。

### T2/T3 实施记录（2026-08-04，并行子 Agent + 主 Agent 独立复核）

**T2（Registry/Source/安装器）**：`src/storage/plugin-registry-store.ts`（installations+operations 表）、`src/runtime/plugins/paths.ts`（ZIP Slip 双防线：assertSafeRelativeEntry + canonical 包含判定，仿 Phase 9 path-guard resolveCanonical）、`sources/`（local/zip/git/npm 四 adapter + 统一 SourceAdapter 接口，Git 固定 commit 禁 latest，纯 Node ZIP 解包拒 symlink/zip bomb）、`installer/plugin-installer.ts`（staging→hash→Manifest v1 校验→normalize→兼容报告→health check）、`registry/plugin-registry.ts`（不可变版本目录 + DB active 原子切换 + per-plugin 串行化 + started→同库事务 completed/failed 严格审计 + 补偿删版本目录写 denied 终态）。不执行 postinstall。

**T3（权限/Grant/Sandbox Bridge）**：`grants/capability-catalog.ts`（16 能力族 + 高风险默认策略）、`grant-service.ts`（平台授权 revision 单调 + 三阶段 fail-closed 审计）、`binding-service.ts`（Agent 绑定只引用授权）、`effective-policy.ts`（manifest∩grant∩binding∩session∩sandbox 五层交集 + deniedBy/evidence）、`execution-snapshot.ts`（不可变快照）、`host-broker.ts`（白名单 Host API，伪造身份/权威字段拒绝）、`sandbox-bridge.ts`（复用 Phase 9 PathGuard，denied 记 plugin.sandbox.denied 脱敏）。

**主 Agent 独立复核发现并修复（T1 缺陷）**：TypeBox 1.3.6 的 `Static` 对 `Type.Union(arr.map(...))`（open array）解析为 `never`，导致 ManifestV1/PluginGrant 等类型不可用。两个并行子 Agent 独立报告同一问题。修复：全部 union 改为显式字面量 tuple + 新增 Static 类型级回归测试（提交 74cc5d7）。

**验证**：T2/T3 针对性测试 8 files / 95 tests ✓；全量阶段验证 89 files / 961 tests ✓；tsc ×2 ✓；verify-plugin-imports ✓。

**已知偏差**：卸载不停止 Runtime（T4 范围）；healthCheck 为 Artifact 完整性级（非运行时健康）；network.connect 目标 allowlist 留 T4/T5；config_change 审计三阶段由 T5 接线。

### T4-T10 实施记录（2026-08-04）

**T4（Runtime Host 与 IPC，提交 750f42e）**：bundle/mcp/node/python 四类 Runtime + JSON-RPC 行帧（1MB 上限）+ 一次性 carrier token（TTL 30s 单次消费）+ 崩溃重启预算（3 次/10min，超限 degraded）+ stdout/stderr 脱敏限长折叠限速→diagnostic + execution/process 生命周期自动埋点（contributionKind 区分）。68 测试。

**T5（Contribution Registry 与 Host API，提交 89c35ff）**：11 类贡献（tool/command/provider/route/surface/background/hook/config/secret/attachment/custom-activity/skill）+ tool namespace pluginId.toolId + route 固定 namespace 白名单 + config/secret 三阶段严格审计 + activate/deactivate 回滚 + HostBroker 白名单 API。92 测试。

**T6（OpenClaw，并入 1966fa8）**：openclaw.plugin.json 识别、L1-L4 映射（工具/MCP/config/commands/static skills 只登记）、专属能力（Gateway/Channel/ACP/Hook/内部 API）精确中文诊断 blocked/degraded、不把 allow/deny 当授权。32 测试 + 固定 fixture。

**T7（Hermes，并入 1966fa8）**：plugin.yaml 解析、静态 register_tool 扫描、宿主依赖诊断、stdlib-only Python worker L5 桥（解释器发现不下载）、异常/traceback/stderr 统一诊断。31 测试（python3 可用时 bridge 全跑）。

**T8（Web 插件中心，并入 1966fa8）**：五视图（installed/discover/permissions/dev/sources）+ 独立详情页（兼容三色/full-access 警示/按 pluginId 跳 /logs）+ Agent 绑定（下一 turn 生效提示）+ Settings 入口 + /plugins 路由 + 404 降级"插件服务未就绪"。12 web 单测 + 2 e2e 冒烟（含 390px 无溢出）。

**T9（Dev SDK 与 Showcase，提交 e50eeb0）**：plugin-sdk/plugin-runtime/plugin-components 三包独立构建（协议类型 re-export，零 Server import）+ dev install/reload/reset/uninstall/invoke-tool/list-surfaces/run-scenario + devRunId 隔离 + destructive 审批 + CLI plugins 命令组 + sdk-showcase 12 扩展点 + docs/plugin-development.md + verify-plugin-package.mjs。37 测试。

**T10（组合根接线与验收，提交 b5c5c1e）**：PluginFacade 装配全部插件服务（Registry/Installer/Sources/Grants/Bindings/Policy/Broker/RuntimeHost/HostApi/DevHost）+ /api/plugins 与 /api/plugins/dev/* 路由 + app/start 接线 + OpenClaw/Hermes 生态包经 compat 转换走 installNormalized。**类型统一**：删除 installer 本地镜像类型改用协议包单一权威类型（T1 Static never 修复后暴露的契约分叉收敛）。

**T10 全量质量门（逐条独立执行）**：verify-pi-sdk-imports ✓、verify-plugin-imports ✓、verify-plugin-package ✓、tsc ×2 ✓、vitest 109 files / 1225 tests ✓、build ✓、web tsc/vitest 361/build ✓、Playwright e2e 54/54 ✓、git diff --check ✓。

**已知偏差**：
1. OpenClaw/Hermes 生态包安装走 compat 转换路径（installNormalized），T2 installer.prepare 仍只处理原生 manifest.json——记录为受控分叉，生态包 fixture 已锁定。
2. Custom Activity 经 ExtensionObservabilityPort 发出，插件自定义事件（plugin.<pluginId>.*）的动态登记由运行时 wrapper 处理（extension-allowed），T1 目录只含平台事件。
3. `plugin_runtime_instances` 表未写（RuntimeHost 实例状态在内存），持久化接线留待后续；plugin-secrets.json 用 InMemorySecretStore 占位。
4. openclaw-compat 保留 NormalizedPluginManifestMirror/CompatibilityReportMirror 显式镜像（明确命名区分，facade 层收敛为协议类型）。
5. /logs 的 ?plugin= 预筛选参数为 best-effort（/logs 页未解析，入口已提供）。
6. MCP 来源 sourceType 标记 supported:false（MCP runtime 已实现，来源直装接线留待后续）。

### 最终验收结论

待用户（创建者）审查 `phase-12-plugin-system` 分支后决定是否合并到 main。自动化质量门全部通过；真实验收（浏览器安装 Showcase → 权限确认 → 绑定 Agent → 调用工具 → 热重载 → 禁用卸载）可作为人工验收步骤执行。
