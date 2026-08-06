# Skill 开发指南（Phase 13）

> Skill 是 OpenColorful 的"做事方法"载体：可安装、可组合、按需加载。
> Skill 决定 Agent 怎样做事；Plugin/Tool 决定 Agent 能调用什么；记忆决定
> Agent 经历过什么；底色决定 Agent 是谁。

## 1. 快速开始

```bash
# 1) 生成标准目录 + 最小 SKILL.md
ocf skills init my-skill

# 2) 校验包结构 / frontmatter / 内容哈希（纯本地）
ocf skills validate my-skill

# 3) 以 Linked Source 接入（只读引用，不复制到 Managed Store）
ocf skills link my-skill
#    修改文件后下一 turn 重新哈希生效（Linked Source 状态每次读取实时重算）

# 4) 查看来源/哈希/readiness/shadowed/Agent 绑定诊断
ocf skills doctor

# 5) 生成可分发的 .skill（ZIP）包
ocf skills pack my-skill --out dist/my-skill.skill

# 6) 质量门（独立 Node 脚本，不依赖编译产物）
node scripts/verify-skill-package.mjs examples/skills/sdk-showcase-skill
```

## 2. CLI 命令表

| 命令 | 说明 | 事实来源 |
| --- | --- | --- |
| `skills list` | 已安装/可见 Skill（含状态四元组） | Server /api/skills |
| `skills search <query>` | 跨层搜索（bound→managed→workspace→plugin→remote） | Server /api/skills/search |
| `skills inspect <source-ref> [--kind …]` | 来源检查（版本/哈希/风险/兼容性） | Server /api/skills/inspect |
| `skills install <source-ref> [--agent <id>] [--session <id>] [--yes]` | 安装；高风险默认显式确认（一次性令牌） | Server /api/skills/install + confirmation/approve |
| `skills validate <path>` | 包结构/完整性/哈希校验 | 本地复用 T2 validator |
| `skills pack <path> [--out <file>]` | 生成 .skill ZIP + 输出内容哈希 | 本地（T8 pack/zip-builder） |
| `skills init <name>` | 生成标准目录 + 最小 SKILL.md | 本地 |
| `skills link <path>` | 登记 Linked Source（只读引用，不复制） | 本地（skill-dev-sources/sources.json） |
| `skills unlink <source-id>` | 注销 Linked Source | 本地 |
| `skills doctor` | 本地来源/哈希/Linked + Server Catalog/绑定诊断 | 本地 + Server |
| `skills bundle create\|version\|inspect` | Bundle 版本化管理 | Server /api/skills/bundles |

**单一事实承诺**：安装/绑定/搜索/检查/版本化全部经 Server HTTP 路由，与会话内
`search_skills` / `inspect_skill` / `install_skill` / `manage_skills` /
`manage_skill_bundle` 工具共用同一 `SkillCoreService`。CLI 不实现第二套校验
或安装逻辑；`validate/pack/init/link/unlink` 是纯文件操作，直接复用
T2 的 validator/hash。

## 3. 包格式

```text
skill/
├─ SKILL.md                    # 必需：YAML frontmatter + Markdown instructions
├─ references/                 # 可选：按需读取的详细资料
├─ scripts/                    # 可选：只能通过既有 Sandbox 执行（安装器绝不运行）
├─ templates/                  # 可选：模板和输出骨架
├─ assets/                     # 可选：只读资源
└─ agents/openai.yaml         # 可选：兼容 Codex/OpenAI 元数据
```

标准 frontmatter 常用字段：`name`、`description`、`version`、`license`、
`compatibility`、`allowed-tools`、`disable-model-invocation`。

平台扩展只能放在 `metadata.opencolorful`：

```yaml
metadata:
  opencolorful:
    version: 1
    requires:
      plugins: []
      tools: []
      capabilities: []
      bins: [git]
      env: []
      os: [win32, darwin, linux]
    recommends:
      skills: []
      plugins: []
    risk: low
```

`requires` 只生成 readiness 诊断与风险展示，**不创建任何 Grant**。

## 4. 生态兼容等级

| 等级 | 含义 |
| --- | --- |
| `native` | 原生 Agent Skills，完整支持 |
| `pi-compatible` | PI/Agent Skills，可直接交给原生 loader |
| `openclaw` | OpenClaw Skill，已转换 gating/来源信息 |
| `hermes` | Hermes Skill，已转换渐进披露/环境门控 |
| `metadata-only` | 仅能展示元数据，正文或结构不兼容 |
| `unsupported` | 拒绝安装并说明原因 |

兼容性报告必须显示缺失字段、降级行为与是否需要手工迁移；不承诺外部
生态包的 100% 二进制行为兼容。

## 5. 与 Plugin 的边界

- **Skill 不授予权限**：Skill 不能请求工具、插件、文件、网络、Secret 或
  Provider 权限；`allowed-tools` / `requires` 只是依赖提示。
- Skill 只描述做事方法；脚本必须通过既有 Sandbox/工具入口执行。
- 含 `scripts/` 的 Skill 显示显著风险提示；含二进制的 Skill 默认拒绝安装
  （建议转换为 Plugin）。
- 插件携带的 Skill Bundle 进入同一 Catalog/Snapshot/日志链路（T7）。
- 安装器不执行来源脚本、postinstall 或依赖安装器；"安装 ≠ 启用 ≠ 绑定"。

## 6. 已知限制（Phase 13）

- 远程来源搜索/安装（Git/HTTP/市场适配器）由 T9 接线；当前 `remote` 层
  返回明确诊断，搜索缺 Skill 不会递归触发安装。
- Linked Source 的 Catalog 扫描接线在组合根（T10）完成；CLI 只负责登记/
  注销，Web 开发态只读展示状态。`skills link` 后如需在 Catalog 中解析，
  需等待 Server 组合根把 Linked Source 根目录纳入 externalDirs 扫描。
- 学习策略变更走 UI 内确认流程（§14.4）；停用/解绑/迁移使用一次性确认令牌。
- 内容注入预算（T5 冻结）：Snapshot ≤32 个 Skill、元数据 ≤4000 字符、
  单文件 ≤256KB、每轮支持文件 ≤512KB。
- 官方示例见 `examples/skills/sdk-showcase-skill`（纯 instruction-only，
  无付费 Provider/API Key；不以 Browser Use 为示例）。
