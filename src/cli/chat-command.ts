import { loadEnvironment } from "../config/environment.js";
import { getRuntimePaths } from "../config/paths.js";
import { readPresentServerToken } from "../server/trust-boundary.js";
import { TuiApp } from "../tui/app.js";

export async function runChatCommand(_args: readonly string[]): Promise<void> {
  const environment = loadEnvironment();
  const baseUrl = `http://${environment.host}:${environment.port}`;
  // P0-1 信任边界：CLI 是受信本机客户端，写请求须携带服务令牌（只读解析：
  // env > 令牌文件；不生成、不落盘）。令牌缺失时读请求仍可用，写请求由服务端拒绝。
  const token = readPresentServerToken(process.env, getRuntimePaths().runtime);
  const app = new TuiApp(baseUrl, token);
  await app.start();
}
