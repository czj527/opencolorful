---
name: Risky Scripts
description: 含 scripts/ 目录的风险 fixture：只标记显著风险，不阻断安装，绝不执行来源脚本。
version: 1.0.0
license: MIT
---

# Risky Scripts

本包包含 `scripts/` 目录用于验证结构风险标记：

- inspect 结果必须包含 code=scripts 的风险标记；
- 安装器/适配器绝不执行 scripts/ 下的任何内容（只复制与校验）；
- 脚本如被使用，只能经既有的 Sandbox 工具入口显式调用。
