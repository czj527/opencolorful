---
name: Hermes Notes
description: Hermes 风格演示 Skill：platforms 复数、prerequisites.commands、required_environment(_variables) 与 user-invocable 的 T9 转换。仅指令。
version: 1.3.0
license: MIT
platforms: [linux, windows, macos]
prerequisites:
  commands: [jq, git]
required_environment: python3
required_environment_variables:
  - name: HERMES_HOME
    prompt: Path to the Hermes home directory
    required_for: loading notes
user-invocable: false
metadata:
  hermes:
    tags: [notes, productivity]
    category: productivity
---

# Hermes Notes

本 Skill 模拟真实 Hermes Agent 技能包（NousResearch/hermes-agent 社区形态）：
T2 无法直接转换的字段由 T9 Hermes 适配器在 staging 副本上转换：

- `platforms`（复数）→ `platform`（T2 再做 os 名称映射：linux→linux、windows→win32、macos→darwin）；
- `prerequisites.commands: [jq, git]` → 并入 `prerequisites.bins`；
- `required_environment: python3` → 并入 `prerequisites.bins`；
- `required_environment_variables: [{name: HERMES_HOME}]` → 并入 `prerequisites.env`（只取变量名，不读取任何值）；
- `user-invocable: false` → `disable-model-invocation: true`（仅显式触发）。

## 工作流程

- readiness 门控：jq/git/python3 二进制与 HERMES_HOME 环境变量（仅诊断，不产生 Grant）。
- 正文仅作指令，不执行任何脚本；环境变量值由既有工具链读取。
