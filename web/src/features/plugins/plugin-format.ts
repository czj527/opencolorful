import type {
  CompatibilityItemStatus,
  ContributionKind,
  PluginCapabilityKind,
  PluginHealth,
  PluginRuntimeKind,
  PluginSourceType,
  PluginStatus,
  PluginTrust,
} from "../../lib/plugin-types.js";

// ── 状态与类别的中文标签与徽标语义 ──────────────────────────────

export const PLUGIN_STATUS_LABEL: Record<PluginStatus, string> = {
  discovered: "已发现",
  staged: "已暂存",
  installed: "已安装",
  enabled: "已启用",
  degraded: "降级",
  disabled: "已禁用",
  failed: "失败",
  removed: "已卸载",
};

export const PLUGIN_STATUS_TONE: Record<PluginStatus, "ok" | "warn" | "danger" | "muted"> = {
  discovered: "muted",
  staged: "muted",
  installed: "muted",
  enabled: "ok",
  degraded: "warn",
  disabled: "muted",
  failed: "danger",
  removed: "muted",
};

export const PLUGIN_HEALTH_LABEL: Record<PluginHealth, string> = {
  unknown: "未知",
  ok: "健康",
  degraded: "降级",
  error: "异常",
};

export const PLUGIN_HEALTH_TONE: Record<PluginHealth, "ok" | "warn" | "danger" | "muted"> = {
  unknown: "muted",
  ok: "ok",
  degraded: "warn",
  error: "danger",
};

export const PLUGIN_TRUST_LABEL: Record<PluginTrust, string> = {
  restricted: "受限",
  "full-access": "完全访问（高危）",
};

export const PLUGIN_RUNTIME_LABEL: Record<PluginRuntimeKind, string> = {
  bundle: "Bundle（声明式）",
  mcp: "MCP",
  "node-process": "Node 进程",
  "python-process": "Python 进程",
};

export const PLUGIN_SOURCE_LABEL: Record<PluginSourceType, string> = {
  local: "本地目录",
  zip: "ZIP",
  git: "Git 仓库",
  npm: "npm 包",
  openclaw: "OpenClaw 市场",
  hermes: "Hermes 仓库",
  mcp: "MCP 配置",
};

export const COMPATIBILITY_ITEM_LABEL: Record<CompatibilityItemStatus, string> = {
  supported: "支持",
  unsupported: "不支持",
  degraded: "降级",
  blocked: "阻断",
};

/** 不兼容项三色状态：unsupported 中性、degraded 黄、blocked 红 */
export const COMPATIBILITY_ITEM_TONE: Record<CompatibilityItemStatus, "ok" | "warn" | "danger" | "muted"> = {
  supported: "ok",
  unsupported: "muted",
  degraded: "warn",
  blocked: "danger",
};

export const CONTRIBUTION_KIND_LABEL: Record<ContributionKind, string> = {
  tool: "工具",
  command: "命令",
  provider: "Provider",
  route: "路由",
  page: "页面",
  widget: "组件",
  "chat-surface": "聊天 Surface",
  background: "后台任务",
  hook: "Hook",
  config: "配置",
  secret: "Secret",
  "context-attachment": "上下文附件",
  "custom-activity": "自定义活动",
  "skill-bundle": "技能登记",
};

export const CAPABILITY_LABEL: Record<PluginCapabilityKind, string> = {
  "filesystem.read": "读取文件系统",
  "filesystem.write": "写入文件系统",
  "network.connect": "建立网络连接",
  "process.spawn": "启动子进程",
  "secret.read-own": "读取自身 Secret",
  "provider.register": "注册 Provider",
  "tool.register": "注册工具",
  "route.register": "注册路由",
  "ui.surface": "承载 UI Surface",
  "ui.host.external-open": "打开外部链接",
  "ui.host.clipboard": "访问剪贴板",
  "resource.open": "打开资源",
  "resource.pick": "选择资源",
  "background.run": "后台运行",
  "hook.register": "注册 Hook",
  "activity.emit": "提交活动事件",
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABEL[capability as PluginCapabilityKind] ?? capability;
}

export function contributionKindLabel(kind: string): string {
  return CONTRIBUTION_KIND_LABEL[kind as ContributionKind] ?? kind;
}
