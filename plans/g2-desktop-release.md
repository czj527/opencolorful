# G2 桌面发布分发与版本更新

**状态：进行中**
**基线提交：** `main` `59db678`
**创建时间：** 2026-08-28

## 背景与目标

参考 `references/openhanako` 的发布体系（electron-builder + GitHub Releases + electron-updater），为 desktop 建立：
1. **可分发产物**：Windows NSIS 安装器，内嵌后端，开箱即用（无需用户单独起 server）；
2. **应用内版本更新**：electron-updater 检查/下载/重启安装，设置页"关于"承载更新 UI；
3. **发布自动化**：tag 触发 GitHub Actions 构建并产出 draft Release（含 `latest.yml` 更新元数据）。

openhanako 方案中**不照搬**的部分（超出现阶段需求）：
- 自研 OTA 内容列车（ed25519 签名 + 灰度 + 回滚）——壳更新已够，远期再议；
- 四平台矩阵——唯一用户在 Windows，先只做 Windows x64，workflow 结构预留扩展；
- 代码签名/公证（无证书，SmartScreen 警告为已知限制）与国内镜像源（AtomGit）。

## 关键设计决策

1. **内嵌后端**：直接携带根 `npm run build` 的 tsc 产物（staging 为 `server-dist/`）+ 完整生产 `node_modules`，Electron 主进程在 packaged 模式下动态 `import()` `startForegroundServer` 并启动，监听 `127.0.0.1:4310`（`OPENCOLORFUL_PORT` 可覆盖）。**不用 esbuild 单文件化**：PI 扩展机制（jiti 从磁盘加载 sandbox/memory/skill/subagent-tools 四个扩展）与 `import.meta` 路径解析都按"文件在磁盘上"设计，单文件 bundle 要对抗这套机制，脆弱且收益小。启动失败（端口占用/锁冲突/环境异常）降级为现有纯代理模式，dev 工作流完全不变。
2. **数据目录**：沿用 `~/.opencolorful`（`OPENCOLORFUL_HOME` 可覆盖），packaged 与 CLI/dev 共享同一数据约定。
3. **打包 staging**：`desktop/scripts/stage-release.mjs` 生成 `desktop/release/app/`（gitignored）：精简 package.json（`type:module`，版本取自 `desktop/package.json`，dependencies 复刻根清单）+ `electron/*.cjs` + renderer `dist/` + `server-dist/` + `npm install --omit=dev --omit=optional`（better-sqlite3 由 electron-builder rebuild 到 Electron ABI）+ 手工拷贝 `@opencolorful/plugin-protocol`（workspace 私包未发布）。
4. **版本更新**：electron-updater GitHub provider（`czj527/opencolorful`），仅 packaged 生效；启动时 + 每 4h + 手动三处检查；`autoDownload=false`（遵循 openhanako 的用户可控决策）；状态机经 IPC `update:state` 推送渲染层；UI 入口为设置页"关于"区 + 下载完成后 App 级横幅。
5. **版本号唯一来源**：`desktop/package.json`；tag `vX.Y.Z` 与之对应；root `package.json` 由脚本同步（T3）。

## 范围

- **T1（本 lane）**：内嵌后端 + 打包管线——staging 脚本、electron-builder 配置、main.cjs 内嵌启动集成（含单实例锁、优雅停止、shell 日志）、本地产出 NSIS。
- **T2**：应用内版本更新——`auto-update.cjs` 状态机、preload 桥、设置页"关于"真实版本 + 更新 UI、App 横幅。
- **T3**：`.github/workflows/release.yml`（tag `v*` + 手动验证两种触发）、版本同步脚本、`docs/release.md` / `docs/ci-cd.md` / CHANGELOG 收口。

## 非目标

- macOS/Linux 打包与签名公证；OTA 内容列车；更新国内镜像；自动下载更新；crash 上报。
- 不改变任何服务端业务逻辑（`src/` 零改动，仅被 bundle 引用）。

## 依赖

- 新增 devDeps（desktop workspace）：`electron-builder`；T2 增加 dep `electron-updater`。
- CI：`release.yml` 需要 `contents: write` 权限（draft release），`GITHUB_TOKEN` 自动提供。

## 影响文件

- T1：`desktop/scripts/stage-release.mjs`（新）、`desktop/electron/main.cjs`、`desktop/electron-builder.yml`（新）、`desktop/package.json`、`package.json`、`package-lock.json`、本计划、`docs/project-status.md`、`AGENTS.md`。
- T2：`desktop/electron/auto-update.cjs`（新）、`desktop/electron/preload.cjs`、`desktop/electron/main.cjs`（两行接线）、`desktop/src/env.d.ts`、`desktop/src/components/SettingsModal.tsx`、`desktop/src/App.tsx`（或新组件）、`desktop/src/styles.css`。
- T3：`.github/workflows/release.yml`（新）、`scripts/bump-desktop-version.mjs`（新）、`docs/release.md`、`docs/ci-cd.md`、`CHANGELOG.md`。

## 质量门

- 每 PR：`npm run check` 全链路（含 governance 文档收口）。
- T1：本地 `npm run pack --workspace=@opencolorful/desktop` 产出 NSIS；安装到隔离目录 + 临时 `OPENCOLORFUL_HOME`，实测 onboarding→对话主链路（无独立后端进程）。
- T3：workflow_dispatch 干跑（`--publish never`）验证 CI 打包；首个真实 tag 由作者决定何时切。

## 验收标准

- Windows 安装器可安装、可启动，无独立后端即可完成对话主链路；
- 设置页"关于"显示真实版本与更新状态，更新三态（检查/下载/重启）可操作；
- tag 推送后 CI 产出含 `latest.yml` 的 draft Release；
- 更新链路在首个真实版本对（v0.1.0→v0.1.1）上验证。

## 实施记录

（按任务回写真实提交、命令、结果和偏差）

### T1 内嵌后端 + 打包管线（lane：g2-desktop-release-t1）

- 2026-08-28 设计修正：弃用 esbuild 单文件 bundle 方案（`import.meta.url` 在 CJS 输出为空、PI 四扩展按磁盘文件由 jiti 加载且从宿主源码树解析导入——单文件化需对抗整套机制），改为直接携带根 `npm run build` 的 `dist/`（staging 为 `server-dist/`）+ 完整生产 node_modules。风险面与 `ocf` CLI 生产模式完全一致。
- 踩坑记录：① Windows 下 `execFileSync("npm.cmd")` 不经 shell 无法执行，改 ComSpec 模式（同 dev.mjs）；② staging npm install 需 `--legacy-peer-deps`（@hono/node-ws peer 范围过时，与根仓库一致）；③ electron-builder 要求 Electron 钉死精确版本，`desktop/package.json` 从 `^37.2.6` 改为 `37.10.3`（与锁文件解析一致）。
- staging 冒烟（真实 Node，临时 OPENCOLORFUL_HOME）：`startForegroundServer` 从 staging 布局启动成功，`GET /api/health` 200，优雅停止正常。
- **打包实测通过（2026-08-28，本机 Windows）**：`npm run desktop:pack` 全链（根 build → staging → 定向 rebuild → electron-builder）产出 `OpenColorful-0.1.0-Windows-x64.exe`（NSIS，未签名）；`win-unpacked/OpenColorful.exe` 以隔离 `OPENCOLORFUL_HOME` + 自定义端口启动——内嵌后端 online（shell.log 有记录），`/api/health`、`/api/settings/preferences`、`/api/agents` 全部 200；taskkill（WM_CLOSE）触发优雅退出，`server.json` 置 `stopped`、服务锁释放。定向 rebuild 双向验证：lane 根 `new Database` 正常（Node ABI 未受污染）、staging 副本在 Node 下 `ERR_DLOPEN_FAILED`（已是 Electron ABI）、打包应用内数据库正常工作。
- 踩坑记录（续）：④ electron-builder 的 `npmRebuild` 是 workspace-aware——会把 better-sqlite3 rebuild 作用到根 node_modules 的提升副本，全量 DB 测试在 `new Database` 抛 `ERR_DLOPEN_FAILED`（注意：better-sqlite3 v12 懒加载 .node，`require` 探测查不出 ABI 损坏，必须 `new Database`）。修复：`npmRebuild:false` + `desktop/scripts/rebuild-native.mjs`（@electron/rebuild 只处理 staging）；本地根副本损坏时 `npm rebuild better-sqlite3` 恢复；⑤ 内嵌后端使用自定义端口时代理探测不到，内嵌启动成功后由 main.cjs 写入 `OPENCOLORFUL_SERVER_URL` 直连（见 main.cjs 注释）。
