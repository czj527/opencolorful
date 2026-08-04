import type { CapabilityKind, PluginExecutionSnapshot } from "../../../contracts/plugin-protocol.js";
import type { TraceContext } from "../../../contracts/observability.js";
import { isKnownCapability } from "../grants/capability-catalog.js";
import type { EffectivePolicy } from "../grants/effective-policy.js";
import type { ResolveState } from "../grants/execution-snapshot.js";
import type { RuntimeHost } from "../runtimes/runtime-host.js";
import type { ContributionRegistry, RegisteredContribution } from "./contribution-registry.js";
import { assertContributionInSnapshot, checkCapabilities, recordCapabilityDenied, serializedBytes } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
// Phase 12 Route Contribution（plans/phase-12.md §8.4）
//
// - 固定命名空间 /api/plugins/:pluginId/<path>：插件只能注册自己 namespace
//   下的相对 path，不能注册根路径、不能覆盖 Core API（/api/... 其他路径）；
// - 平台保留子路径（assets/manifest/health/config/secrets/diagnostics/dev）
//   供 Surface asset / 元数据 / 平台状态使用，插件路由禁止占用；
// - 平台注入 PluginRequestContext：插件身份 + Agent/Session scope + Trace；
//   UI 调用插件 Route 使用短期 Surface Session（T8），本层不发放永久票据；
// - Body、Query、Response 全部执行大小限制与结构校验（Schema 未在冻结
//   协议中声明，本阶段以大小/结构校验兜底，见已知偏差说明）。
// ═══════════════════════════════════════════════════════════════

export const ROUTE_MAX_QUERY_BYTES = 16 * 1024;
export const ROUTE_MAX_BODY_BYTES = 1024 * 1024;
export const ROUTE_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** 平台保留子路径：插件路由禁止注册（Surface asset 与平台状态使用）。 */
export const RESERVED_ROUTE_FIRST_SEGMENTS: readonly string[] = [
  "assets",
  "manifest",
  "health",
  "config",
  "secrets",
  "diagnostics",
  "dev",
];

const SEGMENT_PATTERN = /^[a-zA-Z0-9._~-]+$/;

export class RouteContributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteContributionError";
  }
}

/** 平台注入的插件请求上下文（插件不能自报，由平台组装）。 */
export interface PluginRequestContext {
  readonly pluginId: string;
  readonly method: string;
  /** 完整路径 /api/plugins/<pluginId>/<path> */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly trace?: TraceContext;
}

export interface RouteDescriptor {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  /** 完整 namespace 路径（含固定前缀） */
  readonly fullPath: string;
  readonly methods?: readonly string[];
}

export type RouteErrorCode =
  | "not-found"
  | "method-not-allowed"
  | "invalid-query"
  | "invalid-body"
  | "too-large"
  | "denied"
  | "not-running"
  | "runtime-error"
  | "response-too-large";

export type RouteHandleResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code: RouteErrorCode;
      readonly message: string;
      readonly deniedBy?: string;
      readonly reasonCode?: string;
      readonly httpStatus?: number;
    };

export interface RouteServiceDeps {
  readonly registry: ContributionRegistry;
  readonly policy: EffectivePolicy;
  readonly runtimeHost: RuntimeHost;
}

export function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${pluginId}`;
}

export function pluginRouteFullPath(pluginId: string, path: string): string {
  return `${pluginRoutePrefix(pluginId)}/${path}`;
}

/** 注册期校验：相对 path 合法 + 不占保留 namespace + 不覆盖 Core API。 */
export function validateRoutePath(pluginId: string, path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new RouteContributionError("路由 path 不能为空（不能注册根路径）");
  }
  if (path.length > 256) {
    throw new RouteContributionError("路由 path 过长");
  }
  if (path.startsWith("/") || path.endsWith("/")) {
    throw new RouteContributionError("路由 path 不能以 / 开头或结尾");
  }
  if (path.includes("\\")) {
    throw new RouteContributionError("路由 path 不能包含反斜杠");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new RouteContributionError(`路由 path 包含非法段：${segment}`);
    }
    if (segment === "." || segment === "..") {
      throw new RouteContributionError("路由 path 不能包含 . 或 .. 段");
    }
  }
  const first = segments[0] as string;
  if (RESERVED_ROUTE_FIRST_SEGMENTS.includes(first)) {
    throw new RouteContributionError(`路由 path 不能使用平台保留子路径：${first}`);
  }
  // 固定 namespace 保证插件无法覆盖 Core API（/api/... 其他路径）；
  // 前缀本身由平台生成，插件 path 只作为相对段拼接。
  void pluginId;
  void pluginRouteFullPath;
}

export class RouteService {
  constructor(private readonly deps: RouteServiceDeps) {}

  listRoutes(): RouteDescriptor[] {
    const result: RouteDescriptor[] = [];
    for (const contribution of this.deps.registry.listAll()) {
      if (contribution.kind !== "route") {
        continue;
      }
      const descriptor = this.toDescriptor(contribution);
      if (descriptor !== undefined) {
        result.push(descriptor);
      }
    }
    return result;
  }

  getRoute(pluginId: string, contributionId: string): RouteDescriptor | undefined {
    const contribution = this.deps.registry.get(pluginId, contributionId);
    if (contribution === undefined || contribution.kind !== "route") {
      return undefined;
    }
    return this.toDescriptor(contribution);
  }

  /** 处理插件 Route 请求：定位 → 校验 → 权限前置 → RuntimeHost.invoke（route）。 */
  async handle(input: {
    readonly pluginId: string;
    readonly method: string;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly snapshot?: PluginExecutionSnapshot;
    readonly state?: ResolveState;
    readonly trace?: TraceContext;
    readonly signal?: AbortSignal;
  }): Promise<RouteHandleResult> {
    const { pluginId, method } = input;
    const normalizedMethod = method.toUpperCase();

    // 只允许固定 namespace 内的路径（相对段），绝对路径/Core API 一律拒绝
    if (input.path.startsWith("/")) {
      return this.routeReject("not-found", "路由 path 非法", 404);
    }
    const contribution = this.findRoute(pluginId, input.path, normalizedMethod);
    if (contribution === undefined) {
      return this.routeReject(
        this.hasAnyRoute(pluginId, input.path) ? "method-not-allowed" : "not-found",
        this.hasAnyRoute(pluginId, input.path) ? `方法 ${normalizedMethod} 不被该路由允许` : "路由未登记或不存在",
        this.hasAnyRoute(pluginId, input.path) ? 405 : 404,
      );
    }

    const snapshotCheck = assertContributionInSnapshot({
      snapshot: input.snapshot,
      pluginId,
      contributionId: contribution.id,
    });
    if (!snapshotCheck.ok) {
      return this.routeReject("not-found", snapshotCheck.reason, 404);
    }

    // Query 校验：必须是字符串映射 + 大小限制
    if (input.query !== undefined) {
      const queryOk = isStringRecord(input.query);
      if (!queryOk) {
        return this.routeReject("invalid-query", "Query 必须是字符串键值对", 400);
      }
      if (serializedBytes(input.query) > ROUTE_MAX_QUERY_BYTES) {
        return this.routeReject("too-large", `Query 超过大小限制（${ROUTE_MAX_QUERY_BYTES} 字节）`, 413);
      }
    }
    // Body 校验：JSON 可序列化对象 + 大小限制
    if (input.body !== undefined) {
      if (!isPlainObject(input.body)) {
        return this.routeReject("invalid-body", "Body 必须是 JSON 对象", 400);
      }
      if (serializedBytes(input.body) > ROUTE_MAX_BODY_BYTES) {
        return this.routeReject("too-large", `Body 超过大小限制（${ROUTE_MAX_BODY_BYTES} 字节）`, 413);
      }
    }

    // 权限前置：route.register + requiredCapabilities
    const manifestPermissions = this.deps.registry.getActive(pluginId)?.manifestPermissions;
    const capabilities: CapabilityKind[] = ["route.register"];
    for (const required of contribution.requiredCapabilities) {
      if (isKnownCapability(required)) {
        capabilities.push(required);
      }
    }
    if (input.agentId !== undefined) {
      const guard = checkCapabilities({
        policy: this.deps.policy,
        pluginId,
        agentId: input.agentId,
        capabilities,
        manifestPermissions,
        state: input.state,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      });
      if (!guard.allowed) {
        recordCapabilityDenied({
          eventName: "plugin.sandbox.denied",
          pluginId,
          contributionId: contribution.id,
          agentId: input.agentId,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          capability: guard.capability,
          deniedBy: guard.deniedBy,
          reason: guard.reason ?? "权限不足",
        });
        return this.routeReject(
          "denied",
          `路由 ${input.path} 调用被拒绝：${guard.reason ?? "权限不足"}`,
          403,
          guard.deniedBy,
          `capability-${guard.capability ?? "unknown"}`,
        );
      }
    }

    // 平台注入 PluginRequestContext（身份 + scope + Trace）
    const context: PluginRequestContext = {
      pluginId,
      method: normalizedMethod,
      path: pluginRouteFullPath(pluginId, input.path),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
    };

    const result = await this.deps.runtimeHost.invoke({
      pluginId,
      contributionKind: "route",
      contributionId: contribution.id,
      method: contribution.id,
      params: context,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "not-running" ? "not-running" : "runtime-error",
        message: result.message.slice(0, 400),
        httpStatus: result.code === "not-running" ? 503 : 502,
      };
    }
    if (serializedBytes(result.result) > ROUTE_MAX_RESPONSE_BYTES) {
      return this.routeReject("response-too-large", `响应超过大小限制（${ROUTE_MAX_RESPONSE_BYTES} 字节）`, 413);
    }
    return { ok: true, result: result.result };
  }

  // ── private helpers ───────────────────────────────────────────

  private findRoute(
    pluginId: string,
    relativePath: string,
    method: string,
  ): RegisteredContribution | undefined {
    return this.deps.registry
      .listByKind(pluginId, "route")
      .find((contribution) => {
        const declared = contribution.spec["path"];
        if (declared !== relativePath) {
          return false;
        }
        const methods = contribution.spec["methods"];
        if (!Array.isArray(methods) || methods.length === 0) {
          return true; // 未声明方法 = 全部方法
        }
        return (methods as unknown[]).some((item) => typeof item === "string" && item.toUpperCase() === method);
      });
  }

  private hasAnyRoute(pluginId: string, relativePath: string): boolean {
    return this.deps.registry
      .listByKind(pluginId, "route")
      .some((contribution) => contribution.spec["path"] === relativePath);
  }

  private toDescriptor(contribution: RegisteredContribution): RouteDescriptor | undefined {
    if (contribution.kind !== "route") {
      return undefined;
    }
    const path = contribution.spec["path"];
    if (typeof path !== "string") {
      return undefined;
    }
    const descriptor: RouteDescriptor = {
      pluginId: contribution.pluginId,
      contributionId: contribution.id,
      version: contribution.version,
      name: contribution.name,
      ...(contribution.description !== undefined ? { description: contribution.description } : {}),
      path,
      fullPath: pluginRouteFullPath(contribution.pluginId, path),
    };
    const methods = contribution.spec["methods"];
    if (Array.isArray(methods)) {
      const cleaned = methods.filter((item): item is string => typeof item === "string");
      if (cleaned.length > 0) {
        return { ...descriptor, methods: cleaned.map((item) => item.toUpperCase()) };
      }
    }
    return descriptor;
  }

  private routeReject(
    code: RouteErrorCode,
    message: string,
    httpStatus: number,
    deniedBy?: string,
    reasonCode?: string,
  ): RouteHandleResult {
    const result: RouteHandleResult = {
      ok: false,
      code,
      message,
      httpStatus,
      ...(deniedBy !== undefined ? { deniedBy } : {}),
      ...(reasonCode !== undefined ? { reasonCode } : {}),
    };
    return result;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: Readonly<Record<string, string>>): value is Readonly<Record<string, string>> {
  return Object.values(value).every((item) => typeof item === "string");
}

// 供 host-api 激活期做注册前校验（fail-closed：非法路由拒绝激活）。
export function assertValidRouteMethods(methods: readonly unknown[]): void {
  for (const method of methods) {
    if (typeof method !== "string" || !ALLOWED_HTTP_METHODS.has(method.toUpperCase())) {
      throw new RouteContributionError(`不支持的 HTTP 方法：${String(method)}`);
    }
  }
}
