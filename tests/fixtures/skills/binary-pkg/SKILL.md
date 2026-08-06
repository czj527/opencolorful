---
name: Binary Pkg
description: 含二进制可执行文件的拒绝路径 fixture：skill_binary_denied。
version: 1.0.0
license: MIT
---

# Binary Pkg

本包包含 `tools/helper.exe`，验证二进制拒绝路径：

- validator 对 .exe 给出 skill_binary_denied（fail-closed）；
- 生态适配器/安装器拒绝安装并给出迁移建议（建议转换为 Plugin 分发）。
