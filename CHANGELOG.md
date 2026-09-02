# Changelog

所有用户可见变化记录在这里。内部实现细节、阶段任务和审查记录分别归 `plans/`、`docs/` 和提交历史。

## [Unreleased]

### Fixed

- 模型调用失败（如 401 错 Key、限流）被记成"成功完成"且界面无任何失败提示：运行时现在识别 Provider 以 `stopReason=error` 返回的失败 turn，向会话事件流发出 `turn.failed`/`turn.cancelled` 终态，界面显示"生成失败"与可读错误行，用量与后台整理不再误触发（A4 真链回归发现）。
- 引导选"自定义"预设接入模型时，模型显示名残留上一预设的名称（显示成"DeepSeek Chat"）（A4 真链回归发现）。
- 档案页记忆设置连续快速修改时互相覆盖（读-改-写竞态导致先保存的字段丢失）：按 Agent 串行化保存（A4 真链回归发现）。
- 开发模式关于页显示 Electron 运行时版本而非应用版本（A4 真链回归发现）。
- 引导完成后首条消息可能被"还没有可用模型"拦截，或在机器上存在 Provider 环境变量凭据时静默选中内置模型把消息发到真实外部服务：引导向导现在完成即刷新模型与偏好列表，草稿模型不再使用过期数据。
- 对话中止（停止生成）或模型调用失败后界面永远停留在流式状态、无法继续输入：Desktop 时间线现在正确处理 `turn.cancelled` / `turn.interrupted` / `turn.failed` 终态事件——中止后消息标注"已停止"，失败显示"生成失败"与可读错误行，输入区立即恢复。
- 设置中"Subagent 默认模型"写入后不生效且会被任意后续偏好写入静默重置为默认：`PreferencesStore.update()` 现在正确持久化 `subagents` 段，并在修改无关设置项时保留已有值（路由 → 文件 → 重开全链路回归）。
- 新建助理未填可选工作目录时发送消息无反应：会话创建的工作目录改为三级解析（请求显式 > 助理默认目录 > 助理数据子树 workspace 兜底），不再形成"无法对话"死路；新会话草稿态现在会正常显示发送错误提示（此前错误被设置但不渲染）。

## [0.1.1] - 2026-08-28

### Fixed

- **安装包内嵌后端启动失败（v0.1.0 严重回归）**：打包 staging 改用 `file:` 依赖 + npm 实拷装载 `@opencolorful/plugin-protocol` / `plugin-runtime`，修复已安装应用启动即 `ERR_MODULE_NOT_FOUND`、全部功能不可用的问题；新增 `verify:pack` 产物断言（asar 内容/原生模块/更新 feed），打包与 CI 发布流程强制执行，杜绝同类缺包流出。
- **默认端口 4310 被无关程序占用时后端静默失败**：内嵌后端启动遇 `EADDRINUSE` 自动回退随机空闲端口；彻底失败时弹窗告知并附日志路径，不再静默降级。
- **API 代理可能把请求发给外来进程**：后端探测增加响应身份校验，非 OpenColorful 服务占用端口时不再误连。
- **发布资产上传兜底**：Release 工作流在 electron-builder 发布后逐项断言安装器/`latest.yml`，缺失自动补传，修复 draft 只有 blockmap 导致的更新检查失败。

### Added

- 建立项目文档治理、变更影响矩阵和 GitHub Actions 质量门。
- 桌面端 Windows x64 NSIS 安装器：内嵌后端，安装即用，无需单独启动服务（G2 T1）。
- 应用内版本更新：设置页"关于"可检查/下载更新，下载完成后经横幅"重启安装"（G2 T2，更新 feed 为 GitHub Releases）。
- 发布自动化：推送 `v*` tag 触发 GitHub Actions 打包并产出 draft Release（G2 T3）；发布步骤见 `docs/release.md`。

### Changed

- 例行依赖更新（Dependabot 月度）：tsx 4.23.12、@types/react 19.2.18、lucide-react 1.33.0。
