---
name: Network Heavy
description: 声明需要网络与外部 API 的 OpenClaw 风格 Skill：只做降级提示，安装不授权网络。
version: 0.9.0
license: Apache-2.0
metadata:
  openclaw:
    requires:
      env: [NETWORK_API_TOKEN]
      tools: [web-fetch]
      network: true
---

# Network Heavy

本 Skill 的正文说明它需要网络访问外部 API，但安装本身绝不授予网络权限：

- `network: true` 仅产生兼容性降级提示；
- 运行时是否允许网络由既有的 Sandbox/工具授权决定，与本包无关；
- 若 Agent 环境无网络授权，本 Skill 的 readiness 为 degraded，正文仍可读取。
