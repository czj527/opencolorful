# G2 发布验证：Provider compat 透传修复

日期：2026-09-09 ｜ 分支：release-v0.1.2（基于 v0.1.2 发布后 main）｜ 关联：G2 发布验证会话

## 背景与发现路径

G2 发布验证以真实用户身份走安装版完整流程时，首条消息始终失败。逐层定位：

1. v0.1.1 安装包落后 main 46 提交（首条消息修复未发布）→ 已切 v0.1.2 发布；
2. v0.1.2 安装版经本机 REST 面（与桌面 UI 同后端真链路）配置自定义 OpenAI 兼容
   Provider（免费中转站 api.b.ai/v1 + glm-5.3-flash），Provider/Key/默认主模型/
   助理/会话全部就绪，新会话模型自动绑定成功（v0.1.1 缺陷确已修复）；
3. 但模型调用返回 `400: 角色信息不正确`。curl 逐字段复测定位两个不兼容点：
   - `developer` 角色被站点拒绝（code 1214，只认 `system`）；
   - `reasoning_effort: "medium"` 被拒绝（该模型只接受 low/high/max）。
4. 根因：PI SDK `ProviderConfigInput.models[].compat` 支持站点兼容性覆盖（探针
   验证 `supportsDeveloperRole: false` + `supportsReasoningEffort: false` +
   `maxTokensField: "max_tokens"` 后同一端点真实回复成功），但平台 Provider 契约
   （`ProviderModelSetting`）没有该字段，注册链（`src/pi-sdk/model-runtime.ts`）
   也未透传——自定义 Provider 无从声明站点差异。

## 修复内容

- `src/contracts/provider-settings.ts`：`ProviderModelSetting` 增加可选 `compat`
  字段（白名单子集：supportsDeveloperRole / supportsReasoningEffort / supportsStore
  / supportsStrictMode / maxTokensField / thinkingFormat，additionalProperties:
  false 防任意字段注入 SDK），schema 与 interface 同步。
- `src/pi-sdk/types.ts`：`PiProviderDefinition.models[]` 增加 `compat`（新增
  `ProviderModelCompat` 导出类型，与契约同形）。
- `src/pi-sdk/model-runtime.ts`：注册 Provider 时把 `model.compat` 浅拷贝透传给
  `runtime.registerProvider`；未配置时完全不发该键，SDK 行为与原先一致。
- `tests/integration/provider-settings.test.ts`：新增 2 例——
  - compat 持久化 + 经 `ModelService.upsert`（含凭据）后 `resolveModel().model.compat`
    携带覆盖（fail-closed 凭据校验前的缺陷形态是 resolveModel 直接 UNAUTHORIZED）；
  - 白名单外字段/越界取值拒绝 + 无 compat 的既有配置向后兼容。
- `CHANGELOG.md`：Unreleased 记录用户可见修复。

## 验证

- `npx vitest run tests/integration/provider-settings.test.ts`：8/8 通过。
- 判别性实证：变异注册链（删除 compat 透传一行）后恰 1 例失败
  （persists model compat overrides…），还原后 8/8 全绿。
- 端到端探针（真实站点）：`supportsDeveloperRole/supportsReasoningEffort=false`
  的 compat 覆盖下，同一 SDK `streamSimple` 对 api.b.ai/v1 glm-5.3-flash 返回
  真实回复（含 23*7=161 正确计算），证明覆盖字段有效。
- `npm run check`：全绿后提 PR。

## 已知边界

- compat 白名单只覆盖 openai-completions 协议实测需要的开关；openai-responses /
  anthropic-messages 等协议的 compat 未开放（无真实站点驱动，避免拍脑袋设计）。
- 引导 UI（桌面端向导）暂无 compat 输入位；用户经设置页 Provider API（PUT
  /api/settings/providers）配置。UI 输入位留待真实需求出现后设计。
