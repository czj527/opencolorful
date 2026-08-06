---
name: SDK Showcase Skill
description: 演示 Skill 1.0 标准包：标准 frontmatter、references/templates 按需读取与 metadata.opencolorful 门控。提供一个无需付费 Provider 或 API Key 的安全工作流（本地仓库健康度检查）。
version: 1.0.0
license: MIT
metadata:
  opencolorful:
    version: 1
    requires:
      os: [win32, darwin, linux]
      bins: [git]
    recommends:
      skills: []
      plugins: []
    risk: low
---

# SDK Showcase Skill

本 Skill 演示 OpenColorful Skill 1.0 的标准包结构，不依赖任何付费 Provider、
API Key、外部网络或 Browser Use。它只描述「怎么做」，不授予任何工具、文件、
网络或 Secret 权限；所有命令都必须由 Agent 通过既有的 Sandbox/工具入口执行。

## 用途

对当前工作区的 Git 仓库做一次「本地健康度检查」并生成一份简短报告。全部检查
都在本地完成：git 状态、未提交改动、过大文件提示与模板输出。

## 工作流程

1. **确认上下文**：读取 `references/checklist.md` 中的检查清单（按需读取，
   不一次性注入全部正文）。
2. **逐项检查**（每项都使用既有 Sandbox 工具执行，禁止直接执行本 Skill 内
   的任何脚本）：
   - `git status --porcelain`：是否有未提交改动；
   - `git log -1 --format=%h`：当前提交；
   - 是否存在体积明显过大的文件（本 Skill 只给出检查方法，不读取文件内容）。
3. **生成报告**：按 `templates/report.md` 的骨架输出；缺失信息标为「未检查」，
   不得编造结果。
4. **不越权**：如果检查需要网络、凭据或写入仓库，明确告诉用户这超出本
   Skill 的能力范围，并建议对应的既有工具。

## 门控说明

`metadata.opencolorful.requires` 只用于 readiness 诊断（本 Skill 需要 git
二进制，且面向 win32/darwin/linux）；它不会创建任何 Grant。缺少 git 时
readiness 为 degraded，Agent 仍可读取本文但不应声称检查已执行。

## 边界

- 不执行本目录 `scripts/` 下的任何内容（本 Skill 也不包含 scripts/）；
- 不读取 `assets/` 之外的资源；`references/` 与 `templates/` 仅在明确需要时读取；
- 不发起网络请求、不读写 Secret、不修改仓库内容。
