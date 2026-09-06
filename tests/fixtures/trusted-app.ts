import { createServerApp, type ServerAppOptions, type ServerAppResult } from "../../src/server/app.js";

/**
 * 中央 server 测试 harness（P0-1 审计修复配套）。
 *
 * 与 createServerApp 完全相同的装配（含全局信任边界中间件），区别仅在返回的
 * app 对象：request()/fetch() 会自动附加本实例的访问令牌（Authorization: Bearer）
 * 并在「有请求体且未显式声明 Content-Type」时补 application/json——让测试像
 * 受信客户端一样携带凭据走真实校验路径，而不是绕过校验。
 *
 * 信任边界语义不变：中间件仍逐请求验证令牌/Host/Origin/Content-Type；
 * 需要构造被拒绝请求（403/415）的负例测试请直接用原生 fetch 起真实端口，
 * 或显式传入错误的令牌/Content-Type（harness 不覆盖显式给定的头）。
 */
export function createTrustedServerApp(options: ServerAppOptions = {}): ServerAppResult {
  const { app, nodeWebSocket, token } = createServerApp(options);
  const trustedApp = new Proxy(app, {
    get(target, property) {
      if (property === "request" || property === "fetch") {
        const original = Reflect.get(target, property) as (
          input: Request | string | URL,
          init?: RequestInit,
        ) => Promise<Response>;
        return (input: Request | string | URL, init?: RequestInit) => {
          const request = buildTrustedRequest(input, init, token);
          return original.call(target, request.input, request.init);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { app: trustedApp, nodeWebSocket, token };
}

function buildTrustedRequest(
  input: Request | string | URL,
  init: RequestInit | undefined,
  token: string,
): { input: Request | string | URL; init?: RequestInit } {
  // 相对路径（Hono 自行解析 base）：不能 new Request，改为合并请求头后透传
  if (typeof input === "string" && !/^https?:\/\//i.test(input)) {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    // 真实 HTTP 客户端总会带 Host：in-process Request 不会自动补，这里补上
    if (![...headers.keys()].some((name) => name === "host")) {
      headers.set("host", "127.0.0.1");
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const hasBody = init?.body !== undefined && init.body !== null;
    const hasExplicitContentType = [...headers.keys()].some((name) => name === "content-type");
    if (hasBody && !hasExplicitContentType && method !== "GET" && method !== "HEAD") {
      headers.set("content-type", "application/json");
    }
    return { input, init: { ...(init ?? {}), headers } };
  }
  const explicitHeaders = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const hasExplicitContentType = [...explicitHeaders.keys()].some(
    (name) => name.toLowerCase() === "content-type",
  );
  const request = new Request(input, init);
  request.headers.set("authorization", `Bearer ${token}`);
  // in-process Request 无 Host 头（undici 仅在真实发送时补）：按 URL 推导，
  // 与真实 HTTP 客户端行为一致；显式给定的 Host（伪造 Host 负例）不覆盖
  if (!request.headers.has("host")) {
    const host = input instanceof URL
      ? input.host
      : typeof input === "string"
        ? new URL(input).host
        : undefined;
    request.headers.set("host", host ?? "127.0.0.1");
  }
  const method = request.method.toUpperCase();
  const hasBody = request.body !== null;
  if (hasBody && !hasExplicitContentType && method !== "GET" && method !== "HEAD") {
    request.headers.set("content-type", "application/json");
  }
  return { input: request };
}
