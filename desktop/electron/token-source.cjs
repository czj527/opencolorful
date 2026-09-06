"use strict";

/**
 * P0-1 信任边界：主进程侧只读解析本机服务访问令牌。
 * 来源优先级：env OPENCOLORFUL_SERVER_TOKEN > <OPENCOLORFUL_HOME>/runtime/server-token
 * （home 缺省 ~/.opencolorful，与 src/config/paths.ts 的 getRuntimePaths 一致）。
 * 只读：客户端绝不生成/落盘服务端凭据；令牌不落日志。
 * 403 时调用 invalidateToken() 丢弃缓存，下一次请求重新读文件（服务端重新生成后自愈）。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOKEN_ENV = "OPENCOLORFUL_SERVER_TOKEN";

let cachedToken = null;

function resolveHomeDir() {
  const override = (process.env.OPENCOLORFUL_HOME ?? "").trim();
  return override !== "" ? path.resolve(override) : path.join(os.homedir(), ".opencolorful");
}

function readTokenFile() {
  try {
    const raw = fs.readFileSync(path.join(resolveHomeDir(), "runtime", "server-token"), "utf8").trim();
    return raw !== "" ? raw : null;
  } catch {
    return null;
  }
}

/** env > 文件（带缓存）；都不可得返回 null（此时请求不携带令牌，服务端按边界拒绝） */
function resolveToken() {
  const fromEnv = (process.env[TOKEN_ENV] ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  if (cachedToken === null) cachedToken = readTokenFile();
  return cachedToken;
}

function invalidateToken() {
  cachedToken = null;
}

module.exports = { resolveToken, invalidateToken };
