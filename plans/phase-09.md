# Phase 9：沙箱系统 — 应用层 PathGuard + 能力声明

**状态：已验收（2026-07-30）** | 分支：`main`
**基线：** `main`（Phase 8.5 验收点，`cb2bb84`）
**参考：** openhanako PathGuard 四级模型 + 工具 wrapper；openclaw SandboxFsBridge + 三层策略分离；hermes-agent BaseEnvironment 接口抽象；各项目调研汇总见 `plans/phase-09-research.md`（待整理）

---

## 一、目标

为 OpenColorful 建立三层沙箱系统的**应用层地基**，让 Agent 的所有文件操作首次受到边界约束：

1. **PathGuard 四级访问控制**：`BLOCKED` → `READ_ONLY` → `READ_WRITE` → `FULL`，对每个文件路径做精确的操作级判断
2. **双层拦截**：工具 wrapper 层做精确检查 + 适配层做兜底守卫 + bash preflight 危险模式拦截
3. **per-Agent 能力声明**：扩展 `settings.json`，Agent 声明自己能做什么，平台据此生成 PathGuard 策略
4. **OS 沙箱后端接口**：定义 `SandboxBackend` 抽象，Phase 9 仅实现 `LocalBackend`，预留 Docker/Win32 注册机制

### 用户可感知的变化

- 创建/编辑 Agent 时可以配置工作区访问权限和受保护路径
- Agent 越权读取/写入文件时收到精确的拒绝原因（"`auth.json` 在 BLOCKED 区域"）
- 危险 bash 命令（`sudo`、`chmod 777`、`reg delete`）在执行前被拦截
- 所有安全拒绝事件记录到结构化日志

---

## 二、能力确认

### 2.1 已有基础设施

| 能力 | 位置 | 现状 |
|------|------|------|
| 工具三级权限（off/read-only/all） | `src/contracts/session-settings.ts:4` | `ToolMode` 类型 + `parseSessionSettings()` 校验 |
| 工具分类（READ_ONLY_TOOLS / ALL_TOOLS） | `src/contracts/session-settings.ts:46-52` | 静态数组，read/grep/find/ls vs +write/edit/bash |
| ToolPolicy 类 | `src/runtime/tool-policy.ts:7` | 当前只校验 cwd 存在性和路径安全性（无 `..`） |
| Agent 运行设置 | `src/contracts/agent-settings.ts` | `AgentSettingsSchema`，只有 `defaultCwd` + `updatedAt` |
| 偏好管理 | `src/config/preferences-store.ts` | 原子写入 + 归一化降级，可复用模式 |
| PI 适配层 | `src/pi-sdk/agent-session.ts` | 工具注册入口，可加拦截 |
| 结构化事件 | `src/contracts/events.ts` | `PlatformEventEnvelope`，可新增 `sandbox.denied` 事件 |

### 2.2 当前缺口

- **无文件路径访问控制**：PI 工具（read/write/edit/bash）直接操作 cwd 内任意路径，cwd 外也能通过 `..` 穿越
- **无 bash 命令审查**：`bash` 工具可执行任意命令，无 preflight 检查
- **无 per-Agent 能力差异**：所有 Agent 享有相同工具权限，无法按 Agent 限制文件访问范围
- **无安全事件审计**：拒绝访问的情况无结构化日志
- **无敏感路径防护**：`auth.json`、`.env`、`.ssh` 等敏感文件无硬性保护

---

## 三、PathGuard 设计

### 3.1 四级访问模型

```ts
// src/contracts/sandbox.ts（新文件）

export const ACCESS_LEVELS = ["BLOCKED", "READ_ONLY", "READ_WRITE", "FULL"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_HIERARCHY: Record<AccessLevel, number> = {
  BLOCKED: 0,
  READ_ONLY: 1,
  READ_WRITE: 2,
  FULL: 3,
};

export const FILE_OPERATIONS = ["read", "write", "delete", "exec"] as const;
export type FileOperation = (typeof FILE_OPERATIONS)[number];

// 每个操作所需的最低访问级别
export const OPERATION_REQUIREMENTS: Record<FileOperation, AccessLevel> = {
  read: "READ_ONLY",
  write: "READ_WRITE",
  delete: "FULL",
  exec: "READ_WRITE",
};
```

### 3.2 路径策略定义

```ts
export interface PathRule {
  readonly path: string;           // 绝对路径或前缀（目录以 / 结尾表示子树）
  readonly level: AccessLevel;
  readonly reason: string;         // 拒绝时给 Agent 的理由
}

export interface PathGuardPolicy {
  readonly rules: readonly PathRule[];
  readonly defaultLevel: AccessLevel;  // 未匹配任何规则时的兜底
  readonly allowExternalReads: boolean; // 是否允许读工作区外的文件
}
```

**策略生成逻辑**（`src/sandbox/policy.ts`）：

```
输入: Agent settings.json 中的 capabilities
输出: PathGuardPolicy

推导规则（按优先级从高到低）:
  1. 绝对 BLOCKED 清单         → ~/.ssh, ~/.aws, ~/.opencolorful/auth, /etc/shadow, .env 文件
  2. Agent protectedPaths       → 工作区内用户指定的受保护路径 → BLOCKED
  3. Agent extraReadPaths       → 用户显式授权的外部可读路径 → READ_ONLY
  4. Agent 工作目录 (defaultCwd) → FULL
  5. Agent 自身数据目录          → sessions/ READ_WRITE，其余 READ_ONLY
  6. opencolorful config/       → READ_ONLY
  7. 兜底                       → allowExternalReads ? READ_ONLY : BLOCKED
```

### 3.3 PathGuard 核心类

```ts
// src/sandbox/path-guard.ts（新文件）

export interface PathCheckResult {
  allowed: boolean;
  canonicalPath: string;
  level: AccessLevel;
  required: AccessLevel;
  reason: string;
}

export class PathGuard {
  constructor(private readonly policy: PathGuardPolicy) {}

  /**
   * 检查单个路径是否允许指定操作。
   * 先解析符号链接得到 canonicalPath，再匹配规则。
   * 不存在的路径向上遍历到最近存在的祖先后匹配。
   */
  check(operation: FileOperation, targetPath: string): PathCheckResult;

  /**
   * 批量检查。用于 bash 命令中的多路径提取场景。
   * 只要有一条拒绝就整体拒绝。
   */
  checkAll(operation: FileOperation, paths: string[]): PathCheckResult;
}
```

### 3.4 双层拦截架构

```
┌─────────────────────────────────────────────────────────────┐
│ 第一层：工具 wrapper（精确）                                   │
│ 每个文件类工具调用前，根据操作类型调用 PathGuard.check()        │
│ ├─ read 工具: check("read", filePath)                        │
│ ├─ write 工具: check("write", filePath)                      │
│ ├─ edit 工具: check("write", filePath)                       │
│ └─ bash 工具: preflight 正则 + 从命令中提取文件路径逐个check    │
├─────────────────────────────────────────────────────────────┤
│ 第二层：PI SDK 适配层（兜底）                                  │
│ 在 src/pi-sdk/agent-session.ts 中注册工具前后加统一守卫       │
│ 防止新增工具绕过第一层                                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.5 bash preflight 危险模式

从 openhanako 借鉴，在 bash 命令执行前进行模式匹配：

```ts
const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\bsudo\b/,
  /\bsu\b/,
  /\bchmod\s+[0-7]*7/,
  /\bchown\b/,
  /\brm\s+-rf\s+\//,
  /\bmkfs\./,
  /\bdd\s+if=/,
  /\bformat\b/,
  /\bdel\s+\/s\b/i,          // Windows
  /\brmdir\s+\/s\b/i,        // Windows
  /\breg\s+delete\b/i,       // Windows
  /\btakeown\b/i,            // Windows
  /\bicacls\b/i,             // Windows
  /\bnet\s+user\b/i,         // Windows
  /\bschtasks\b/i,           // Windows
  /\bsc\s+create\b/i,        // Windows
  /\bbcdedit\b/i,            // Windows
];
```

preflight 命中后直接拒绝，不进入 PathGuard 路径检查——因为这些命令本身就超出 Agent 应有的操作范围。

---

## 四、Agent 能力声明设计

### 4.1 扩展 `settings.json`

```ts
// src/contracts/sandbox.ts（新文件）

export const SandboxCapabilitiesSchema = Type.Object({
  workspaceAccess: Type.Literal("rw"),  // Phase 9 固定 rw
  extraReadPaths: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
  protectedPaths: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
});

export type SandboxCapabilities = Static<typeof SandboxCapabilitiesSchema>;

// 更新 AgentSettingsSchema（拓展原 src/contracts/agent-settings.ts）
export const AgentSettingsV2Schema = Type.Object({
  version: Type.Literal(2),
  defaultCwd: Type.Union([Type.String(), Type.Null()]),
  sandbox: Type.Optional(SandboxCapabilitiesSchema),
  updatedAt: Type.String(),
});
```

### 4.2 默认值

新 Agent 或无 sandbox 配置时使用安全默认值：

```ts
export function defaultSandboxCapabilities(): SandboxCapabilities {
  return {
    workspaceAccess: "rw",
    extraReadPaths: [],
    protectedPaths: [".env", "secrets/", "credentials/"],
  };
}
```

### 4.3 向后兼容

- 旧 `settings.json`（version 1）无 `sandbox` 字段 → 使用 `defaultSandboxCapabilities()`
- 旧 `settings.json` 自动迁移为 version 2（策略同 Phase 8 的 identity 迁移模式）
- 迁移不改变用户已有配置的语义——只是补上缺失的 sandbox 字段

---

## 五、OS 沙箱后端接口

### 5.1 抽象定义

```ts
// src/sandbox/backend.ts（新文件）

export interface ExecuteOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

export interface ExecuteResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface SandboxBackend {
  readonly id: string;
  execute(options: ExecuteOptions): Promise<ExecuteResult>;
  dispose(): Promise<void>;
}

export interface SandboxBackendFactory {
  readonly id: string;
  create(agentId: string, policy: PathGuardPolicy): Promise<SandboxBackend>;
}
```

### 5.2 LocalBackend（Phase 9 唯一实现）

```ts
// src/sandbox/local-backend.ts（新文件）

export class LocalBackend implements SandboxBackend {
  readonly id = "local";

  constructor(private readonly pathGuard: PathGuard) {}

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    // 1. bash preflight 检查
    // 2. 从命令提取路径，逐个 PathGuard.check("exec", path)
    // 3. 通过后 spawn 子进程执行
    // 4. 脱敏 stdout/stderr 中的敏感路径
  }
}
```

### 5.3 注册机制（架构预留）

```ts
// src/sandbox/registry.ts（新文件）

const backendRegistry = new Map<string, SandboxBackendFactory>();

export function registerSandboxBackend(factory: SandboxBackendFactory): void { ... }
export function getSandboxBackend(id: string): SandboxBackendFactory { ... }
```

Phase 9 只在各模块入口注册 `LocalBackend`。用户不可配置后端——固定使用 local。

---

## 六、安全审计日志

### 6.1 新增平台事件类型

```ts
// 在 src/contracts/events.ts 中新增
"sandbox.denied"  → { operation, path, level, required, reason, agentId }
"sandbox.preflight-denied" → { command, pattern, agentId }
```

### 6.2 日志存储

- 写入 `~/.opencolorful/logs/security-audit.jsonl`（每行一条 JSON）
- 格式：`{ timestamp, eventId, type, agentId, sessionId?, operation, path, reason }`
- API Key 和 token 自动脱敏（复用现有的 `src/runtime/sanitize.ts`）

---

## 七、文件变更清单

### 7.1 新增文件

| 文件 | 动作 | 说明 |
|------|------|------|
| `src/sandbox/` | 新建目录 | 沙箱模块根 |
| `src/sandbox/path-guard.ts` | 新建 | PathGuard 核心类 |
| `src/sandbox/policy.ts` | 新建 | 策略推导引擎 |
| `src/sandbox/backend.ts` | 新建 | SandboxBackend 接口定义 |
| `src/sandbox/local-backend.ts` | 新建 | LocalBackend 实现 |
| `src/sandbox/registry.ts` | 新建 | 后端注册表 |
| `src/sandbox/preflight.ts` | 新建 | bash preflight 危险模式 |
| `src/sandbox/sandbox-service.ts` | 新建 | 沙箱服务组合（加载策略→初始化后端） |
| `src/contracts/sandbox.ts` | 新建 | 沙箱相关 TypeBox Schema + 类型 |
| `src/server/routes/sandbox.ts` | 新建 | 沙箱状态/配置 API |
| `tests/unit/path-guard.test.ts` | 新建 | PathGuard 单元测试 |
| `tests/unit/policy.test.ts` | 新建 | 策略推导测试 |
| `tests/unit/preflight.test.ts` | 新建 | bash preflight 测试 |
| `tests/unit/sandbox-contracts.test.ts` | 新建 | 沙箱 Schema 验证测试 |
| `tests/integration/sandbox-tools.test.ts` | 新建 | 工具 wrapper 集成测试 |
| `tests/integration/sandbox-agent-settings.test.ts` | 新建 | Agent settings 沙箱字段集成测试 |

### 7.2 修改文件

| 文件 | 动作 | 说明 |
|------|------|------|
| `src/contracts/agent-settings.ts` | 编辑 | 升级 AgentSettingsSchema 到 v2，加 sandbox 字段 + 迁移 |
| `src/contracts/events.ts` | 编辑 | 新增 `sandbox.denied` / `sandbox.preflight-denied` 事件类型 |
| `src/runtime/tool-policy.ts` | 编辑 | ToolPolicy 集成 PathGuard，工具解析时注入沙箱策略 |
| `src/runtime/session-runtime.ts` | 编辑 | Session 创建时初始化 SandboxService |
| `src/pi-sdk/agent-session.ts` | 编辑 | 工具注册入口加兜底沙箱守卫 |
| `src/server/app.ts` | 编辑 | 注册 sandbox 路由 |
| `src/server/routes/messages.ts` | 编辑 | Prompt 路由集成沙箱上下文 |
| `src/server/routes/sessions.ts` | 编辑 | Session 创建时传递沙箱配置 |
| `src/server/routes/agents.ts` | 编辑 | Agent settings 读写支持新 sandbox 字段 |
| `src/config/agent-store.ts` | 编辑 | Agent 存储支持 v2 settings 读写 + 迁移 |
| `web/src/features/agents/AgentForm.tsx` | 编辑 | Agent 编辑页增加沙箱配置 UI |
| `web/src/features/agents/AgentCreatePage.tsx` | 编辑 | Agent 创建页集成沙箱默认值 |
| `web/src/features/sessions/NewSessionPage.tsx` | 编辑 | 新建会话继承 Agent 沙箱设置 |
| `web/src/lib/sse-client.ts` | 编辑 | `KNOWN_EVENT_TYPES` 新增 sandbox 事件类型 |
| `docs/development.md` | 编辑 | 质量门更新（无需改流程，仅加测试命令） |
| `README.md` | 编辑 | 安全特性说明 |

---

## 八、任务拆分与依赖

### 依赖图

```
Task 1 (契约层, ~3 files)
  └─→ Task 2 (PathGuard 核心 + policy, ~3 files)     ← 串行（依赖 Schema）
       ├─→ Task 3 (preflight + LocalBackend + registry, ~3 files)  ← 并行
       ├─→ Task 4 (ToolPolicy 集成 + PI 适配层守卫, ~3 files)      ← 并行
       └─→ Task 5 (安全审计日志, ~2 files)                         ← 并行
            ├─→ Task 6 (Server 路由 + Agent store + Session 集成, ~6 files) ← 串行
            │    └─→ Task 7 (Web UI sandbox 配置 + SSE 事件, ~5 files)     ← 串行
            └─→ Task 8 (测试, ~6 files)                                   ← 并行于 6/7
                 └─→ Task 9 (质量门 + browser-use 验收, 主Agent)            ← 串行
```

### Task 1：契约层 — 沙箱 Schema 定义（主 Agent 串行先行）

- **文件**：`src/contracts/sandbox.ts`（新）、`src/contracts/agent-settings.ts`（改）、`src/contracts/events.ts`（改）
- **内容**：四级模型类型、SandboxCapabilities Schema、AgentSettings v2 升级、sandbox 事件类型
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npx vitest run tests/unit/sandbox-contracts.test.ts
  ```

### Task 2：PathGuard 核心 + 策略推导（子 Agent）

- **文件**：`src/sandbox/path-guard.ts`（新）、`src/sandbox/policy.ts`（新）
- **依赖**：Task 1
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npx vitest run tests/unit/path-guard.test.ts tests/unit/policy.test.ts
  ```

### Task 3：preflight + LocalBackend + registry（子 Agent）

- **文件**：`src/sandbox/preflight.ts`（新）、`src/sandbox/local-backend.ts`（新）、`src/sandbox/backend.ts`（新）、`src/sandbox/registry.ts`（新）
- **依赖**：Task 2（需要 PathGuard）
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npx vitest run tests/unit/preflight.test.ts
  ```

### Task 4：ToolPolicy 集成 + PI 适配层守卫（子 Agent）

- **文件**：`src/runtime/tool-policy.ts`（改）、`src/pi-sdk/agent-session.ts`（改）、`src/runtime/session-runtime.ts`（改）
- **依赖**：Task 2（需要 PathGuard 和 policy）
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npx vitest run tests/integration/sandbox-tools.test.ts
  ```

### Task 5：安全审计日志（子 Agent）

- **文件**：`src/sandbox/sandbox-service.ts`（新）、日志写入逻辑
- **依赖**：Task 2
- **内容**：结构化安全事件写入 `security-audit.jsonl`，复用 `src/runtime/sanitize.ts` 脱敏
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  ```

### Task 6：Server 路由 + Agent store + Session 集成（子 Agent）

- **文件**：`src/server/app.ts`（改）、`src/server/routes/sandbox.ts`（新）、`src/server/routes/agents.ts`（改）、`src/server/routes/sessions.ts`（改）、`src/server/routes/messages.ts`（改）、`src/config/agent-store.ts`（改）
- **依赖**：Task 3, 4, 5（需要所有后端逻辑就绪）
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npx vitest run tests/integration/sandbox-agent-settings.test.ts
  ```

### Task 7：Web UI sandbox 配置 + SSE 事件（子 Agent）

- **文件**：`web/src/features/agents/AgentForm.tsx`（改）、`web/src/features/agents/AgentCreatePage.tsx`（改）、`web/src/features/sessions/NewSessionPage.tsx`（改）、`web/src/lib/sse-client.ts`（改）
- **依赖**：Task 6（需要 API 就绪）
- **验证**：
  ```powershell
  npx tsc --noEmit -p tsconfig.json
  npm run test --workspace=web
  ```

### Task 8：测试文件（子 Agent，与 Task 6/7 并行）

- **文件**：见 7.1（6 个新测试文件）
- **依赖**：Task 2（需要 PathGuard 和 policy 可用）
- **验证**：
  ```powershell
  npx vitest run
  ```

### Task 9：质量门 + browser-use 验收 + 文档更新（主 Agent）

- **内容**：
  1. 独立审查全部 diff
  2. 重跑所有质量门
  3. browser-use 打开工作台验证沙箱配置 UI
  4. 更新 README.md + docs/development.md
  5. 提交 + 打标签 `phase-9-complete`

---

## 九、质量门

```powershell
# 标准 6 项
node scripts/verify-pi-sdk-imports.mjs
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run test --workspace=web
npm run web:build
npx tsc -p tsconfig.build.json
cd web; npx playwright test

# 新增：browser-use 实际交互验收
# 1. npm run web:build && npm run cli -- supervisor start
# 2. browser-use 打开 http://127.0.0.1:4311
# 3. 进入 Agent 编辑页 → 验证 sandbox 配置 UI 可见
# 4. 进入 设置中心 → 验证沙箱相关选项
```

---

## 十、验收标准

- [x] PathGuard 四级模型正确实现，所有路径检查通过单元测试
- [x] 策略引擎从 Agent settings 正确推导 PathGuardPolicy
- [x] bash preflight 拦截 `sudo`、`chmod 777`、`rm -rf /` 等危险命令
- [x] write/edit 在 wrapper 层经 PathGuard 拦截；bash 在 OS 沙箱就绪前 fail-closed 禁用
- [x] PI SDK 扩展加载、上下文缺失和工具包装均 fail-closed
- [x] `auth.json`、`.env`、`~/.ssh`、平台日志等敏感路径不可被 Agent 读取
- [x] Agent 创建/编辑页可配置 `extraReadPaths` 和 `protectedPaths`
- [x] Agent settings 从 v1 自动迁移到 v2（无 sandbox 字段 → 使用安全默认值）
- [x] 生产拒绝事件写入 `security-audit.jsonl`，包含 eventId/sessionId 并经过脱敏
- [x] 全部质量门通过（PI 边界、tsc、server/web tests、build、Playwright、browser-use）
- [x] browser-use 验收通过；真实浏览器回归验证 Agent 越权操作展示可读拒绝且不泄露绝对路径
- [x] `ALL_TOOLS` 中的 7 个内置工具均受统一沙箱扩展约束

---

## 实施记录

### 提交记录

| 提交 Hash | Task | 说明 |
|-----------|------|------|
| `c2ccbde` | 合同与设置 | 四级访问模型、PathGuard 合同、AgentSettings v2 |
| `a5c9190` / `4f90f31` | Phase 9 主实现 | PathGuard、策略、后端、路由、Web 配置与审计原型 |
| `950816c`..`795996e` | 安全复审修复 | 工具统一守卫、Session 隔离、fail-closed、Windows 路径语义 |
| 待提交工作区 | 最终闭环 | 生产审计、跨加载器 Session 上下文、扩展/浏览器回归、保护路径去重 |

### 质量门结果（2026-07-30）

| 验证项 | 结果 |
|--------|------|
| verify-pi-sdk-imports | 通过 |
| tsc --noEmit | 通过 |
| vitest run | 通过，44 files / 390 tests |
| web:test | 通过，28 files / 326 tests |
| web:build | 通过 |
| tsc build | 通过 |
| playwright | 通过，41/41（单 worker 全量） |
| browser-use | 通过：创建/编辑沙箱配置可用，默认保护路径去重后持久化正确 |

### 阻断与修复

- `SandboxService.logDenied()` / `logPreflightDenied()` 原先只有测试调用方：现由 `SessionRuntime → ToolPolicy` 生产链路自动调用。
- sandbox 模式 bash 直接抛错但未审计：现记录 `sandbox.preflight-denied`，pattern 为 `bash-disabled`。
- 审计目录可能被 home 工作区的 `FULL` 规则覆盖：平台 `logs/` 现固定为 `BLOCKED`。
- sandbox-extension 缺少自动化边界覆盖：已补扩展加载、数量错误、缺上下文、全工具包装、空路径、并发隔离和 bash 禁用测试。
- Windows 大小写修复无回归测试：已覆盖 basename、目录前缀和精确匹配。
- PI 通过 `jiti` 加载扩展，与应用侧 ESM import 形成不同模块实例，导致生产工具执行读不到 Session 上下文：现以进程级共享注册表按 PI `sessionId` 精确关联策略，AsyncLocalStorage 仅作直接调用后备，并在 Runtime dispose 时安全注销。
- Agent 创建时默认 `protectedPaths` 与用户输入直接拼接会产生重复项：现稳定去重，并补 AgentStore 回归测试与 browser-use 持久化验收。
- 新增真实浏览器沙箱回归：绑定 Agent 后读取 `.env`，工具卡必须显示可读拒绝原因，且不得泄露平台绝对路径。

### 最终结论

Phase 9 应用层沙箱与安全链路已完成并验收。文件工具统一受 PathGuard 约束，Session 策略隔离、生产审计、fail-closed、Windows 路径语义及真实浏览器拒绝反馈均有自动化覆盖。OS 级进程隔离仍按原范围留待后续阶段。

---

*调研详情参见各参考项目的沙箱分析，汇总文档留待实施时整理进 `docs/sandbox-design.md`。*
