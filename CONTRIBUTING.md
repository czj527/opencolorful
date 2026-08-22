# 贡献指南

感谢关注 OpenColorful。本项目当前处于早期快速演进阶段，欢迎 issue 与 PR。

## 开发环境

- Node.js >= 22.19.0，npm（workspaces）
- Windows / macOS / Linux（当前主要在 Windows 上开发验证）

```powershell
npm install --legacy-peer-deps
npm run check
```

`npm run check` 依次执行：PI import 边界检查、类型检查、全部测试与生产构建。
提交前请确保其完整通过，且每条关键验证命令单独执行、单独确认退出码。

## 约定速览

- 协作权威是 [AGENTS.md](AGENTS.md)：架构硬约束（PI SDK 边界 / Server-first /
  数据所有权 / 事件协议 / 安全红线）必须先读。
- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`；
  相对 import 带 `.js` 后缀；跨进程输入用 TypeBox 或显式解析器校验。
- 错误信息默认中文且不包含敏感输入；代码标识符使用英文。
- 测试不得请求真实 Provider 网络，使用 faux provider 与临时 `OPENCOLORFUL_HOME`。
- 不得在提交中引入任何 API Key、Authorization、Cookie 等敏感值。

## 提交与 PR

- 提交信息格式：`type(scope): 中文摘要`（如 `feat(sessions): ...`），
  历史提交为准。
- PR 请说明动机、改动范围与验证证据（质量门输出、测试或截图）。
- 改动文档约定（AGENTS.md / docs/）时，请同步更新相关章节。
