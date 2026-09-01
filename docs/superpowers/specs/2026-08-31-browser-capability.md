# 浏览器能力专项：安全边界、只读 Inspect 与受控交互

**日期：2026-08-31**  
**状态：规划中**  
**实施计划：** [`plans/browser-capability.en.md`](../../../plans/browser-capability.en.md)  
**上游路线：** [`docs/positioning-and-roadmap.md`](../../positioning-and-roadmap.md) §二、§五 P1/P2/P3  
**当前状态：** [`docs/project-status.md`](../../project-status.md)

## 一、背景

OpenColorful 当前没有产品级 BrowserManager、browser tool、浏览器路由、BrowserDataSource、浏览器会话隔离、BrowserCard 或 Browser Panel。Electron 的 BrowserWindow 只是应用窗口，不等于 Agent 可控制的网页浏览器。Browser Use 和 Playwright 目前只能作为测试/验收工具，不能直接当作运行时能力。

用户明确要求的目标是：右侧栏可以嵌入浏览器；Agent 操作时用户展开右侧栏即可实时查看；用户能够人为选择网页元素并添加到对话框。这个功能同时涉及 SSRF、私网与 metadata 地址、Cookie/凭据、页面 prompt injection、下载上传、任意脚本执行、动作审批、取消、超时和跨 Session 串台，因此必须独立于波次 B，先做安全契约，再做只读 Inspect，再做受控动作，最后才考虑 Agent/Plan/Cron 接线。

## 二、目标

1. 建立 Browser Session 与 Agent/Session 的清晰归属和隔离。
2. 在不放开高风险动作的前提下提供可 mock、可恢复的只读浏览器 Inspect。
3. 在 Desktop 右侧栏实时展示页面状态和 Agent 操作过程。
4. 允许用户选择网页元素，并以带来源和时间信息的结构化引用加入对话。
5. 让每一项受控动作都有权限、审批、审计、取消、超时和错误语义。

## 三、分阶段范围

### C0：安全契约与威胁模型

冻结 Browser Session identity、Agent/Session 归属、URL 规范化、DNS/IP 解析、loopback/private/metadata/SSRF 策略、Cookie/credential 隔离、下载/上传/evaluate 范围、动作审计、页面 prompt injection 处理、用户确认和无人值守边界。

### C1：Foundation/Inspect

提供可 mock 的 BrowserManager/transport：start、stop、navigate、wait、title、url、tabs、snapshot、screenshot。页面变化后 ref 失效；Browser Session 之间不可串台；支持 host unavailable、fatal error、超时、取消、冷启动和恢复。

### C2：Desktop Browser Panel

右侧栏作为一等面板展示当前 Browser Session 的 URL、标题、tab、加载、页面快照/画面、运行状态、错误和停止入口。Agent 操作期间用户展开即可观察；面板不能绕过 BrowserManager 直接操纵任意 WebContents。

### C3：受控动作与人工选取

在 C0-C2 的安全和状态契约稳定后，增加显式 tab/ref 的 click、type、select、key、scroll。页面变化后旧 ref 必须拒绝；敏感字段、动作审批、取消和超时可见。用户选取网页元素时，加入对话框的是带 URL、title、selector、snapshot 时间和有限文本的结构化引用，不把不可信网页内容当作系统指令。

### C4：Agent/Plan/Cron 接线

最后才考虑 browser tool、todo/plan、cron/heartbeat、下载上传或其他无人值守能力。每项接线单独定义权限、审批、超时、重试、结果回显和 prompt injection 负例。

## 四、首期明确不支持

- 任意网站、任意 JavaScript/evaluate。
- 任意 Cookie、Authorization、账号态或跨 Session 共享。
- 无审批的副作用动作和无人值守浏览器自动化。
- 任意下载、上传、文件系统桥接。
- 云浏览器 fallback 或通过测试工具绕过产品安全策略。
- 页面文本自动升级为系统/开发者指令。

## 五、验收标准

1. 私网、loopback、metadata、DNS 重绑定和不安全 URL 的负例按策略拒绝并有可解释错误。
2. Browser Session 与 Agent/Session 绑定可审计；不同 Session 不能看到彼此 tab、Cookie、快照或动作。
3. 只读 Inspect 的生命周期、加载、host error、timeout、cancel、ref 失效、冷启动和恢复有 Mock/API/Electron 证据。
4. Desktop 右侧 Browser Panel 能显示 Agent 操作状态，用户可停止并看到失败/断线/恢复。
5. 受控动作有审批、审计、显式引用和页面变化后的失效处理。
6. 人工选择元素加入对话时保留来源与 snapshot 时间，页面注入内容不改变系统指令边界。
7. 未实现的 evaluate、Cookie 共享、下载上传和无人值守自动化保持明确禁用，而不是依赖隐藏约定。

## 六、参考项目与取舍

- OpenHanako：BrowserManager、Browser Card、AX Snapshot 和右侧 Browser Viewer 的产品形态参考。
- OpenClaw：Browser/Screen/Canvas、工具策略、审批、设备和审计边界参考。
- Hermes Agent：Browser/Web 工具组合、后台任务可见性和失败语义参考。
- CowAgent：Browser、Web Search/Web Fetch 和 Electron 工作台接线参考。
- Playwright / Browser Use：只作测试和验收工具，不作为 OpenColorful 运行时合同。

本 Feature Spec 只定义安全与产品边界；分阶段任务、文件归属、并行规则和命令以英文实施计划为准。
