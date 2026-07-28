import { type Static, Type } from "typebox";

// ═══════════════════════════════════════════════════════════════
// 四级访问模型
// ═══════════════════════════════════════════════════════════════

export const ACCESS_LEVELS = ["BLOCKED", "READ_ONLY", "READ_WRITE", "FULL"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_HIERARCHY: Record<AccessLevel, number> = {
  BLOCKED: 0,
  READ_ONLY: 1,
  READ_WRITE: 2,
  FULL: 3,
} as const;

export const FILE_OPERATIONS = ["read", "write", "delete", "exec"] as const;
export type FileOperation = (typeof FILE_OPERATIONS)[number];

/** 每个文件操作所需的最低访问级别 */
export const OPERATION_REQUIREMENTS: Record<FileOperation, AccessLevel> = {
  read: "READ_ONLY",
  write: "READ_WRITE",
  delete: "FULL",
  exec: "READ_WRITE",
} as const;

// ═══════════════════════════════════════════════════════════════
// 路径策略
// ═══════════════════════════════════════════════════════════════

/** 单条路径规则 */
export interface PathRule {
  /** 绝对路径或以 / 结尾的目录前缀（子树匹配） */
  readonly path: string;
  readonly level: AccessLevel;
  /** 拒绝时给 Agent 的理由 */
  readonly reason: string;
}

/** 完整的路径守卫策略 */
export interface PathGuardPolicy {
  readonly rules: readonly PathRule[];
  /** 未匹配任何规则时的兜底级别 */
  readonly defaultLevel: AccessLevel;
  /** 是否允许读取工作区外的文件 */
  readonly allowExternalReads: boolean;
}

/** PathGuard.check() 的返回值 */
export interface PathCheckResult {
  readonly allowed: boolean;
  readonly canonicalPath: string;
  readonly level: AccessLevel;
  readonly required: AccessLevel;
  readonly reason: string;
}

// ═══════════════════════════════════════════════════════════════
// Agent 沙箱能力声明
// ═══════════════════════════════════════════════════════════════

export const SandboxCapabilitiesSchema = Type.Object({
  /** Phase 9 固定 rw；后续可扩展为 "off" | "ro" | "rw" */
  workspaceAccess: Type.Literal("rw"),
  /** Agent 工作目录外、用户显式授权的可读路径 */
  extraReadPaths: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  /** 工作区内用户指定的受保护路径（BLOCKED 级别） */
  protectedPaths: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
});

export type SandboxCapabilities = Static<typeof SandboxCapabilitiesSchema>;

export function defaultSandboxCapabilities(): SandboxCapabilities {
  return {
    workspaceAccess: "rw",
    extraReadPaths: [],
    protectedPaths: [".env", "secrets/", "credentials/"],
  };
}

// ═══════════════════════════════════════════════════════════════
// 沙箱事件 Payload
// ═══════════════════════════════════════════════════════════════

export interface SandboxDeniedPayload {
  readonly operation: FileOperation;
  readonly path: string;
  readonly level: AccessLevel;
  readonly required: AccessLevel;
  readonly reason: string;
  readonly agentId: string;
}

export interface SandboxPreflightDeniedPayload {
  readonly command: string;
  readonly pattern: string;
  readonly agentId: string;
}
