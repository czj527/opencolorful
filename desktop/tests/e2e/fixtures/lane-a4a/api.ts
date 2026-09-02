/**
 * A4a lane 本地 fixture：Node 侧真值读取/写入（只读对照约定中的 API 面）。
 *
 * 共享 BackendHarness（../backend.js）只提供 apiGet；本文件补齐 PUT/POST/DELETE，
 * 供 lane 用例做前置数据准备（建助理/会话/Provider）与只读真值对照。
 * 写操作仅用于"准备隔离 home 内的测试前置数据"与"矩阵行链路中产品自身发出的写"的对照，
 * 不用于替产品执行它没有的入口（归档无 UI 入口，按矩阵用 API 归档属既定链路）。
 */

export interface ApiResult<T> {
  readonly status: number;
  readonly ok: boolean;
  readonly json: T;
}

export async function apiSend<T>(
  serverUrl: string,
  method: "PUT" | "POST" | "DELETE",
  apiPath: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await fetch(`${serverUrl}${apiPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
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

/** GET /api/agents 行（identity/baseColor/settings 三段，对应 agents/<id>/ 三文件） */
export interface AgentViewWire {
  readonly identity: { readonly id: string; readonly name: string; readonly createdAt?: string };
  readonly baseColor?: {
    readonly persona?: string;
    readonly personality?: readonly string[];
    readonly replyStyle?: string;
    readonly innerSetting?: string;
  };
  readonly settings?: { readonly defaultCwd?: string | null };
  readonly sessionCount?: number;
}

/** GET /api/sessions 行（SessionView） */
export interface SessionViewWire {
  readonly id: string;
  readonly title: string;
  readonly agentId: string | null;
  readonly archived: boolean;
  readonly archivedAt?: string | null;
  readonly toolMode?: string;
  readonly thinkingLevel?: string;
  readonly workspaceCwd?: string | null;
  readonly workspaceConfirmed?: boolean;
  readonly model?: { readonly providerId: string; readonly modelId: string } | null;
  readonly messages?: readonly string[];
}
