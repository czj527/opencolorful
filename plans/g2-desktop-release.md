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

### T2 应用内版本更新（lane：g2-desktop-release-t2）

- 2026-08-28 实现要点：
  - `desktop/electron/auto-update.cjs`（新）：electron-updater 状态机，导出 `initAutoUpdater({ getWindow, log })`，幂等（module 级 `initialized` 守卫）；state 变化经 `getWindow()?.webContents.send("update:state-changed", state)` 推送；`autoDownload=false` / `autoInstallOnAppQuit=false` / `disableDifferentialDownload=true` / `allowPrerelease=false`；仅 `app.isPackaged` 真实工作（非 packaged status 恒 "unsupported"，IPC 仍注册）；启动后 10s 首次检查 + 每 4h 定时；并发守卫 `checkInFlight` 防重复检查（覆盖 electron-updater 自身"检查进行中"抛错路径）；error 态 message 为中文（`更新失败：` + err.message 清理后截断 200 字符，剥离 URL 查询参数，不含堆栈）；logger 接 shellLog。
  - IPC：`update:get-state` / `update:check` / `update:download`（仅 available 态）/ `update:install`（仅 downloaded 态 `quitAndInstall(false, true)`）。
  - `desktop/electron/preload.cjs`：新增第三个桥 `desktopUpdate`（getState/check/download/install/onStateChanged，订阅返回取消函数）。
  - `desktop/src/env.d.ts`：`DesktopUpdateStatus` / `DesktopUpdateState` / `DesktopUpdateApi` 类型 + Window 键（沿用 readonly 风格）。
  - 设置页关于区（`SettingsModal.tsx`）：版本行 small 改为桥上报版本（无桥显示 `dev`）；新增"版本更新" setting-section，八态映射（unsupported/idle/checking/none/available/downloading/downloaded/error），downloading 在 setting-note 容器内放进度条（styles.css 新增 `.update-progress*`，仅用现有变量 `--border/--accent/--text-3/--mono`）；进入 about 类目时 `getState()` + `onStateChanged` 订阅，卸载/切类目取消。
  - `desktop/src/components/UpdateBanner.tsx` + `.css`（新）：下载完成横幅（"新版本 v{newVersion} 已就绪" + 重启安装 + X 关闭），关闭按版本记忆（localStorage `oc-update-dismissed:<newVersion>`）；App.tsx 订阅状态驱动挂载（与 MockBanner 同层级），根节点按需加 `has-update-banner` grid 行（含与 mock 横幅并存的四行组合）。
  - **交付前修正（超出 Brief 文件清单的 1 处，见下方偏离说明）**：`desktop/scripts/stage-release.mjs` 的 staging 应用依赖原只复刻根 `package.json`，electron-updater 不会进入打包产物（打包后主进程 require 即崩溃），改为 `{ ...rootPkg.dependencies, ...desktopPkg.dependencies }` 合并。
- 依赖：`desktop/package.json` dependencies 新增 `electron-updater@^6.8.3`（解析到 6.8.9），lane 根 `npm install --legacy-peer-deps` 同步 package-lock.json；仅在主进程 require，renderer 不 import。
- 验证结果（2026-08-28，lane 根）：`npm run desktop:build`（tsc --noEmit + vite build）通过；`npm run check:docs` 通过；`npx tsc --noEmit -p tsconfig.json`（根，不含 desktop）通过。未运行 electron-builder（与 CI 重复）；全量 vitest 由主 Agent 复核时跑。
- 已知限制：真实更新链路（GitHub Release 元数据 → 检查 → 下载 → 重启安装）待首个 tag 版本对（v0.1.0→v0.1.1）实机验证；dev 模式与浏览器无桥场景状态固定 unsupported/"dev"，属预期。

### T3 发布自动化与文档收口（lane：g2-desktop-release-t3）

- 2026-08-28 实现要点：
  - `.github/workflows/release.yml`（新）：tag `v*` 推送 + `workflow_dispatch`（不发版验证）双触发；windows-latest 单 job：tag 与 desktop/package.json 版本一致性守卫（fail fast）→ `npm run desktop:pack`（与本地同链）→ 产物校验（NSIS + `latest.yml` 缺一即 fail）→ workflow artifacts 上传（14 天保留）→ 仅 tag 构建执行 `electron-builder --publish always`（复用已 staging 的 release/app，GitHub provider 默认 draft release）。`permissions: contents: write`，`GH_TOKEN` 用自动注入的 `GITHUB_TOKEN`，无需额外 secrets。
  - `scripts/bump-desktop-version.mjs`（新）：版本号同步（desktop/package.json 为唯一来源 → 根 package.json + package-lock.json），打印 CHANGELOG/合并/打 tag 的后续步骤。
  - `docs/release.md` 重写为真实发布流程（bump → CHANGELOG → PR → tag → workflow → draft release 人工确认发布）+ 应用内更新说明 + 已知限制（未签名 SmartScreen/默认图标/仅 Windows/单源 feed）+ 回滚。
  - `docs/ci-cd.md`："Main 和发布"更新为 G2 现状；后续增强第 5 项（tag release workflow）标记已落地。
  - `CHANGELOG.md` Unreleased 补 G2 三条用户可见变化（安装器/应用内更新/发布自动化）。
