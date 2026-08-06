---
name: Hello OpenClaw
description: OpenClaw 风格演示 Skill：metadata.openclaw.requires 转换、os 名称映射与 network 降级提示。仅指令，不调用任何外部服务。
version: 1.0.0
license: MIT
disable-model-invocation: true
metadata:
  openclaw:
    requires:
      os: [windows, linux, macos]
      bins: [git, curl]
      env: [OPENCLAW_HOME]
      tools: [bash]
      capabilities: [filesystem-read]
      network: true
    icon: hello.svg
---

# Hello OpenClaw

本 Skill 演示 OpenClaw 生态包被 OpenColorful 标准化的行为：

1. `metadata.openclaw.requires` 被转换为 `opencolorful.requires`（仅依赖提示与
   readiness 诊断，不产生任何 Grant）。
2. `os` 名称映射：windows→win32、linux→linux、macos→darwin。
3. `network: true` 只记录降级提示（"仅作风险展示，不授予网络权限"），
   本 Skill 绝不发起任何网络请求。
4. `disable-model-invocation: true`：禁止模型自动调用，仅显式触发。

## 工作流程

- 检查 `git`/`curl` 是否可用（readiness 已按 requires.bins 诊断）。
- 仅在用户显式要求时执行本地命令；不读取 `OPENCLAW_HOME` 之外的任何内容。
- 不越权：网络、凭据、写入操作都超出本 Skill 能力范围。
