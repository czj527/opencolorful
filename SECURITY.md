# 安全政策

## 报告漏洞

请**不要**在公开 issue 中报告安全漏洞。请使用 GitHub 的
[Private vulnerability reporting](../../security/advisories/new)
提交细节，我们会在评估后尽快回复与修复。

## 范围说明

OpenColorful 是本地优先的平台基础设施，默认只监听 `127.0.0.1`。
以下属于当前已知的既定边界（见 AGENTS.md 与 docs/），不作为漏洞处理：

- LAN/远程访问与认证体系尚未实现，请勿将服务暴露到非本机地址；
- OS 级沙箱尚未实现（PathGuard 为应用层沙箱）；
- OAuth 与逐次工具审批仍在规划中。

涉及凭据泄露、沙箱逃逸、插件权限绕过、审计缺失等问题请务必报告。
