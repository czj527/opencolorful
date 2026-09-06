# OpenColorful 波次 A/B 独立交付质量评估

**评估日期：2026-09-06**
**评估基线：** `main` / `origin/main`，commit `15036b7`
**评估范围：** 波次 A（A0-A9）与波次 B（B0-B5b，含 B6/B7 收尾记录）
**评估方式：** 只读复核、独立命令执行、隔离服务探针、Electron 真链复跑
**代码变更：** 本评估没有修改生产代码、测试代码或架构图工作

## 1. 执行摘要

波次 A/B 的主要工程代码已经合并，项目已经具备较完整的 Server、PI Runtime、SQLite、JSONL、Electron、Desktop Mock、Electron 真链和 Web 运维测试基础。

但独立复核不能将当前状态判定为产品完成或发布候选：

1. 本机 HTTP/WS 接口缺少统一的 Origin、Host 和请求认证边界。已通过隔离真实服务复现跨站简单请求创建 Session，恶意 Origin 的 WebSocket 也可以握手成功。
2. SQLite v13/v14 表重建迁移在中断后不可恢复。已通过故障注入复现，重试会因临时表残留而失败。
3. B3 分支真链存在间歇性发送按钮长期 disabled。单跑可通过，重复运行 3 次得到 1 次通过、2 次失败。
4. B4 压缩摘要和 B5 Todo 尚无 Electron 真链闭环证据。
5. G2 仍未完成正式安装、更新、恢复验证；GitHub 上仍存在重复的 Draft Release。

当前结论：

```text
Wave A：工程实现已合并；AUTO_PASS 未达成；HUMAN_PENDING；RELEASE_PENDING
Wave B：工程实现基本完成；AUTO_PASS 未达成；HUMAN_PENDING；RELEASE_PENDING
正式 3-5 天真实使用：暂缓作为验收
发布候选版本：不建议
```

## 2. 当前代码和交付状态

### 2.1 Git 与 CI

- `main` 与 `origin/main` 一致，当前 HEAD 为 `15036b7`。
- 波次 A PR #40-#54 已合并。
- 波次 B PR #55-#62 已合并。
- 当前只有一个 Git worktree。
- 工作区未提交文件属于架构图 Agent，本评估未修改。
- HEAD 对应的 GitHub Quality、Governance、Browser 工作流通过。
- Desktop true-chain smoke 虽在 CI 执行，但不是 required status check。

### 2.2 独立自动化验证

以下结果来自当前 HEAD 的重新执行：

| 验证项 | 结果 | 说明 |
|---|---|---|
| `node scripts/verify-pi-sdk-imports.mjs` | PASS | exit 0 |
| `node scripts/verify-plugin-imports.mjs` | INVALID PASS | exit 0，但脚本实际未执行检查 |
| `npx tsc --noEmit -p tsconfig.json` | PASS | exit 0 |
| `npx tsc -p tsconfig.build.json` | PASS | exit 0 |
| `npx vitest run` | PASS | 193 files，2275/2275 |
| `npm run test --workspace=web` | PASS | 34 files，428/428 |
| `npm run web:build` | PASS WITH WARNING | 有 500KB chunk warning |
| `npm run desktop:test` | PASS | 20 files，102/102 |
| `npm run desktop:build` | PASS | exit 0 |
| `cd web; npx playwright test` | PASS | 60/60 |
| B 相关聚焦集成测试 | PASS | 9 files，52/52 |
| Desktop 全量 Electron 真链 | FAIL | 26/27 |
| B3 `BRANCH-03/04` 单独运行 | PASS | 1 次通过 |
| B3 `BRANCH-03/04 --repeat-each=3` | FAIL | 1/3 通过，2/3 失败 |
| v13/v14 中断迁移恢复 | FAIL | 临时表残留导致重试失败 |
| HTTP/WS Origin 探针 | FAIL | 跨站写请求和恶意 Origin WS 均可达 |
| 安装/更新/恢复 | PENDING | 尚无正式安装链路证据 |

自动化测试通过只证明对应测试断言通过，不能替代人工产品验收和发布验证。

## 3. 波次 A 结论

### 3.1 已交付

- A0-A9 代码和测试已合并。
- Desktop Mock 测试体系已建立。
- Electron true-chain 基础设施和 CI smoke 已建立。
- Primary/secondary 模型策略已统一。
- Main、Subagent、Utility 用量已进入统一查询模型。
- Desktop 全局用量入口已实现。
- Electron 错误诊断关联链路已实现。

### 3.2 当前状态

| 状态 | 结论 |
|---|---|
| `AUTO_PASS` | 未达成。常规测试通过，但 Plugin import 检查是假通过，v13/v14 迁移恢复失败 |
| `HUMAN_PENDING` | 是 |
| `HUMAN_PASS` | 否 |
| `RELEASE_PENDING` | 是 |
| `RELEASE_PASS` | 否 |

波次 A 应描述为：

> 工程实现完成，独立质量复核发现安全边界和迁移恢复阻断项，产品体验与发布验收待完成。

不能继续使用“所有 A0-A9 已验收完成”作为当前产品状态。

## 4. 波次 B 结论

### 4.1 已交付

- Regenerate/retry 统一原语。
- Branch head 持久化。
- Branch switcher 与当前分支线性时间线。
- Fork 独立会话和溯源元数据。
- Desktop 压缩摘要卡。
- Durable session Todo 后端、Replay 事件和 Desktop 只读卡。

### 4.2 当前状态

| 状态 | 结论 |
|---|---|
| `AUTO_PASS` | 未达成。Desktop 全量真链 26/27，B3 重复运行 1/3 通过 |
| `HUMAN_PENDING` | 是 |
| `HUMAN_PASS` | 否 |
| `RELEASE_PENDING` | 是 |
| `RELEASE_PASS` | 否 |

波次 B 应描述为：

> 工程实现基本完成，但 B3 稳定性、B4/B5 Electron 真链和人工验收尚未闭环。

### 4.3 B3 间歇性失败

失败位置：

```text
desktop/tests/e2e/lane-b3-branches.truechain.spec.ts
第二条基线消息发送
ChatPO.send()
```

失败表现：

```html
<button disabled aria-label="发送">
```

当前分类为：

> 已复现的间歇性 UI/测试时序缺陷，根因尚未确定。不能当作稳定必现产品 Bug，也不能当作无关测试噪声。

## 5. 已复现问题

### P0-1 本机 HTTP/WS 信任边界不足

隔离服务探针结果：

```text
POST /api/sessions
Origin: https://evil.example
Content-Type: text/plain
结果：201，成功创建 Session
```

伪造 Host：

```text
Host: evil.example
Origin: https://evil.example
结果：201
```

WebSocket：

```text
Origin: https://evil.example
结果：握手成功
```

相关代码入口：

- `src/server/app.ts`
- `src/server/routes/observability.ts`
- `src/server/observability/client-events.ts`

当前 Origin/Content-Type 校验主要存在于 observability client-events 单一路由，未形成全局本机服务边界。

建议立即修复：

- 服务启动时生成本机访问令牌。
- Electron IPC 和受信客户端统一携带令牌。
- HTTP 写接口统一校验 Host、Origin、令牌和 JSON Content-Type。
- WebSocket 握手执行同样的来源和令牌校验。
- 增加跨站 simple request、伪造 Host、恶意 Origin WS 的负例测试。

### P0-2 v13/v14 迁移中断后不可恢复

故障注入结果：

```json
{
  "scenario": "v13",
  "version": 12,
  "leftovers": ["memory_journal_v13", "usage_records"],
  "retry": "table memory_journal_v13 already exists"
}
```

```json
{
  "scenario": "v14",
  "version": 13,
  "leftovers": ["memory_journal", "usage_records_v14"],
  "retry": "table usage_records_v14 already exists"
}
```

相关代码：

- `src/storage/migrations.ts:887`
- `src/storage/migrations.ts:925`

原因：

- 表重建没有包在事务内。
- 版本号最后才推进。
- 中断后的临时表没有清理。
- 重试没有判重和恢复逻辑。

影响：

- 用户升级过程中如果进程中断，下一次启动可能无法打开数据库。
- 该问题直接阻断发布候选。

### P1-1 B3 分支流程间歇性发送禁用

详见第 4.3 节。建议先用 trace 区分：

- Composer 受控 draft 被 React 重置；
- 分支切换后的 channel 重建清空 draft；
- 测试在 UI 状态稳定前继续操作；
- 旧事件覆盖了当前输入状态。

## 6. 源码级风险

以下项目本轮未作为稳定用户 Bug 复现，但源码证据足以进入后续修复计划：

| 优先级 | 风险 | 证据 |
|---|---|---|
| P1 | `ensureRuntime()` 没有 per-session single-flight，两个并发请求可能重复创建或覆盖 Runtime | `src/server/routes/runtime-bootstrap.ts:310` |
| P1 | Agent 设置读取失败后继续创建 Runtime，并可能不启用沙箱，存在 fail-open 风险 | `src/server/routes/runtime-bootstrap.ts:351` |
| P1 | Usage 写入失败可能只吞错或告警，没有 durable spool/reconciliation | `src/runtime/usage-recorder.ts:145`、`src/runtime/subagents/runtime/usage-ingestion.ts:99` |
| P1 | Fork 先写 JSONL、后写 SQLite，索引失败可能留下孤儿 JSONL | `src/runtime/session-service.ts:434` |
| P1 | Desktop 设置先乐观更新，失败后不回滚 | `desktop/src/App.tsx:510` |
| P1 | 分支切换多次 GET 没有 generation/token，旧响应可能覆盖新分支 | `desktop/src/data/ipc-source.ts:635` |
| P2 | SSE 合批中可能产生 N+1 次通知 | `desktop/src/data/ipc-source.ts:1182` |
| P1 | Server dispose 未等待 `pluginFacade.dispose()` 完成就关闭数据库 | `src/server/start.ts:596` |

这些风险不能直接写成“已发生事故”，但应有对应的负例、并发和恢复测试。

## 7. 协议、产品闭环与测试缺口

### 7.1 Plugin import 检查是假通过

`node scripts/verify-plugin-imports.mjs` 返回 exit 0，但入口判断比较文件路径和 `file://` URL，实际没有执行扫描。

这是治理门禁缺陷，必须修复并加入“脚本确实执行”的回归测试。

### 7.2 Web 事件协议未完整收口

`web/src/lib/sse-client.ts` 的 `KNOWN_EVENT_TYPES` 没有 `todo.updated`，也没有波次 B 的 branch events。

Desktop 已消费部分事件，Web 作为协议验收客户端却未同步，属于跨客户端契约缺口。

### 7.3 B4/B5 缺少 Electron 真链

当前已有：

- B4 Desktop Mock 和投影测试。
- B5 后端、Store、Replay、恢复和 Desktop Mock 测试。

尚缺：

- 真实 Electron 中触发压缩并看到 live card。
- 重启后看到历史 summary card。
- 真实 `todo_write` tool call 驱动 Desktop Todo card。
- Todo 重启恢复和断线 Replay。

### 7.4 Secondary 模型 Desktop 入口不完整

Web 设置存在 `subagents.defaultModel` 入口，但 Desktop 设置只暴露主模型和 Provider。

用户无法在主要产品前端中完整配置 Subagent、Memory utility 和后台任务使用的 secondary 模型。

### 7.5 Diff、Terminal、Approval 仍有 Mock 入口

Desktop 的 Diff 读取固定 `dockFiles`，Terminal 显示固定文本并标记 `mock`，聊天 Approval 只改变组件本地 state。

如果这些入口在真实 IPC 模式出现，用户可能误以为已经查看了真实 Diff、运行了真实 Terminal 或完成了真实 Approval。

建议未接真实数据时隐藏入口，或在真实产品界面明确标记演示态。

### 7.6 Subagent 终态仍依赖手动刷新

Subagent 真链在 Run 已进入终态后，需要用户点击“刷新”才能看到 succeeded/result。

当前证据支持“可查询详情”，尚不足以支持“终态自动实时更新”的产品承诺。

## 8. 人工验收清单

以下是每个波次最重要的用户目标场景，不是逐个测试矩阵。

### 8.1 波次 A

| 场景 | 用户目标 | 准备状态 | 用户操作 | 预期可见结果 | 失败恢复 | 观察点 | 必须亲测 |
|---|---|---|---|---|---|---|---|
| A-1 首次使用 | 从零开始使用助理 | 干净 Home | 完成引导并发送首条消息 | 不读源码即可收到回复，会话真实出现 | 能进入 Provider 配置并重试 | 是否误进 Mock，首条消息是否落盘 | 是 |
| A-2 Provider 失败 | 配置错误时知道如何修复 | 错误 URL/Key | 保存配置并发送消息 | 错误可理解，不泄露秘密，不无限 loading | 修改 Provider 后可重新发送 | Composer、错误卡、重试入口是否可继续 | 是 |
| A-3 错误后继续 | 一次失败不破坏会话 | stub 返回 401/429/timeout | 发送失败，再发送正常消息 | 错误保留，后续消息成功 | 停止、重试、重新发送均可用 | 是否出现重复错误或按钮卡死 | 是 |
| A-4 重启恢复 | 关闭后继续工作 | 已有消息，尝试中止或重启 | 关闭并重新打开应用 | 历史、模型、工作目录可信恢复 | 可以继续输入 | 是否出现幽灵运行态或丢消息 | 是 |
| A-5 用量帮助决策 | 知道后台消耗来自哪里 | 配置 primary/secondary | 触发 Subagent、摘要、后台任务并查看 Usage | 能区分来源、角色、模型和 Token | secondary 不可用时有明确提示 | 数字是否帮助决策，是否出现漏账 | 是 |
| A-6 记忆长期使用 | 助理记得有用的信息 | 连续使用若干天 | 观察召回、复盘、记忆设置 | 记忆有帮助且不制造噪音 | 可关闭、修正、忽略记忆 | 是否误记、重复提醒、无法解释 | 是 |

### 8.2 波次 B

| 场景 | 用户目标 | 准备状态 | 用户操作 | 预期可见结果 | 失败恢复 | 观察点 | 必须亲测 |
|---|---|---|---|---|---|---|---|
| B-1 编辑并重生成 | 修改错误问题而不丢历史 | 至少一轮完整对话 | 编辑用户消息并重生成 | 新分支成为当前，旧分支可找回 | 失败后原分支仍可用 | 是否理解新分支而非覆盖历史 | 是 |
| B-2 重试 | 对同一问题重新请求 | 有助手结果 | 点击重试 | 创建兄弟分支，原文和旧结果保留 | 可切回原分支 | 时间线、标题和分支数量是否清楚 | 是 |
| B-3 切换分支 | 在不同思路之间继续工作 | 至少两个分支 | 来回切换并继续发送 | 当前分支、时间线、后续消息一致 | 运行中提示停止，停止后恢复 | 是否有旧响应覆盖新分支 | 是 |
| B-4 Fork | 从当前结果开始独立探索 | 有可 Fork 消息 | Fork 新会话并分别继续 | 新会话独立，源会话不改变 | 失败不留下孤儿文件/索引 | 是否理解 Fork 与分支区别 | 是 |
| B-5 压缩摘要 | 在长会话后找回上下文 | 足够长的会话 | 执行 `/compact`，阅读并重启 | 摘要可理解，之后可继续对话 | no-op/busy/failed 有清晰恢复 | 摘要是否真的减少困惑 | 是 |
| B-6 Todo | 知道当前和下一步要做什么 | Agent 产生 Todo | 观察 Todo 更新、完成、清空并重启 | Todo 与实际进展一致 | 断线、失败、空列表后状态可信 | 是否只是装饰性清单 | 是 |
| B-7 长时间混用 | 连续使用仍保持可理解 | 多轮分支、压缩、Todo | 使用数小时或数天 | 状态不嘈杂、不重复、不出现幽灵状态 | 任一步失败仍能继续 | 复杂度是否反过来伤害用户 | 是 |

## 9. 发布与安装状态

当前 GitHub Release 状态：

- 两个同名 `v0.1.1` Draft Release。
- 一个包含 exe、blockmap、`latest.yml`。
- 一个只有 blockmap。
- `v0.1.0` 仍为 Draft，且已记录为不可用版本。
- `v0.1.1` 尚未完成正式发布。

因此：

```text
G2：RELEASE_PENDING
安装启动：未通过独立验证
更新链路：未通过独立验证
恢复链路：未通过独立验证
正式发布：不建议
```

## 10. 修复顺序

### 立即修复

1. 本机 HTTP/WS Origin、Host、令牌和 Content-Type 信任边界。
2. v13/v14 迁移事务化和中断恢复。
3. B3 Composer/分支切换间歇性发送禁用。
4. Agent 设置读取失败改为 fail-closed。
5. 修复 Plugin import 检查脚本并增加执行性回归测试。

### 后续修复

1. Runtime single-flight。
2. Usage durable spool/reconciliation。
3. Fork JSONL/SQLite 对账和孤儿清理。
4. Desktop 设置失败回滚。
5. 分支请求 generation/token。
6. SSE 合批通知去重。
7. B4/B5 Electron 真链。
8. Web `todo.updated` 和 branch event 协议收口。
9. Desktop secondary 模型入口。
10. Diff/Terminal/Approval 接入真实数据或隐藏 Mock 入口。
11. 安全、迁移、B3 和真实交互闭环后，再开始 3-5 天日用。

## 11. 后续 Skill 设计输入

本次评估支持后续设计轻量 `opencolorful-development` Skill，但暂不创建。

Skill 只提醒 Agent 检查：

- 风险类别：UI、普通功能、持久化、并发/恢复、安全、发布。
- 是否需要开发者做产品决策。
- 是否需要 UI 状态预览。
- 自动化测试、人工 Journey、发布验证的分流。
- `AUTO_PASS`、`HUMAN_PENDING`、`HUMAN_PASS`、`RELEASE_PENDING`、`RELEASE_PASS` 的独立状态。
- 收尾报告必须区分：已复现问题、源码风险、测试缺口、人工未知和发布未知。

Skill 不能替代 `AGENTS.md`、项目文档、测试脚本、CI 和分支保护，也不能通过填模板自动宣称产品完成。
