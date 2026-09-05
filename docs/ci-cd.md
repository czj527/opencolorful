# OpenColorful CI/CD 开发流程

## 当前已落地

`.github/workflows/quality.yml` 在 Pull Request、推送到 `main` 和手动触发时运行四个门禁：

1. **Governance**：分析 diff，按 `docs/change-impact.json` 检查文档收口和例外理由。
2. **Typecheck, tests and builds**：Node 22.19、干净 `npm ci --legacy-peer-deps`、仓库 `npm run check`。
3. **Browser E2E**：先构建插件包与 Web 客户端（`build:protocol` + `build:sdk` + `web:build`，E2E 依赖插件包 `dist/` 与 `web/dist/`），安装 Chromium 后从 `web/` 运行 Playwright。
4. **Desktop true-chain smoke**（P1 波次 A · A3）：构建插件包与 Desktop 渲染层（`build:protocol` + `build:sdk` + `desktop:build`），在 `xvfb-run` 下从仓库根运行 `npx playwright test --config desktop/tests/e2e/playwright.config.ts --grep @smoke`——隔离 `OPENCOLORFUL_HOME`/`--user-data-dir` + 本地 stub Provider 的 Electron 真链最小流（引导 → 无 cwd 会话 → 首条消息 → 流式 → 中止 → 重启持久化）；失败上传 `desktop/test-artifacts/`（trace/截图/引导日志）。

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
- 每次合并到 `main` 会重复 CI；不会自动发布 npm 包。
- **桌面安装器发布（G2 起）**：`.github/workflows/release.yml` 在推送 `v*` tag 时于 windows-latest 打包（与本地 `npm run desktop:pack` 同一条链，pack 末尾自动执行 `verify:pack` asar 内容/原生模块/产物断言），创建 draft GitHub Release 并**逐资产断言**（安装器/`latest.yml`/blockmap 缺失自动 `gh release upload` 补传，仍缺则 fail）；`workflow_dispatch` 可不发版干跑打包。完整发布步骤、版本号同步脚本和应用内更新验收见 [release.md](release.md)。
- 打包链路只覆盖 Windows x64 NSIS（未签名）；macOS/Linux、签名公证为后续增强。

## 后续增强顺序

1. 启用 `main` 分支保护并确认三个 required checks 的实际名称。
2. 增加锁文件、Secrets、依赖漏洞和许可证审计。
3. 为浏览器 E2E 上传失败截图、trace 和视频制品。
4. 增加 nightly 的真实服务/恢复/长会话测试，不阻塞普通 PR。
5. ~~tag release workflow~~（G2 已落地 `release.yml`）。后续：安装包签名、macOS/Linux 打包矩阵、制品保留策略细化。
