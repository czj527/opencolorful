# P1 Flaky Fetch Chain Fix（对话链路韧性修复）

状态：in-review
 owner：主 Agent（k3）
 日期：2026-09-10
 前置：p1-chat-experience（PR #87）

## 根因（调查结论，证据链完整）

Electron 主进程 fetch 存在瞬时网络失败窗口（Chromium 网络服务抖动，`Network service crashed, restarting service` 实锤），被两处既有前端缺陷放大为「消息发出后回复永不出现」的永久失败：

1. `api-proxy.cjs`：fetch 抛异常即返回 `status:0 NETWORK`，无重试——ChatPage 挂载突发的 4 个并发 GET 落入失败窗口即全灭；
2. `ipc-source.ts ensureChatStream`：`historyLoaded` 在 GET 前置位（失败永不重试），且 catch 走 `pushChannelError = markPromptFailed`——历史装载失败被误报为「发送失败」并清掉 streaming/pendingPrompt（E2E 的 expectIdle 因此假通过，掩盖问题）；
3. SSE 首连/重连成功后前端不追平：断线窗口内的 message.delta / tool.* / turn.completed 永久丢失。

lane-b45/lane-b3 真链测试间歇性失败（7 个用例）即此回归链；b042738 时期全绿为概率幸运。git stash 对照实验证明与 p1-chat-experience 的改动无关。

## 改动

- `desktop/electron/api-proxy.cjs`：幂等 GET 的 fetch 失败（含超时）等待 200ms 后以同一 base 重试一次（仅此一次）；重试成功走正常路径，仍失败才返回 NETWORK。
- `desktop/src/data/ipc-source.ts`：历史装载独立错误处理——`historyLoaded` 移到装载成功后置位 + `historyLoading` 幂等守卫；失败按 300/900/2000ms 退避重试 3 次；耗尽后只推独立状态行「历史加载失败，请刷新重试」（不触碰 streaming/pendingPrompt）；删除 `pushChannelError`（不再误报发送失败）。
- `desktop/src/data/projector.ts`：新增导出 `pushChannelStatus`（独立状态行，不动发送/流式状态）。
- SSE 重连追平链：`sse-proxy.cjs`（reconnectPending 标记 + onReconnect 回调，退避策略不变）→ `preload.cjs`（`desktop:sse-reconnect` 通道）→ `desktop/src/env.d.ts`（可选桥）→ `ipc-source.ts`（重连成功 → `reloadBranchEntries` 幂等追平；streaming 中挂起 pendingBranchReload 由终态 flush）。

## 验证证据

- desktop vitest：27 文件 128 测试全绿（新增 api-proxy-retry ×3、history-load-retry ×2 单测）；
- 真链回归（lane-b45 6 tests + lane-b3 3 tests）两轮：第 1 轮 9/9 通过；第 2 轮 lane-b45 B-5 的 page.screenshot 30s 超时（视觉证据采集环节，UI 断言已过，补跑单独通过）——无旧失败签名（`→ 0` + 消息缺失）；
- 主 Agent 独立复核全部 diff + 重跑单测 128/128。

## 已知限制

- SSE 重连追平暂无真实断线注入的自动化覆盖（lane fixture 无断连注入能力）；链路靠单测 + reloadBranchEntries 既有代次语义间接保证。
- 若重连间隙 turn 终态事件也丢失，pendingBranchReload 可能永不消费（下一次用户操作触发重载时自愈）。
- Electron 主进程 fetch 的瞬时失败窗口本身（Chromium 网络服务）未根治——本修复在应用层吸收其影响。
