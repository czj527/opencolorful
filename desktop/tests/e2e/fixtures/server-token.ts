/**
 * 共享：本机 Agent Server 访问令牌（P0-1 信任边界的 Node 测试侧适配）。
 *
 * 服务端启动时按 env OPENCOLORFUL_SERVER_TOKEN > <home>/runtime/server-token >
 * 随机生成并落盘解析令牌（src/server/trust-boundary.ts resolveServerToken）；
 * 测试 fixture 与 desktop/electron/token-source.cjs 同路径、同优先级只读取同一文件。
 *
 * 约定：写请求（POST/PUT/DELETE）在 strict 模式必须携带 `Authorization: Bearer <token>`；
 * 令牌缺失时抛错——绝不静默无凭据直呼（信任边界无任何跳过校验的开关，测试侧同样无旁路）。
 * 读请求（GET/HEAD/OPTIONS）仅需 Host 校验，无需本 helper。
 */
import fs from "node:fs";
import path from "node:path";

/** 只读 <home>/runtime/server-token；文件缺失或空内容返回 null（不抛错，由调用方决定语义）。 */
export function readServerToken(homeDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(homeDir, "runtime", "server-token"), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** 信任边界写请求头（Authorization: Bearer）；令牌缺失时抛错，Node 侧写请求拒绝发出。 */
export function serverAuthHeaders(homeDir: string): Record<string, string> {
  const token = readServerToken(homeDir);
  if (token === null) {
    throw new Error("缺少本机服务访问令牌（<home>/runtime/server-token 不存在），Node 侧写请求拒绝发出");
  }
  return { authorization: `Bearer ${token}` };
}
