import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateServerToken,
  hostHeaderName,
  isLocalHostHeader,
  presentedToken,
  readPresentServerToken,
  resolveServerToken,
  serverTokenFilePath,
  tokenMatches,
} from "../../src/server/trust-boundary.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeRuntimeDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-token-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "runtime");
}

describe("resolveServerToken", () => {
  it("env 优先于令牌文件", () => {
    const runtime = makeRuntimeDir();
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(serverTokenFilePath(runtime), "file-token", "utf8");
    expect(resolveServerToken({ OPENCOLORFUL_SERVER_TOKEN: "env-token" }, runtime)).toBe("env-token");
  });

  it("无 env 时读取令牌文件", () => {
    const runtime = makeRuntimeDir();
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(serverTokenFilePath(runtime), "  file-token\n", "utf8");
    expect(resolveServerToken({}, runtime)).toBe("file-token");
  });

  it("无 env 无文件时生成 32 字节 hex 令牌并落盘", () => {
    const runtime = makeRuntimeDir();
    const token = resolveServerToken({}, runtime);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(serverTokenFilePath(runtime), "utf8").trim()).toBe(token);
    if (process.platform !== "win32") {
      expect(fs.statSync(serverTokenFilePath(runtime)).mode & 0o077).toBe(0);
    }
  });

  it("文件写失败仅告警不阻断，仍返回内存令牌", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-token-bad-"));
    temporaryDirectories.push(directory);
    // runtime 路径被一个普通文件占用 → mkdir/write 必然失败
    fs.writeFileSync(path.join(directory, "runtime"), "occupied", "utf8");
    const warnings: string[] = [];
    const token = resolveServerToken({}, path.join(directory, "runtime"), (message) => warnings.push(message));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(warnings).toHaveLength(1);
    // 告警文案绝不包含令牌本体
    expect(warnings[0]).not.toContain(token);
  });

  it("env 为空白字符串时视同未设置", () => {
    const runtime = makeRuntimeDir();
    expect(resolveServerToken({ OPENCOLORFUL_SERVER_TOKEN: "   " }, runtime)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readPresentServerToken", () => {
  it("env > 文件 > null，且绝不生成/落盘", () => {
    const runtime = makeRuntimeDir();
    expect(readPresentServerToken({}, runtime)).toBeNull();
    expect(fs.existsSync(runtime)).toBe(false);

    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(serverTokenFilePath(runtime), "file-token", "utf8");
    expect(readPresentServerToken({}, runtime)).toBe("file-token");
    expect(readPresentServerToken({ OPENCOLORFUL_SERVER_TOKEN: "env-token" }, runtime)).toBe("env-token");
  });
});

describe("tokenMatches", () => {
  it("相同令牌 true、不同令牌 false、空/缺失 false", () => {
    const token = generateServerToken();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(generateServerToken(), token)).toBe(false);
    expect(tokenMatches(undefined, token)).toBe(false);
    expect(tokenMatches("", token)).toBe(false);
  });

  it("长度不同的输入不抛异常（摘要比较）", () => {
    expect(tokenMatches("short", generateServerToken())).toBe(false);
  });
});

describe("hostHeaderName / isLocalHostHeader", () => {
  it("剥离端口与 IPv6 括号", () => {
    expect(hostHeaderName("127.0.0.1:4310")).toBe("127.0.0.1");
    expect(hostHeaderName("localhost")).toBe("localhost");
    expect(hostHeaderName("[::1]:4310")).toBe("::1");
    expect(hostHeaderName("::1")).toBe("::1");
    expect(hostHeaderName(undefined)).toBeNull();
    expect(hostHeaderName("")).toBeNull();
    expect(hostHeaderName("evil.example:4310")).toBe("evil.example");
  });

  it("本机回环名放行、其他主机名拒绝", () => {
    expect(isLocalHostHeader("localhost:4310")).toBe(true);
    expect(isLocalHostHeader("127.0.0.1:4310")).toBe(true);
    expect(isLocalHostHeader("[::1]:4310")).toBe(true);
    expect(isLocalHostHeader("evil.example")).toBe(false);
    expect(isLocalHostHeader(undefined)).toBe(false);
  });

  it("显式绑定的非回环 host 一致时放行", () => {
    expect(isLocalHostHeader("192.168.1.5:4310", "192.168.1.5")).toBe(true);
    expect(isLocalHostHeader("192.168.1.6:4310", "192.168.1.5")).toBe(false);
  });
});

describe("presentedToken", () => {
  it("Authorization: Bearer 与 X-OC-Token 两个通道", () => {
    expect(presentedToken(new Headers({ authorization: "Bearer abc123" }))).toBe("abc123");
    expect(presentedToken(new Headers({ authorization: "bearer abc123" }))).toBe("abc123");
    expect(presentedToken(new Headers({ "x-oc-token": "abc123" }))).toBe("abc123");
    expect(presentedToken(new Headers())).toBeUndefined();
    expect(presentedToken(new Headers({ authorization: "Basic abc" }))).toBeUndefined();
    expect(presentedToken(new Headers({ authorization: "Bearer " }))).toBeUndefined();
  });
});
