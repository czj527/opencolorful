import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════
// F1 flaky 回归：主进程 api-proxy 的幂等 GET 受限重试。
// 缺陷背景：Chromium 网络服务抖动窗口内 fetch 抛异常（含 AbortSignal.timeout
// 超时）直接返回 NETWORK status 0——瞬时失败被放大为永久失败。
// 修复后：GET 失败等待 200ms 后用同一 base 重试一次（仅此一次）；重试成功走
// 正常路径，仍失败才清 activeBase 并返回 NETWORK；非 GET 不重试。
// ═══════════════════════════════════════════════════════════════

interface ApiProxyResult {
  readonly ok: boolean;
  readonly status: number;
  readonly data: { readonly code?: string; readonly message?: string };
  readonly base: string;
}

interface ApiProxyModule {
  apiRequest(request: { method: string; path: string; body?: unknown }): Promise<ApiProxyResult>;
}

const requireCjs = createRequire(import.meta.url);

/** 每个 it 独立加载（activeBase 是模块级状态，避免用例间串扰） */
function loadApiProxy(): ApiProxyModule {
  vi.resetModules();
  return requireCjs("../../electron/api-proxy.cjs") as ApiProxyModule;
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

afterEach(() => {
  delete process.env.OPENCOLORFUL_SERVER_URL;
  vi.unstubAllGlobals();
});

describe("api-proxy 幂等 GET 受限重试（F1 flaky 回归）", () => {
  it("GET 首次抛错：等待后用同一 base 重试一次并恢复正常路径", async () => {
    process.env.OPENCOLORFUL_SERVER_URL = "http://127.0.0.1:9999";
    const { apiRequest } = loadApiProxy();
    const attemptedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      attemptedUrls.push(String(input));
      if (attemptedUrls.length === 1) throw new Error("网络服务抖动");
      return okResponse({ entries: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiRequest({ method: "GET", path: "/api/sessions/s-1/entries" });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ entries: [] });
    // 恰好两次尝试，且 URL（= 同一 base + path）完全一致
    expect(attemptedUrls).toHaveLength(2);
    expect(attemptedUrls[0]).toBe(attemptedUrls[1]);
    // 重试期间不清 activeBase（此处以"重试成功即走正常路径"为外部证据）
    expect(result.base).toBe("http://127.0.0.1:9999");
  });

  it("GET 两次均失败：才返回 NETWORK status 0（重试仍受限于一次）", async () => {
    process.env.OPENCOLORFUL_SERVER_URL = "http://127.0.0.1:9999";
    const { apiRequest } = loadApiProxy();
    const fetchMock = vi.fn(async () => {
      throw new Error("网络服务抖动");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiRequest({ method: "GET", path: "/api/health" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data.code).toBe("NETWORK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("非 GET 失败不重试：一次尝试即返回 NETWORK", async () => {
    process.env.OPENCOLORFUL_SERVER_URL = "http://127.0.0.1:9999";
    const { apiRequest } = loadApiProxy();
    const fetchMock = vi.fn(async () => {
      throw new Error("网络服务抖动");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiRequest({ method: "POST", path: "/api/sessions/s-1/messages", body: { content: "hi" } });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data.code).toBe("NETWORK");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
