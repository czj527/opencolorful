# Phase 13 T9 生态兼容 Fixture（tests/fixtures/skills/）

固定版本本地 fixture，进入默认 CI（`npm test` / `npx vitest run`），**不请求外网、
不依赖个人凭据、不依赖远程市场可用性**。规则与 Phase 12 生态 fixture 一致：
禁止运行时访问真实 ClawHub / Hermes 仓库。

## 生态包格式定义（T9 文档化）

T9 为 OpenClaw 与 Hermes 两个生态定义了统一的「本地固定版本镜像」布局
（`src/runtime/skills/sources/ecosystem-mirror.ts`）：

```text
mirrorDir/<skillId>@<version>/SKILL.md
```

- `skillId` 非空、不含 `@` 与空白；`version` 精确锁定（不支持 `latest`）；
- sourceRef 规范形式：`openclaw:<skillId>@<version>`、`hermes:<skillId>@<version>`；
- 镜像 = ClawHub/Hermes 市场下载固化目录或自建 fixture；适配器只读镜像，
  复制进受控 staging 后校验（绝不执行任何来源脚本/postinstall）。

### OpenClaw / ClawHub Skill 格式

ClawHub（clawhub.ai）是 OpenClaw 的公开文本型 Skill 注册表（SKILL.md + 支持文件，
带版本与锁定语义；官方 `skills-lock.json` 即 `{source, skillPath, computedHash}`
锁定模式）。T9 定义的 OpenClaw Skill 包：

- 完整包 = 目录含 `SKILL.md`（Agent Skills 风格 frontmatter）；
- OpenClaw 专属元数据在 `metadata.openclaw`：
  - `requires: {os, bins, env, tools, capabilities, network}`（T2 转换到
    `opencolorful.requires`；os 名称映射 windows→win32 / macos→darwin / linux→linux）；
  - `network: true` **只记录降级提示**（“仅作风险展示，不授予网络权限”），
    绝不授权网络访问；
  - `icon` / `tips` / `description` 允许保留（T2 消费键）；
  - 顶层 `disable-model-invocation: true`（OpenClaw 语义，仅显式触发）；
- 兼容失败（unsupported / metadata-only / 需要人工迁移）由适配器给出**迁移建议**
  并拒绝安装，不生成表面成功但运行时空壳的 Skill。

### Hermes Skill 格式

Hermes Agent（NousResearch/hermes-agent）以 `skills/<category>/<name>/SKILL.md`
分发技能包。T2 已转换 `platform` / `prerequisites{os,bins,env}` / `requires`；
T9 Hermes 适配器（`src/runtime/skills/compat/hermes-skill-rewrite.ts`）在
**staging 副本**上补全真实 Hermes 字段（镜像/原包保持原样、哈希可复核）：

| 真实 Hermes 字段 | T9 转换 |
| --- | --- |
| `platforms: [linux, windows]`（复数） | → `platform`（T2 再做 os 名称映射） |
| `prerequisites: {commands: [memo]}` | commands 并入 `prerequisites.bins` |
| `required_environment: python3` | 并入 `prerequisites.bins` |
| `required_environment_variables: [{name: TOKEN, ...}]` | 只取变量名并入 `prerequisites.env`（不读取任何值） |
| `user-invocable: false` | → `disable-model-invocation: true`（语义相反，仅显式触发） |

渐进披露语义映射：适配器 `discover` ↔ Hermes `skills_list`（候选元数据），
`inspect` ↔ `skill_view`（provenance + 完整 Manifest + 兼容报告 + 风险摘要；
正文经 `SkillContentService` 按需读取，不一次性注入）。

### Claude / Codex / PI 目录结构

- `.claude/skills/<name>/SKILL.md`（Claude Code / Agent Skills 约定）；
- `.codex/skills/<name>/SKILL.md`（OpenAI Codex 约定）；
- 无生态标记的标准 frontmatter → `pi-compatible` 等级，直接兼容。

## Fixture 清单

| 路径 | 用途 |
| --- | --- |
| `registry-openclaw/hello-openclaw@1.0.0/` | OpenClaw requires 转换（os 映射 / bins / env / tools / capabilities / network）+ disable-model-invocation；可安装 |
| `registry-openclaw/network-heavy@0.9.0/` | `network: true` 降级提示（不授权网络）；可安装 |
| `registry-openclaw/broken-unsupported@0.1.0/` | `metadata.opencolorful.version: 2` → unsupported；迁移建议拒绝 |
| `registry-openclaw/hollow-metadata-only@0.1.0/` | 正文为空 → metadata-only；迁移建议拒绝 |
| `registry-hermes/hermes-notes@1.3.0/` | 真实 Hermes 形态全集（platforms / commands / required_environment / required_environment_variables 块列表 / user-invocable）；T9 重写后安装 |
| `openclaw-fmt/` | 单包 OpenClaw 风格（kind=local 安装流） |
| `hermes-fmt/` | 单包 Hermes 基础形态（T2 直接转换；kind=local 安装流） |
| `pi-standard/` | 标准 Agent Skills（pi-compatible） |
| `claude-dotdir/.claude/skills/claude-helper/` | Claude 目录结构 |
| `codex-dotdir/.codex/skills/codex-helper/` | Codex 目录结构 |
| `risky-scripts/` | 含 `scripts/`：显著风险标记（不阻断安装，绝不执行来源脚本） |
| `binary-pkg/` | 含 `tools/helper.exe`：`skill_binary_denied` 拒绝路径 |
| `compat-failure/` | `metadata.opencolorful.version: 99` → unsupported（迁移建议） |

## 接线说明（组合根合并项，见 T9 报告）

`SkillStager`（T3）当前仍将 `openclaw`/`hermes` kind 判为未实现
（`skill_source_unsupported`），因此默认 CI 通过 `kind=local` 覆盖生态格式包的
完整安装流水线；适配器本身的 discover/inspect/stage 用直接调用测试。组合根合并时：

1. `createStandardAdapters` 增加
   `new OpenClawSkillSource({ registryDir })` 与 `new HermesSkillSource({ registryDir })`
   （factory 选项需增加 registryDir 注入）；
2. `SkillStager` 的 `REMOTE_UNSUPPORTED` 移除 `openclaw`/`hermes`，让 kind
   路由到适配器。
