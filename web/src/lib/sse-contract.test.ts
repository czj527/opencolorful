/**
 * P1 审计修复（§7.2 / §10-8）· Web SSE 事件类型与服务端契约对齐回归。
 *
 * 缺陷背景：web/src/lib/sse-client.ts 的 KNOWN_EVENT_TYPES 漏掉了服务端
 * EVENT_TYPES 中的 6 项（turn.failed/turn.cancelled/turn.interrupted、
 * session.branch.switched/session.branches.changed、todo.updated）——
 * SSE 客户端按命名事件 addEventListener，未声明的类型**静默丢失**，
 * Web 作为协议验收客户端与服务端/桌面端形成契约缺口。
 *
 * 本测试用文件级提取（非 import）：服务端事件表在 src/contracts/events.ts
 * （Node 侧契约，web 不能直接 import 服务端源码），两侧各自正则提取
 * `"type"` 字面量行断言集合相等，服务端新增事件而 web 未跟进时立即失败。
 * `reset` 是 SSE 传输层特例（服务端以独立 `event: reset` + `data:` 双帧发送，
 * 不在 EVENT_TYPES 契约内），白名单放行。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 仓库根定位：web 测试的 cwd 是 web/（npm workspace 脚本语义），向上找同时
 * 存在两侧源文件的目录（防 cwd 漂移），不依赖 import.meta.url（vitest 模块
 * 转换后非 file 协议）。
 */
function findRepoRoot(): string {
  let current = process.cwd();
  for (let hops = 0; hops < 6; hops += 1) {
    if (
      existsSync(path.join(current, "src", "contracts", "events.ts")) &&
      existsSync(path.join(current, "web", "src", "lib", "sse-client.ts"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`未定位到仓库根（自 ${process.cwd()} 向上）`);
}

/** 从源码文本提取字符串字面量数组项（引号内内容，逐行） */
function extractStringLiterals(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function readSource(relativePath: string): string {
  return readFileSync(path.join(findRepoRoot(), relativePath), "utf8");
}

/** 服务端 EVENT_TYPES（src/contracts/events.ts）的 type 集合 */
function serverEventTypes(): Set<string> {
  const source = readSource("src/contracts/events.ts");
  const block = source.slice(source.indexOf("export const EVENT_TYPES"), source.indexOf("] as const"));
  return new Set(extractStringLiterals(block));
}

/** web KNOWN_EVENT_TYPES（web/src/lib/sse-client.ts）的 type 集合 */
function webKnownEventTypes(): Set<string> {
  const source = readSource("web/src/lib/sse-client.ts");
  const block = source.slice(source.indexOf("const KNOWN_EVENT_TYPES"), source.indexOf("] as const"));
  return new Set(extractStringLiterals(block));
}

describe("Web SSE 事件类型与服务端契约对齐（P1 审计修复回归）", () => {
  it("服务端 EVENT_TYPES 的每一项都在 web KNOWN_EVENT_TYPES 中（不漏）", () => {
    const server = serverEventTypes();
    const web = webKnownEventTypes();
    const missing = [...server].filter((type) => !web.has(type));
    expect(missing, `web 未声明的事件类型（SSE 命名事件会静默丢失）: ${missing.join(", ")}`).toEqual([]);
  });

  it("web KNOWN_EVENT_TYPES 没有契约之外的多余项（不滥）——reset 传输层特例除外", () => {
    const server = serverEventTypes();
    const web = webKnownEventTypes();
    const extra = [...web].filter((type) => !server.has(type) && type !== "reset");
    expect(extra, `web 多声明的事件类型: ${extra.join(", ")}`).toEqual([]);
  });

  it("契约中确实存在波次 B 事件（todo.updated / branch）——防提取失真", () => {
    const server = serverEventTypes();
    expect(server.has("todo.updated")).toBe(true);
    expect(server.has("session.branch.switched")).toBe(true);
    expect(server.has("session.branches.changed")).toBe(true);
    expect(server.has("turn.failed")).toBe(true);
    expect(server.has("turn.cancelled")).toBe(true);
    expect(server.has("turn.interrupted")).toBe(true);
  });
});
