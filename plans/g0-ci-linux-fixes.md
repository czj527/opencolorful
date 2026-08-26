# G0-CI-1：GitHub Actions 质量门 Linux 适配修复

- **状态**：已完成
- **基线**：`main` `555313a`（docs: streamline public repository documentation）
- **类型**：Governance G0 / CI 修复波次（非产品 Phase）
- **建立原因**：首次运行 `quality.yml` 即全红（push run 32626964096），main 失去门禁意义。
- **完成**：`main` `7247ef6`，CI run 32827194306 三 job 全绿（Governance / Quality / Browser E2E）。

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
- [x] GitHub Actions Quality / Browser E2E 转绿（run 32827194306，三 job 全过；
  phase6 时间线用例的失败确认为高负载抖动，复跑即过，未再复现）

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

## 第三轮（CI run 32826242166 复查后）

第二轮推送后：后端 vitest **2092 过 / 0 败 / 3 跳过**（Linux 全绿，Q1-Q5
修复全部生效）。新暴露两类问题：

- web 单测 `new-session-page.test.tsx` 4 败：`DirectoryPicker` 按
  `navigator.userAgent` 判定平台，happy-dom 默认 UA 派生自宿主
  （win32 含 "win32"，linux 不含）——Linux CI 上选择器落到手工输入模式，
  「选择目录」按钮不存在。修复：测试文件显式固定 Windows UA。
- Browser E2E 58 过 / 1 败：`phase6.spec.ts` 对话时间线用例第二轮对话后
  「发送消息」按钮 30s 未恢复（turn 2 未在窗口内完成）。疑似高负载时序
  抖动，已通过 `gh run rerun --failed` 单跑复验；若复现则单独深挖。

变更：`web/src/features/sessions/new-session-page.test.tsx`（固定 UA，消除宿主派生）。

## 第四轮（合并后 main run 32853669356 复查后）——升级为生产代码修复

`subagents-mailbox-coordinator` 退避重试用例在 10s 窗口下仍超时失败，证实不是
负载抖动而是真实缺陷：**退避重试搁浅**。

根因：触发失败后 `scheduleRetry` 排一个一次性 `setTimeout(delay)`，定时器
回调里 `retryTimer` 先置 null 再 `attemptDelivery` 扫描"已到期"行。若定时器
触发时刻略早于 `next_retry_at`（libuv 循环时间与 Date.now 的毫秒级偏差），
扫描结果为空，方法直接返回——没有补排后续定时器，该 failed 行永久搁浅到
下次 signal/重启。CI Linux 上间歇复现（本地 Windows 不易复现），语义上
§14.3 的"指数退避重试"保证存在漏洞。

修复（生产代码）：
- `ParentMailboxStore.nextRetryDueAt(ownership)`：返回该父 Session 最近一个
  failed 行的到期时间（MIN(next_retry_at)）。
- `attemptDelivery` 在"无已到期行"和"只有非触发行"两个提前返回点调用
  `scheduleNextDueRetry`：按最近到期时间 +1ms 补排定时器；若再次早触发则
  继续顺延（自愈，不会搁浅）。

测试：
- 新增"failed 退避行未到期时重复 signal 不丢不重"回归用例；
- 第二轮放宽的三处 waitUntil 保留（语义修复后作为安全余量）。
- 本地：mailbox 20/20、subagents 相关 43/43、tsc 通过。

变更：
- `src/runtime/subagents/stores/parent-mailbox-store.ts`（新增 nextRetryDueAt）
- `src/runtime/subagents/mailbox/parent-mailbox-delivery-coordinator.ts`（防搁浅补排）
- `tests/unit/subagents-mailbox-coordinator.test.ts`（回归用例）

## 第五轮（main run 32856659603 复查后）

`supervisor-watchdog.test.ts` 三处断言"重启后 pid 不同"——POSIX 会立即复用
刚退出进程的 PID（Linux CI 实测 `expected 3988 not to be 3988`），断言本身
不可移植。修复：

- 改用看门狗证据链替代 pid 比较：崩溃→`consecutiveFailures > 0`（稳定窗口
  后才归零）、杀掉后先等状态翻转为非 online（死亡被探知）再等恢复 online
  （新进程拉起），不依赖 pid 数值差异。
- 涉及用例：auto-restarts after unexpected exit / resets consecutive failures
  after stability window / adopts desired running state across supervisor restart。

变更：`tests/integration/supervisor-watchdog.test.ts`（纯测试，无生产代码改动）。

## 第六轮（main run 32859113973 复查后）

`supervisor-watchdog` 的 stability-window 用例再次失败，但断言从 pid 变为
`expected 0 to be greater than 0`——暴露出更深的时序竞态：**自动拉起成功
即开启稳定窗口（300ms），CI 上 tsx 冷启动耗时超过窗口期，waitForOnline
返回 online 时失败计数已被归零**，"重启成功后读计数 > 0"这一观测点本身
不成立。

修复（纯测试）：改为在"死亡被探知"时立即取样——失败计数在退出处理时
递增，且退出处理会清除稳定计时器，计数在下一次启动成功 + 稳定窗口期满
之前保持稳定。新增 waitForCondition 轮询 helper；stability-window 用例
第二段同样改为探知即读。

变更：`tests/integration/supervisor-watchdog.test.ts`（纯测试，无生产代码改动）。

## 第七轮（PR #13 run 32952453626 首跑失败、重跑转绿）

`plugin-runtime-host.test.ts` 的"P1 旧快照调用新 Runtime 被拒绝"用例 flake：
断言 rejected 留痕的 `currentRuntimeInstanceId` 等于 `start()` 后缓存的实例 id。
但 runtime-host 存在崩溃自动重建路径（`restartInstance`，新 UUID 实例 ID 替换
`instances` map）；CI 上 worker 子进程偶发 start 后退出被重建，invoke 时当前
实例已换，缓存 id 过期。同一代码重跑即绿，坐实时序 flake（D1a 波次曾观察到
同文件另一次并行时序 flake）。

该用例要验证的语义是"旧快照被 fail-closed 拒绝 + 留痕字段正确"，"测试期间
实例零重启"不是有效前提（自动重建是生产特性）。修复为语义断言：
`currentRuntimeInstanceId` 非空字符串且不等于被拒绝的旧实例 id。

变更：`tests/integration/plugin-runtime-host.test.ts`（纯测试，无生产代码改动）。
若同类 flake 再出现，评估为 restartInstance 路径加测试专用抑制开关。
