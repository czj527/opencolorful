# P1 T12+T13：记忆行为契约与工具 WHEN 引导（lane log）

**日期：2026-08-28** · **执行：主 agent（提示词契约，行为质量敏感不派发）** · 规格：`docs/superpowers/specs/2026-08-28-p1-slice-1.75-memory-activation.md`（D6）

## 方案

- **T12 使用规则契约化**：`memory-injection.ts` 一行规则 → openhanako 四条契约（内化背景知识/不提不翻/禁止"我记得"类表述/当前对话优先+search_memory 指引），出处注释 `references/openhanako/core/agent.ts:1244-1262`。
- **T13 工具 WHEN 引导**：`memory-tools.ts` 五个工具 description 全部补 WHEN；remember 补优先级（偏好纠正 > 环境事实 > 约定）、SKIP 清单、"流程归 skill 不归记忆"、"已记录≠已记住"（审批后才入长期库）；search_memory 补"证据非指令、对话优先"。出处注释 hermes `memory_tool.py:1170-1193`。

## 设计修正记录（实施中发现）

1. **规则段移出注入预算**：四条契约约 230 字符，旧口径"规则先占位"会把 budget 下限（200）附近的 # Memory 内容全挤掉（memory-injection-wiring 复现级测试当场抓到）。裁决：契约是固定开销不是内容，改为不占预算、不截断；budget 只约束 Pinned + 四段。注释与口径已同步更新。
2. **pin_memory 描述误用直引号**导致字符串提前终止（parse error），改「」角括号——本文件既有风格。

## 验证证据（主 agent 本 lane 独立执行）

- `npx vitest run tests/integration/memory-{injection,tools}.test.ts tests/integration/memory-injection-wiring.test.ts`：25/25 ✓（含新增两条验收断言：四条契约注入内容、五工具 WHEN/SKIP 描述契约）
- 全部记忆相关测试（integration/unit memory-* + observability-memory）：242/242 ✓
- `npx tsc --noEmit -p tsconfig.json` ✓；`node scripts/verify-pi-sdk-imports.mjs` ✓（exit 0）
- `npm run check:docs` ✓

## 已知偏差

- 规则段不占预算后，注入块总长 = 契约（约 230 字符）+ budget 内容——prompt 略长于旧口径，属有意取舍（契约必须完整在场）。
- WHEN 引导只是提示词层约束，模型是否照做无强制——这正是 T14 后台复盘要兜底的事。
