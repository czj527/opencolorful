# OpenColorful 发布流程

当前项目是私有 npm workspace 应用，发布重点是可复现构建、GitHub Release 和桌面制品；在明确分发渠道前，不自动发布 npm 包或桌面安装器。

## 发布前

1. 更新 `CHANGELOG.md` 的 `Unreleased`。
2. 确认 `docs/project-status.md`、路线图和活动计划一致。
3. 在干净环境运行 `npm ci --legacy-peer-deps`。
4. 运行 `npm run check` 和 Browser E2E。
5. 进行一次真实浏览器验收，并保留截图或录屏证据。
6. 检查 `git diff --check`、凭据扫描和待迁移事项。

## 发布操作

1. 合并到 `main`，确认所有 required checks 通过。
2. 创建版本 tag，例如 `v0.1.0`。
3. GitHub Actions 在 tag 上重复质量门，并生成经过验证的构建目录或压缩包。
4. 创建 GitHub Release，复制 Changelog 的用户可见内容和已知限制。

## 回滚

- 应用回滚以 GitHub Release / tag 为单位，不直接重写 `main`。
- 数据库迁移必须在对应计划中说明向前修复和备份恢复路径。
- 若发现凭据泄露或审计失效，优先按 `SECURITY.md` 和 Runbook 处理，不等待普通版本发布。
