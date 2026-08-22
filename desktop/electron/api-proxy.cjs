"use strict";

/**
 * 主进程 API 代理：renderer 不直连 Server（无 CORS），统一经主进程 Node fetch。
 * 只允许 /api/ 开头的路径；优先 Supervisor 4311，降级 Agent Server 4310。
 */

const DEFAULT_BASES = ["http://127.0.0.1:4311", "http://127.0.0.1:4310"];
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

let activeBase = null;

async function probe(base) {
  const path = base.endsWith("4311") ? "/api/supervisor/status" : "/api/health";
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveBase() {
  const override = process.env.OPENCOLORFUL_SERVER_URL;
  if (override) return override.replace(/\/+$/, "");
  if (activeBase !== null && (await probe(activeBase))) return activeBase;
  for (const base of DEFAULT_BASES) {
    if (await probe(base)) {
      activeBase = base;
      return base;
    }
  }
  activeBase = null;
  return null;
}

async function apiRequest(request) {
  const method = typeof request?.method === "string" ? request.method.toUpperCase() : "";
  const path = request?.path;
  if (!ALLOWED_METHODS.has(method)) throw new Error("不允许的 HTTP 方法");
  if (typeof path !== "string" || !path.startsWith("/api/")) throw new Error("非法 API 路径");

  const base = await resolveBase();
  if (base === null) {
    return { ok: false, status: 0, data: { code: "SERVER_UNREACHABLE", message: "无法连接 OpenColorful 服务（4311/4310 均不可达）", retryable: true }, base: "" };
  }

  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers: request.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (cause) {
    activeBase = null;
    return { ok: false, status: 0, data: { code: "NETWORK", message: `网络请求失败：${cause instanceof Error ? cause.message : String(cause)}`, retryable: true }, base };
  }

  const text = await response.text();
  let data = null;
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = { code: "INVALID_JSON", message: text.slice(0, 200), retryable: false };
    }
  }
  return { ok: response.ok, status: response.status, data, base };
}

module.exports = { apiRequest, resolveBase };
