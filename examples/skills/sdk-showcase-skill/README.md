# SDK Showcase Skill（官方示例）

OpenColorful Phase 13 的官方纯 instruction-only Skill 示例，覆盖：

- 标准 frontmatter（name / description / version / license / metadata.opencolorful）；
- `references/` 与 `templates/` 按需读取（不一次性注入正文）；
- `metadata.opencolorful.requires` 门控（os / bins → readiness 诊断，不创建 Grant）；
- 一个安全、无需付费 Provider / API Key 的工作流：本地仓库健康度检查；
- 不以 Browser Use 为示例（浏览器能力未来由 Electron Core Browser 或 Plugin 提供）。

## 快速验证

```bash
node scripts/verify-skill-package.mjs examples/skills/sdk-showcase-skill

# 或使用 CLI（需先构建或 tsx）
npx tsx src/cli/main.ts skills validate examples/skills/sdk-showcase-skill
npx tsx src/cli/main.ts skills pack examples/skills/sdk-showcase-skill --out /tmp/sdk-showcase.skill
```

## 结构

```text
sdk-showcase-skill/
├─ SKILL.md                  # 必需：frontmatter + Markdown instructions
├─ references/checklist.md   # 可选：按需读取的详细资料
└─ templates/report.md       # 可选：输出骨架
```

本 Skill 不包含 `scripts/`、`assets/` 或任何二进制文件；安装器绝不会执行
来源脚本，脚本类工作必须通过既有的 Sandbox/工具入口。
