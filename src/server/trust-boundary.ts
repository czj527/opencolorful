import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Context, Next } from "hono";

import { isLocalUiOrigin } from "../server/observability/client-events.js";

/**
 * P0-1 本机 HTTP/WS 信任边界（审计 2026-09-06 §5 P0-1）。
 *
 * 威胁模型：服务默认绑定 127.0.0.1，但浏览器跨站简单请求（CSRF）、DNS-rebinding、
 * 恶意 Origin 的 WebSocket 握手仍可直达本机端口。防线：
 * 1. 启动令牌（env > <home>/runtime/server-token > 随机生成并落盘），timingSafeEqual 比较；
 * 2. 全局中间件：Host 校验（DNS-rebinding）+ 写请求令牌 + JSON Content-Type + Origin 规则；
 * 3. WS 握手：Origin 存在时必须本机；Origin 缺失时必须带合法令牌（?token=）。
 *
 * 不允许任何 fail-open 开关：没有"测试跳过校验"的环境变量，测试通过显式传令牌走真实路径。
 */

export const SERVER_TOKEN_ENV = "OPENCOLORFUL_SERVER_TOKEN";
const TOKEN_FILE_NAME = "server-token";
const TOKEN_BYTES = 32;

/** 令牌比较走 sha256 摘要 + timingSafeEqual：长度差异不泄露比较耗时 */
function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented === "") return false;
  return timingSafeEqual(tokenDigest(presented), tokenDigest(expected));
}

export function generateServerToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function serverTokenFilePath(runtimeDir: string): string {
  return path.join(runtimeDir, TOKEN_FILE_NAME);
}

/** 读取已存在的令牌文件；缺失/不可读/空内容一律视为不存在（调用方决定回退行为） */
function readTokenFile(runtimeDir: string): string | null {
  try {
    const raw = fs.readFileSync(serverTokenFilePath(runtimeDir), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/**
 * 只读解析令牌（受信客户端用：TUI/代理等）：env > 文件；都不存在返回 null。
 * 绝不生成、绝不落盘——客户端无权创建服务端凭据。
 */
export function readPresentServerToken(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir?: string,
): string | null {
  const fromEnv = (env[SERVER_TOKEN_ENV] ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  if (runtimeDir === undefined) return null;
  return readTokenFile(runtimeDir);
}

/**
 * 服务启动解析：env OPENCOLORFUL_SERVER_TOKEN > <runtime>/server-token > 随机新生成并写入文件。
 * 写失败仅告警不阻断启动（告警文案不含令牌本体）。
 */
export function resolveServerToken(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir?: string,
  warn: (message: string) => void = (message) => console.warn(message),
): string {
  const fromEnv = (env[SERVER_TOKEN_ENV] ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  if (runtimeDir !== undefined) {
    const fromFile = readTokenFile(runtimeDir);
    if (fromFile !== null) return fromFile;
    const generated = generateServerToken();
    // 写失败仅告警不阻断启动（writeTokenFile 内部告警含路径与原因，不含令牌本体）
    writeTokenFile(runtimeDir, generated, warn);
    return generated;
  }
  return generateServerToken();
}

function writeTokenFile(runtimeDir: string, token: string, warn: (message: string) => void): boolean {
  const target = serverTokenFilePath(runtimeDir);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    // 0600：Windows 上 chmod 近似只读位，尽力而为；先写临时文件再 rename 保证原子可见
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // 非 POSIX 文件系统尽力而为
    }
    fs.renameSync(temp, target);
    return true;
  } catch (error) {
    warn(`无法写入本机服务令牌文件（${target}）：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** 从请求头提取令牌：Authorization: Bearer <t> 或 X-OC-Token: <t> */
export function presentedToken(headers: Headers): string | undefined {
  const auth = headers.get("authorization");
  if (auth !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match !== null) {
      const value = match[1]?.trim() ?? "";
      if (value !== "") return value;
    }
  }
  const custom = headers.get("x-oc-token");
  if (custom !== null && custom.trim() !== "") return custom.trim();
  return undefined;
}

/** WS 握手的 ?token= 查询参数（EventSource/WebSocket 无法自定义请求头时的通道） */
function wsQueryToken(url: URL): string | undefined {
  const value = url.searchParams.get("token");
  return value !== null && value.trim() !== "" ? value.trim() : undefined;
}

/** Host 头 → 主机名（剥离端口；IPv6 括号形式取括号内）。缺失/空返回 null */
export function hostHeaderName(host: string | undefined): string | null {
  if (host === undefined) return null;
  let value = host.trim().toLowerCase();
  if (value === "") return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    const inner = value.slice(1, end);
    return inner === "" ? null : inner;
  }
  // 单个冒号视为 host:port；多个冒号是裸 IPv6 地址（如 ::1），不再剥离
  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    value = value.slice(0, firstColon);
  }
  return value === "" ? null : value;
}

const LOCAL_HOSTNAMES = new Set<string>(["localhost", "127.0.0.1", "::1"]);

/** DNS-rebinding 防御：Host 必须是本机回环名或与配置的绑定 host 一致（忽略端口） */
export function isLocalHostHeader(host: string | undefined, bindHost?: string): boolean {
  const name = hostHeaderName(host);
  if (name === null) return false;
  if (LOCAL_HOSTNAMES.has(name)) return true;
  if (bindHost !== undefined && bindHost.trim() !== "") {
    const bound = hostHeaderName(bindHost);
    if (bound !== null && bound === name) return true;
  }
  return false;
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && contentLength.trim() !== "" && contentLength.trim() !== "0") {
    return true;
  }
  return request.headers.has("transfer-encoding");
}

/** 容忍 "; charset=..." 后缀；base 必须恰好是 application/json */
function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json";
}

const READ_METHODS = new Set<string>(["GET", "HEAD", "OPTIONS"]);

export interface TrustBoundaryOptions {
  readonly token: string;
  /** 服务配置的绑定 host（默认 127.0.0.1）；显式绑定其他地址时放行对应 Host 头 */
  readonly bindHost?: string;
  /**
   * strict（Agent Server）：写请求必须携带有效令牌；带请求体必须是 application/json。
   * origin-guard（Supervisor）：写请求「有效令牌 或 本机 Origin」其一即可——
   * 浏览器经 Supervisor 同源访问时不持有令牌，由 Supervisor 转发时统一注入。
   */
  readonly mode?: "strict" | "origin-guard";
}

function reject(context: Context, status: 403 | 415, message: string): Response {
  const code = status === 403 ? "FORBIDDEN" : "UNSUPPORTED_MEDIA_TYPE";
  return context.json({ code, message }, status);
}

const HOST_REJECT_MESSAGE = "本机服务拒绝该请求：Host 头缺失或不是本机地址";
const TOKEN_REJECT_MESSAGE = "本机服务拒绝该请求：缺少有效的访问令牌";
const ORIGIN_REJECT_MESSAGE = "本机服务拒绝该请求：请求来源（Origin）不是本机来源";
const CONTENT_TYPE_REJECT_MESSAGE = "本机服务拒绝该请求：请求体必须是 application/json";

/**
 * 全局信任边界中间件。挂在所有路由之前（含 WS upgrade：@hono/node-ws 的
 * injectWebSocket 会把 upgrade 请求送进完整 Hono 管线，中间件返回非 101 响应时
 * 握手被拒绝并回写 HTTP 状态码）。
 *
 * 校验顺序：
 * 1. 所有请求（无旁路）：Host 校验；
 * 2. WS 握手：Origin 存在时必须本机（即使带合法令牌——WS 握手无法安全承载
 *    Authorization 头之外的浏览器侧凭据，Origin 是唯一浏览器强制附加的信号）；
 *    Origin 缺失时必须带合法令牌（?token=）；
 * 3. 写请求（strict）：必须有效令牌（令牌优先——有效令牌时跳过 Origin 校验，
 *    兼容 Electron 生产 renderer 可能发出 Origin: null / file:// 的情形）；
 *    带请求体时 Content-Type 必须 application/json；
 * 4. 写请求（origin-guard）：有效令牌 或 本机 Origin；
 * 5. 读请求：仅 Host 校验（浏览器跨站读不到无 CORS 响应；本机进程本可读令牌文件）。
 */
export function createTrustBoundaryMiddleware(options: TrustBoundaryOptions) {
  const mode = options.mode ?? "strict";
  return async (context: Context, next: Next): Promise<Response | undefined> => {
    if (!isLocalHostHeader(context.req.header("host"), options.bindHost)) {
      return reject(context, 403, HOST_REJECT_MESSAGE);
    }

    const isWsUpgrade = (context.req.header("upgrade") ?? "").trim().toLowerCase() === "websocket";
    const hasValidToken = tokenMatches(
      presentedToken(context.req.raw.headers) ?? (isWsUpgrade ? wsQueryToken(new URL(context.req.url)) : undefined),
      options.token,
    );
    const origin = context.req.header("origin");
    const originIsLocal = isLocalUiOrigin(origin);

    if (isWsUpgrade) {
      if (origin !== undefined && origin !== "" && !originIsLocal) {
        return reject(context, 403, ORIGIN_REJECT_MESSAGE);
      }
      if (!hasValidToken && !originIsLocal) {
        return reject(context, 403, TOKEN_REJECT_MESSAGE);
      }
      await next();
      return undefined;
    }

    const method = context.req.method.toUpperCase();
    if (READ_METHODS.has(method)) {
      await next();
      return undefined;
    }

    // ── 写请求 ──
    if (mode === "strict") {
      if (!hasValidToken) {
        // 契约原文：无有效令牌时若带 Origin 还须本机——令牌必填分支已经 403，
        // 两条路径同样拒绝（跨站简单请求与缺令牌请求在此合并为同一稳定错误）。
        return reject(context, 403, TOKEN_REJECT_MESSAGE);
      }
      if (hasRequestBody(context.req.raw) && !isJsonContentType(context.req.header("content-type"))) {
        return reject(context, 415, CONTENT_TYPE_REJECT_MESSAGE);
      }
    } else {
      if (!hasValidToken) {
        if (origin !== undefined && origin !== "") {
          if (!originIsLocal) {
            // 跨站浏览器写请求必带非本机 Origin：主防线，拒绝。
            return reject(context, 403, ORIGIN_REJECT_MESSAGE);
          }
          // 本机 Origin 且无令牌 → 放行：Supervisor 同源浏览器 UI 不持有令牌，
          // 信任级别等同"可读令牌文件的本地进程"（与设计文档/接线注释一致）。
        } else {
          // 无 Origin 的 Node 端脚本写请求：既非浏览器同源形态也无凭据 → 拒绝。
          return reject(context, 403, TOKEN_REJECT_MESSAGE);
        }
      }
    }
    await next();
    return undefined;
  };
}
