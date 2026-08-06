# Phase 13 T9 可选 Live 测试（tests/skills-live/）

真实生态包测试：`npm run test:skills-live`（vitest.live.config.ts）。

- **默认 `npm test` 不跑 live**：默认 include 是 `tests/**/*.test.ts`，
  本目录文件后缀为 `.live.ts`，且默认配置未注入 `OPENCOLORFUL_LIVE`，
  双重保险下不会发起任何网络请求；
- Live 测试失败**只标记兼容性/网络诊断**（输出诊断、跳过），不污染默认质量门；
  唯一硬性红线是 **verified 条目的锁定哈希不匹配**（安全红线，必须失败）；
- 使用临时目录（镜像 + staging），结束后清理；不依赖个人凭据/付费 API。

## 真实包选择（1-2 个候选源）

| 候选源 | 说明 | 状态 |
| --- | --- | --- |
| NousResearch/hermes-agent（官方 Hermes Agent 仓库，MIT） | 内置技能全部 instruction-only；选取 `skills/creative/humanizer`（647 行纯指令 + LICENSE，platforms 复数形态，Windows 可用） | ✅ 已锁定验证 |
| openclaw/carapace（ClawHub 官方 `skills-lock.json` 索引的技能包，MIT） | 选取 `openclaw-brand`（SKILL.md + references/，纯指令）；ClawHub 自身即用 `{source, skillPath, computedHash}` 锁定 | ✅ 已锁定验证 |
| ZeroPointRepo/youtube-skills（社区 Hermes 技能，MIT） | `transcript` 展示真实"块序列映射项"形态（required_environment_variables 列表）；运行时需外部 API Key（免费档） | ⚠️ 候选示例（未验证） |

选择标准（§18.7）：instruction-only（无 scripts/二进制）、无付费 API、
许可证允许（MIT）、Windows 可用。

## 锁定策略

`LOCKFILE.json` 每条目锁定：

1. **版本**：`pinnedCommit`（Git 提交 SHA，不可变；Hermes 内置技能另有 frontmatter
   version）；镜像条目目录为 `<id>@<version>/`；
2. **内容哈希**：`packageHash` = sha256（按排序 relpath + `\0` + 文件字节 拼接），
   下载后必须一致；ClawHub 官方 `skills-lock.json` 即同模式（computedHash）；
3. **文件清单**：`files` 明确列出下载路径（raw.githubusercontent 逐文件拉取）。

### 验证一个新候选（verified=false → true）

```bash
# 1) 固定上游提交并检出（GitHub raw 用 commit SHA 而非 main）
git ls-remote https://github.com/<owner>/<repo>.git refs/heads/main   # 记录 SHA

# 2) 下载包内文件到临时镜像目录 mirror/<id>@<version>/（剥离 packagePrefix）
#    ⚠️ 哈希必须以"下载得到的字节"计算（raw.githubusercontent 为规范字节；
#    Windows git 检出可能做 CRLF 转换，本地检出的哈希不可作为 pin）

# 3) 计算 packageHash（与 live-skills.live.ts 的 computePackageHash 同算法：
#    按排序条目相对路径 + '\0' + 字节 拼接后 sha256）
# 4) 回填 LOCKFILE.json（pinnedCommit / downloadBase / packagePrefix /
#    files / packageHash / verified: true）
# 5) npm run test:skills-live
```

网络不可达时 live 测试输出诊断并跳过；哈希不匹配（verified 条目）视为内容
被篡改或 pin 失效，测试失败——此时**不要**静默改哈希，先核对 pinnedCommit
与下载字节（CRLF/LFS 是常见误因）。
