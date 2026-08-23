# OpenColorful CI/CD 开发流程

## 当前已落地

`.github/workflows/quality.yml` 在 Pull Request、推送到 `main` 和手动触发时运行三个门禁：

1. **Governance**：分析 diff，按 `docs/change-impact.json` 检查文档收口和例外理由。
2. **Typecheck, tests and builds**：Node 22.19、干净 `npm ci --legacy-peer-deps`、仓库 `npm run check`。
3. **Browser E2E**：安装 Chromium，从 `web/` 运行 Playwright。

## GitHub 仓库设置

在 GitHub `main` 分支开启 Branch protection / Ruleset：

- 要求 Pull Request，禁止直接 push；
- required checks：`Governance`、`Typecheck, tests and builds`、`Browser E2E`；
- 要求分支在合并前更新到最新 `main`；
- 要求 conversation resolved；
- 允许管理员绕过只作为紧急恢复手段，并在事后补充记录；
- 删除已合并分支；
- 不把“允许失败”的 job 设为 required check。

当前仓库的 `main` 尚未启用 branch protection；合并 workflow 后必须手动完成上述设置，CI 才真正具备阻断能力。

## Pull Request 流程

```text
Issue / Feature Spec
  -> plans/<feature>.md 或 plans/phase-xx.md
  -> 一个可验收垂直切片
  -> Builder 实现
  -> Governance 影响审计
  -> Quality + Browser 验证
  -> 人工审查边界和证据
  -> 合并 main
```

PR 描述必须说明：目标、非目标、变更影响表面、文档收口、验证命令和已知风险。纯重构或机械变更可以使用 `docs-exempt: <具体原因>`，但不能用于公共 API、持久化、权限、Agent 行为或用户可见 UI 变化。

## Main 和发布

- `main` 是可集成分支，不直接承载未通过质量门的实验代码。
- 每次合并到 `main` 会重复 CI；当前不会自动发布 npm 包或桌面安装器。
- 发布前按 [release.md](release.md) 创建版本 tag，重新运行所有门禁，并在明确分发渠道后再增加制品上传和 GitHub Release 自动化。
- 桌面端分发前需要单独补充 Windows、macOS、Linux 的打包矩阵、签名、公证、更新通道和回滚策略。

## 后续增强顺序

1. 启用 `main` 分支保护并确认三个 required checks 的实际名称。
2. 增加锁文件、Secrets、依赖漏洞和许可证审计。
3. 为浏览器 E2E 上传失败截图、trace 和视频制品。
4. 增加 nightly 的真实服务/恢复/长会话测试，不阻塞普通 PR。
5. 明确桌面发布渠道后，再添加 tag release workflow、安装包签名和制品保留策略。
