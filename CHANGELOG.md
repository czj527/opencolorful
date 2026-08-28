# Changelog

所有用户可见变化记录在这里。内部实现细节、阶段任务和审查记录分别归 `plans/`、`docs/` 和提交历史。

## [Unreleased]

### Added

- 建立项目文档治理、变更影响矩阵和 GitHub Actions 质量门。
- 桌面端 Windows x64 NSIS 安装器：内嵌后端，安装即用，无需单独启动服务（G2 T1）。
- 应用内版本更新：设置页"关于"可检查/下载更新，下载完成后经横幅"重启安装"（G2 T2，更新 feed 为 GitHub Releases）。
- 发布自动化：推送 `v*` tag 触发 GitHub Actions 打包并产出 draft Release（G2 T3）；发布步骤见 `docs/release.md`。

### Changed

- 例行依赖更新（Dependabot 月度）：tsx 4.23.12、@types/react 19.2.18、lucide-react 1.33.0。
