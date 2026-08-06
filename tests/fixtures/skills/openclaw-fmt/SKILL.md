---
name: OpenClaw Fmt
description: 单包形态的 OpenClaw 风格 Skill（kind=local 安装流）：requires 转换 + 网络降级提示。
version: 2.0.0
license: MIT
metadata:
  openclaw:
    requires:
      os: [win32, darwin, linux]
      bins: [git]
      tools: [bash]
      capabilities: [filesystem-read]
      network: true
---

# OpenClaw Fmt

独立目录包（无 registry 包裹），用于验证"生态格式包经标准 local 来源安装"：

- 兼容等级 openclaw；
- opencolorful.requires.bins=[git]、os=[win32,darwin,linux]、tools=[bash]、
  capabilities=[filesystem-read]；
- network:true 只产生降级提示，安装不授予网络权限。
