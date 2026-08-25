# G0-CI-1：GitHub Actions 质量门 Linux 适配修复

- **状态**：进行中
- **基线**：`main` `555313a`（docs: streamline public repository documentation）
- **类型**：Governance G0 / CI 修复波次（非产品 Phase）
- **建立原因**：首次运行 `quality.yml` 即全红（push run 32626964096），main 失去门禁意义。

## 背景与问题

CI 三个 job 中 Governance 通过，Quality 与 Browser E2E 失败。逐项定位：

### Q1. `directory-picker`（2 个失败）

`WindowsFolderPicker` 用 `path.isAbsolute` 校验 PowerShell 输出；POSIX 宿主上
`C:\…` 不是绝对路径，测试在 Linux 必挂。输出按定义是 Windows 路径，
校验语义应为 `path.win32.isAbsolute`（与宿主无关）。

### Q2. `subagents-context-resolver`（3 个失败）

`isWorkspaceRelativePath` 的平台语义依赖宿主：POSIX 上 `D:\other\file.txt`
不是绝对路径、`..\secret.txt` 的反斜杠是普通文件名字符，Windows 形态的
越界引用在 Linux 宿主上可能绕过检查（fail-closed 失效方向）。
修复：判定与宿主平台无关——拒绝 win32+posix 两种绝对形态，反斜杠归一为
正斜杠后拒绝任何 `..` 段。测试 fixture 工作区改为宿主绝对路径
（win32: `D:\work\project`，其他: `/tmp/work/project`）。

### Q3. `skills/sources` 信任配置往返（1 个失败）

`parseConfig` 对 trustedRoots 做 `path.resolve` 归一化（by design）；测试用
Windows 形态路径 `C:\work\proj` 断言原样往返，POSIX 上 resolve 结果失真。
测试改为宿主平台绝对路径 + 断言 resolve 后的规范形态。

### Q4. `skills/composition-root`（1 个失败）

sdk-showcase-skill `requires.bins: [git]`；`detectPathBins` 单目录 500 /
全局 5000 的旧限额在 ubuntu runner 上把 `/usr/bin`（约 2700+ 条目）里的
git 挤出检测范围 → readiness 误判 blocked → 可见集为空。
修复：限额改为可注入参数（`DetectPathBinsLimits`），默认值提升为
per-dir 5000 / total 50000（限额只防病态 PATH；目录枚举成本由
readdirSync 产生，与限额无关）；`detect-path-bins.test.ts` 用小限额验证
限额行为，另加默认值护栏断言。

### Q5. `usage-recorder` 日期炸弹（本地全量暴露，CI 暂未触发）

`makeTurnCompletedEvent` 默认时间戳硬编码 `2026-07-25T12:00:00.000Z`，而
`UsageStore.summary(days)` 按 `now - days` 过滤——运行日期晚于
2026-08-24 后事件落出 30 天窗口，测试随日历翻转失败（CI 在 08-23 运行
恰好仍在窗口内所以是绿的）。修复：默认时间戳改 `new Date().toISOString()`。
同类的 retention 日期炸弹此前已在 `a3613d6` 修过一处；已全量扫描
`tests/` 其余硬编码日期：memory 用例注入假时钟、contract 用例无窗口查询、
usage-api 窗口用例本就用动态日期，均无此问题。

### E1. Browser E2E 全灭（57 failed / 0 passed / 2 did not run）

workflow 的 browser job 缺少构建步骤：插件包 `dist/`（agent server 子进程
经 workspace exports 解析）与 `web/dist/`（supervisor 静态资源）都不存在，
页面无 UI 可测、agent server 起不来。修复：browser job 在 Playwright 前补
`build:protocol && build:sdk && web:build`（与 `npm run check` 一致的最小集合）。

## 变更文件

- `src/platform/folder-picker.ts`（Q1）
- `src/runtime/subagents/context-resolver.ts`（Q2，fail-closed 加固）
- `tests/unit/subagents-context-resolver.test.ts`（Q2）
- `tests/unit/skills/sources.test.ts`（Q3）
- `src/runtime/skills/composition.ts`（Q4）
- `tests/unit/skills/detect-path-bins.test.ts`（Q4）
- `tests/integration/usage-recorder.test.ts`（Q5）
- `.github/workflows/quality.yml`（E1）
- `docs/ci-cd.md`（E1 同步）
- `docs/project-status.md`（基线回写）

## 验收

- [x] 受影响测试本地（Windows）通过：directory-picker 17、subagents-context-resolver 15、
  sources 13、composition-root 4、detect-path-bins 5
- [x] 本地门禁逐项通过：check:docs / verify-pi-sdk-imports / tsc --noEmit / web 单测 426 /
  web:build / tsc build / desktop:build
- [x] `npx vitest run` 全量通过（178 文件 / 2095 用例，本地 Windows）
- [x] `cd web; npx playwright test` 本地通过（59/59，1.4m）
- [ ] GitHub Actions Quality / Browser E2E 转绿

## 已知边界

- `detectPathBins` 默认限额提升后，病态 PATH（十万级条目目录）仍被 total 限额截断；
  真实发行版 bin 目录规模远低于默认值。

## 第二轮（CI run 32825328632 复查后）

第一轮推送后：Governance 转绿；Quality 2091/2095，仅
`subagents-mailbox-coordinator` 退避重试用例在高负载下 waitUntil 2s 超时
（定时器调度延迟，非语义问题；上一轮 CI 该用例通过）——该用例三处等待
窗口放宽到 10s。Browser E2E 从 57 败降至 **58 过 / 1 败**：唯一失败是
`phase8.spec.ts` 原生目录选择用例在 Linux 下仍断言「选择目录」按钮可见，
而 UI 设计上非 Windows 回退手工输入（不渲染按钮）——用例补平台分支：
非 Windows 断言按钮不存在 + 手工输入框可见。

- `tests/unit/subagents-mailbox-coordinator.test.ts`（CI 高负载等待窗口放宽）
- `web/tests/e2e/phase8.spec.ts`（目录选择用例平台分支）
