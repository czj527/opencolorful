/**
 * A4d lane 本地 fixture：Node 侧真值读取/写入（只读对照约定中的 API 面）。
 *
 * 共享 BackendHarness（../backend.js）只提供 apiGet；本文件补齐 POST，
 * 供 lane 用例做前置数据准备（建助理）与触发矩阵行链路（deep-dive 排队）。
 * 写操作仅用于"准备隔离 home 内的测试前置数据"与"矩阵行链路中产品自身的入口"，
 * 不替产品执行它没有的入口（MEM-04：Desktop 无 flush UI，本 lane 不以 API 替代）。
 *
 * P0-1 信任边界：写请求（strict）必须携带本机服务令牌（<home>/runtime/server-token），
 * 令牌缺失即抛错——绝不无凭据直呼（无任何跳过校验的旁路）。
 */

import { serverAuthHeaders } from "../server-token.js";

export interface ApiResult<T> {
  readonly status: number;
  readonly ok: boolean;
  readonly json: T;
}

/** apiSend 所需的最小 harness 形状（共享 BackendHarness 满足，避免环依赖） */
export interface BackendHarnessLike {
  readonly serverUrl: string;
  readonly homeDir: string;
}

export async function apiSend<T>(
  harness: BackendHarnessLike,
  method: "PUT" | "POST" | "DELETE",
  apiPath: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const init: RequestInit = {
    method,
    headers: { ...serverAuthHeaders(harness.homeDir) },
    signal: AbortSignal.timeout(15_000),
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${harness.serverUrl}${apiPath}`, init);
  const text = await response.text();
  let json: unknown = null;
  if (text !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, ok: response.ok, json: json as T };
}

/** POST /api/agents/:id/memory/deep-dive 响应（202 queued） */
export interface DeepDiveResponseWire {
  readonly agentId: string;
  readonly status: string;
  readonly message?: string;
}

/** GET /api/agents/:id/memory/runs/:runId 响应（runs/<runId>/run.json + REPORT.md） */
export interface MemoryRunWire {
  readonly agentId: string;
  readonly runId: string;
  readonly run: { readonly runId?: string; readonly status?: string };
  readonly report: string;
}

/** POST /api/agents 行（identity 段） */
export interface AgentViewWire {
  readonly identity: { readonly id: string; readonly name: string };
}
