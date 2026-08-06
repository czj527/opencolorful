---
name: Broken Unsupported
description: 携带不受支持的 OpenColorful 扩展版本，用于验证迁移建议拒绝路径。
version: 0.1.0
metadata:
  opencolorful:
    version: 2
    requires:
      bins: [git]
---

# Broken Unsupported

metadata.opencolorful.version 不是 1：T2 标准化返回 unsupported 等级，
生态适配器 stage 必须给出迁移建议并拒绝安装（不生成表面成功的空壳）。
