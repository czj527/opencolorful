import { CAPABILITY_KINDS, type CapabilityKind } from "../../../contracts/plugin-protocol.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 能力族目录与平台默认策略（plans/phase-12.md §十）
//
// 16 个能力族（T1 冻结枚举，见 plugin-protocol/permission.ts）。
// 平台默认策略决定"哪种能力需要用户显式确认 / 仅 full-access 才可授予"：
// - high-risk：secret.read-own / process.spawn / network.connect /
//   filesystem.write —— 必须用户显式确认（或 full-access 审核通过）才可授予；
// - user-grantable：其余能力 —— 用户可授权，仍须经过 grant/binding 交集。
//
// 插件不能自行决定是否需要用户确认，风险策略由本目录统一判定
// （§8.1 "插件不能自行决定是否需要用户确认；风险策略由平台目录和
// Manifest 共同决定"）。
// ═══════════════════════════════════════════════════════════════

export type CapabilityDefaultPolicy = "high-risk" | "user-grantable";

/** 能力对应的 Phase 9 沙箱/平台边界层 */
export type CapabilitySandboxLayer = "filesystem" | "network" | "process" | "secret" | "host";

export interface CapabilityDefinition {
  readonly capability: CapabilityKind;
  /** 中文显示名（Web 权限页用） */
  readonly name: string;
  /** 中文说明（权限确认页用） */
  readonly description: string;
  readonly defaultPolicy: CapabilityDefaultPolicy;
  readonly sandboxLayer: CapabilitySandboxLayer;
}

/** 高风险能力族：必须用户显式确认（或 full-access 审核通过）才可授予 */
export const HIGH_RISK_CAPABILITIES: readonly CapabilityKind[] = [
  "secret.read-own",
  "process.spawn",
  "network.connect",
  "filesystem.write",
] as const;

const DEFINITIONS: readonly CapabilityDefinition[] = [
  {
    capability: "filesystem.read",
    name: "文件读取",
    description: "读取文件系统（受 Phase 9 PathGuard 约束）",
    defaultPolicy: "user-grantable",
    sandboxLayer: "filesystem",
  },
  {
    capability: "filesystem.write",
    name: "文件写入",
    description: "写入/删除文件与执行脚本（高风险，受 PathGuard 约束）",
    defaultPolicy: "high-risk",
    sandboxLayer: "filesystem",
  },
  {
    capability: "network.connect",
    name: "网络连接",
    description: "发起网络连接（高风险）",
    defaultPolicy: "high-risk",
    sandboxLayer: "network",
  },
  {
    capability: "process.spawn",
    name: "进程启动",
    description: "启动子进程（高风险，需用户确认）",
    defaultPolicy: "high-risk",
    sandboxLayer: "process",
  },
  {
    capability: "secret.read-own",
    name: "读取自有密钥",
    description: "读取插件自身声明的 Secret（高风险，需用户确认）",
    defaultPolicy: "high-risk",
    sandboxLayer: "secret",
  },
  {
    capability: "provider.register",
    name: "Provider 注册",
    description: "注册可替换的模型/搜索/存储 Provider",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "tool.register",
    name: "工具注册",
    description: "注册 Agent 可见工具",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "route.register",
    name: "路由注册",
    description: "注册 /api/plugins/:pluginId/* namespaced 路由",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "ui.surface",
    name: "UI 表面",
    description: "提供 Page/Widget/Chat Surface 界面",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "ui.host.external-open",
    name: "外部链接打开",
    description: "通过宿主打开外部链接",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "ui.host.clipboard",
    name: "剪贴板",
    description: "访问宿主剪贴板",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "resource.open",
    name: "打开资源",
    description: "打开平台资源",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "resource.pick",
    name: "资源选择",
    description: "请求用户选择资源",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "background.run",
    name: "后台运行",
    description: "注册后台任务",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "hook.register",
    name: "Hook 注册",
    description: "在平台冻结时点注册 Hook",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
  {
    capability: "activity.emit",
    name: "自定义事件",
    description: "按注册 namespace 发出自定义 Activity",
    defaultPolicy: "user-grantable",
    sandboxLayer: "host",
  },
];

const catalogMap = new Map<CapabilityKind, CapabilityDefinition>(
  DEFINITIONS.map((definition) => [definition.capability, definition] as const),
);

const highRiskSet = new Set<CapabilityKind>(HIGH_RISK_CAPABILITIES);

/** 能力族目录（16 项完整覆盖协议枚举） */
export const CAPABILITY_CATALOG: ReadonlyMap<CapabilityKind, CapabilityDefinition> = catalogMap;

export function isHighRisk(capability: CapabilityKind): boolean {
  return highRiskSet.has(capability);
}

/** 高风险别名：需要用户显式确认（或 full-access 审核通过） */
export function requiresUserConfirmation(capability: CapabilityKind): boolean {
  return isHighRisk(capability);
}

export function getCapabilityDefinition(capability: string): CapabilityDefinition | undefined {
  return catalogMap.get(capability as CapabilityKind);
}

export function isKnownCapability(value: string): value is CapabilityKind {
  return (CAPABILITY_KINDS as readonly string[]).includes(value);
}

export function listCapabilities(): readonly CapabilityDefinition[] {
  return DEFINITIONS;
}
