---
name: Compat Failure
description: 兼容失败 fixture：metadata.opencolorful.version 不支持，验证迁移建议。
version: 0.1.0
license: MIT
metadata:
  opencolorful:
    version: 99
    requires:
      bins: [git]
---

# Compat Failure

metadata.opencolorful.version=99 不受支持：

- 标准化返回 unsupported 等级 + requiresManualMigration；
- 生态适配器 stage 必须给出迁移建议并拒绝（不生成空壳）。
