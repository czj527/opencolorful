## 改动说明

## 动机与关联 issue

## 变更影响

- [ ] Runtime / 跨进程契约
- [ ] 持久化 / Migration / 恢复
- [ ] Agent / Plugin / Skill / Subagent 行为
- [ ] Web / Desktop 用户界面
- [ ] 安全 / 权限 / 凭据 / 审计
- [ ] 构建 / 依赖 / 生成物 / CI
- [ ] 以上均不涉及（测试、文档或纯机械变更）

## 文档收口

- [ ] 已更新对应的 Phase Plan、Feature Spec、架构文档、ADR 或 Agent Note
- [ ] 用户可见变化已更新 `CHANGELOG.md`
- [ ] 本次是明确的纯重构/机械变更，使用下方例外说明

docs-exempt:

## 验证证据

- [ ] `npm run check` 全过（逐条命令单独确认退出码）
- [ ] 新增/更新了覆盖改动的测试
- [ ] 未引入凭据、密钥或本地隐私路径

## 备注
