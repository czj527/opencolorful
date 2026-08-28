# OpenColorful 发布流程

发布物是 **desktop 桌面端安装器**（G2 起）：Windows x64 NSIS，内嵌后端，安装即用。版本号唯一来源是 `desktop/package.json`，tag `vX.Y.Z` 必须与之相等（release workflow 会校验，不一致直接失败）。

## 发布前

1. 确认 `docs/project-status.md`、路线图和活动计划一致。
2. 在干净环境运行 `npm ci --legacy-peer-deps`。
3. 运行 `npm run check` 和 Browser E2E（CI 在 PR 上已跑过一轮，发布前确认 main 最新一轮全绿即可）。
4. 本地跑一遍 `npm run desktop:pack`（末尾自动执行 `verify:pack` 断言 asar 内容/原生模块/更新 feed）。
5. **仓库外启动冒烟**（v0.1.0 教训：win-unpacked 在仓库树内运行会静默借用仓库 node_modules，缺包查不出）：把 `desktop/release/bundles/win-unpacked/` 复制到仓库外的临时目录，用隔离 `OPENCOLORFUL_HOME` 启动 `OpenColorful.exe`，确认内嵌后端 online（userData `logs/shell.log`）且 `/api/health` 可达。
6. 检查 `git diff --check`、凭据扫描和待迁移事项。

## 发布操作

1. `node scripts/bump-desktop-version.mjs <新版本号>`（同步 desktop/根 package.json 与锁文件）。
2. 更新 `CHANGELOG.md`：`Unreleased` 收口为 `[<版本号>]`，复制用户可见内容和已知限制备用。
3. 提交并经 PR 合并到 `main`，确认 required checks 通过。
4. `git tag v<版本号> && git push origin v<版本号>`。
5. `.github/workflows/release.yml` 自动执行：打包（同 `npm run desktop:pack`，含 `verify:pack` 断言）→ 创建 **draft** GitHub Release 并上传产物 → **逐资产断言**（安装器/`latest.yml`/blockmap，缺失自动用 `gh release upload` 补传，仍缺则工作流失败）。
6. 在 GitHub 上检查 draft Release：粘贴 CHANGELOG 内容，确认资产完整（`.exe` + `.exe.blockmap` + `latest.yml`）后手动发布。

非发布验证：手动触发 release.yml（workflow_dispatch）只打包并上传 workflow artifacts，不创建 Release。

## 应用内更新（electron-updater）

- 正式发布的 Release 中的 `latest.yml` 是更新 feed；打包版应用启动 10 秒后、之后每 4 小时自动检查，用户也可在 设置 → 关于 → 版本更新 手动检查。
- 更新不会自动下载：发现新版本后由用户点击"下载更新"，下载完成经横幅/"重启安装"按钮触发 `quitAndInstall`。
- 新版本的更新链路验收：安装上一版本的安装器，启动后应能在"关于"页看到新版本提示。

## 已知限制

- **未签名**：Windows SmartScreen 会警告"未知发布者"（无代码签名证书，G2 非目标）。
- 默认 Electron 图标（品牌图标未做）。
- 仅 Windows x64；macOS/Linux 打包矩阵与签名公证为后续增强。
- 更新 feed 只有 GitHub Releases 单源（无国内镜像）。

## 回滚

- 应用回滚以 GitHub Release / tag 为单位：删除有问题的 Release（用户端更新检查随之不可见），修复后发布新版本号，不直接重写 `main`。
- 数据库迁移必须在对应计划中说明向前修复和备份恢复路径。
- 若发现凭据泄露或审计失效，优先按 `SECURITY.md` 和 Runbook 处理，不等待普通版本发布。
