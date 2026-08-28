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
3. **打包 staging**：`desktop/scripts/stage-release.mjs` 生成 `desktop/release/app/`（gitignored）：精简 package.json（`type:module`，版本取自 `desktop/package.json`，dependencies 复刻根清单）+ `electron/*.cjs` + renderer `dist/` + `server-dist/` + `npm install --omit=dev --omit=optional`（better-sqlite3 由 `rebuild-native.mjs` 定向 rebuild 到 Electron ABI）+ workspace 插件包（`@opencolorful/plugin-protocol`/`plugin-runtime`）以 `file:` 依赖声明 + `.npmrc install-links=true` 实拷进 node_modules 并记入 lockfile（T4 修正：事后手工拷贝会被 electron-builder 依赖收集器当未声明包剪掉，见 T4 实施记录）。
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
- **dispatch 干跑首败与修复（T3b）**：`desktop:pack` 原顺序 `build → build:protocol` 在干净环境（CI 全新 checkout）炸 TS2307——`src/contracts/plugin-protocol.ts` 经 exports 指向 workspace 包 dist，根 tsc 构建时 dist 尚不存在（本机 lane 因有历史构建产物而掩盖）。修复为 `build:protocol → build:sdk → build → pack`（与 `npm run check` 同序），并模拟干净环境（删 `dist/` 与 `packages/*/dist/`）重跑全链验证。教训：**凡涉及构建顺序的改动，必须在无 dist 的干净环境验证一次**。

### T4 v0.1.0 安装版全功能失效热修（lane：fix/desktop-release-hardening）

- 2026-08-28 事故：作者安装 CI 产出的 v0.1.0 后，Provider 保存/日志/全部 API 均失败。三个叠加根因：
  1. **asar 缺 workspace 包（致命）**：staging 对 `@opencolorful/plugin-protocol`/`plugin-runtime` 采用 npm install 后手工拷贝——两者不在 staging 清单/lockfile 里，electron-builder 的生产依赖收集器（`searching for node modules`）把未声明包当游离包**剪掉**，asar 内缺失 → 安装版启动内嵌后端即 `ERR_MODULE_NOT_FOUND`。**此前 T1 的"win-unpacked 实测通过"是假阳性**：win-unpacked 位于仓库树内，asar 缺失的 import 沿父目录静默解析到仓库自身 node_modules。教训：**打包验收必须在仓库树之外运行**（或至少做 asar 内容断言），仓库内运行无效。
  2. **端口 4310 被 QQ 占用**：QQ 在本机监听 `127.0.0.1:4310` 且对 `/api/health` 返回 200 二进制。内嵌启动 EADDRINUSE 后代理降级探测，`probe()` 只查 `response.ok` → 误把 QQ 当后端锁住，所有 API 收到乱码（表现为"保存失败"而非"连接失败"）。
  3. **发布资产不完整**：tag 运行的 publish 步骤日志在 `creating GitHub release` 后无任何上传完成记录却退出码 0，draft 里只有 `.blockmap`（缺安装器与 `latest.yml`）→ 应用内更新检查必败。
- 修复（本 lane）：
  - `stage-release.mjs`：两个 workspace 包改为 staging 清单的 `file:../../../packages/*` 依赖 + staging `.npmrc` `install-links=true`（npm 语义与字面相反，**true 才是实拷**，已实测），进入 lockfile 成为一等生产依赖；删除手工拷贝；新增 staging 后断言（实拷存在 + 非软链，fail-fast）。
  - `desktop/scripts/verify-pack.mjs`（新）：asar 内容断言（plugin-protocol/plugin-runtime/electron-updater/better-sqlite3/server-dist/renderer/主进程入口）+ `app.asar.unpacked` 原生模块存在性 + `latest.yml`/安装器存在性；接入 `pack` 脚本末尾（本地与 CI 同门槛）。
  - `api-proxy.cjs`：`probe()` 增加响应身份校验——agent server 要求 `{status:"ok", version:string, pid:int}`，supervisor 要求 `{supervisor:{pid,port}, agentServer:{status}}` 形状；外来进程（QQ 二进制 200）一律拒绝。
  - `main.cjs`：内嵌启动 `EADDRINUSE` 回退随机端口（`startForegroundServer` 本就回写实际端口到 server.json，代理经 `OPENCOLORFUL_SERVER_URL` 直连）；彻底失败时 `dialog.showErrorBox` 告知并附 shell.log 路径（不再静默）。
  - `release.yml`：verify 步骤改调 `verify:pack`；publish 后新增资产断言步骤——缺失资产用 `gh release upload --clobber` 补传，仍缺则 fail。
  - 版本 0.1.0 → 0.1.1（`bump-desktop-version.mjs`）；v0.1.0 标记为不可用版本（crash 级缺陷），其 tag/draft 由作者清理。
- 验证（2026-08-28，本机）：
  - staging：`file:` + `install-links=true` 后 `node_modules/@opencolorful/*` 为实拷目录（非软链），lockfile 有两包真实条目；断言脚本当场抓住过 npm 默认软链行为（fail-fast 生效）。
  - `npm run pack --workspace=@opencolorful/desktop` 全链绿，`verify:pack` 14 项断言全过（两 workspace 包/electron-updater/better-sqlite3 入 asar，原生模块已 unpack，`latest.yml` + NSIS 俱在）。
  - **仓库外启动冒烟**：win-unpacked 拷到 `%TEMP%`（脱离仓库树）+ 隔离 `OPENCOLORFUL_HOME` 启动——内嵌后端 online，`/api/health` 200（`{"status":"ok","version":"0.1.1",...}`）、`/api/settings/preferences` 200、`/api/agents` 200、`PUT /api/settings/providers` 空体返回 400 `INVALID_INPUT` 中文结构化错误；WM_CLOSE 优雅停止（server.json `stopped`）。
  - **EADDRINUSE 回退**：先用 dummy 进程占住 4310 再启动——shell.log 记录 warn 回退，内嵌后端在随机端口 53938 online，server.json 记录实际端口；二次优雅停止正常。
  - **probe 身份校验活体验证**：本机 QQ 占用 4310 期间 `resolveBase()` 返回 `null`（修复前会锁住 QQ）。
  - 根 `npm run check` 与 `check:docs` 结果见 PR 描述。
