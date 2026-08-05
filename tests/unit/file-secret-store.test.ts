import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileSecretStore } from "../../src/runtime/plugins/contributions/file-secret-store.js";
import { instrument } from "../../src/observability/instrument.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-secrets-"));
}

function secretFilePath(dir: string): string {
  return path.join(dir, "plugin-secrets.json");
}

describe("FileSecretStore", () => {
  let dir: string;
  let filePath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = makeTempDir();
    filePath = secretFilePath(dir);
    warnSpy = vi.spyOn(instrument, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("set 后同实例可读，值与原样一致", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "fake-secret-value");

    expect(store.has("plugin-a", "apiKey")).toBe(true);
    expect(store.get("plugin-a", "apiKey")).toBe("fake-secret-value");
    expect(store.listNames("plugin-a")).toEqual(["apiKey"]);
  });

  it("写入后落盘，新建实例（模拟重启）读同一文件数据不丢", () => {
    const first = new FileSecretStore({ filePath });
    first.set("plugin-a", "apiKey", "fake-secret-value");
    first.set("plugin-a", "token", "fake-token-value");
    first.set("plugin-b", "webhook", "fake-webhook-value");

    const second = new FileSecretStore({ filePath });
    expect(second.get("plugin-a", "apiKey")).toBe("fake-secret-value");
    expect(second.get("plugin-a", "token")).toBe("fake-token-value");
    expect(second.get("plugin-b", "webhook")).toBe("fake-webhook-value");
  });

  it("磁盘格式为 version 1 的 secrets 嵌套结构且包含 updatedAt", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "fake-secret-value");

    const document = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version: number;
      secrets: Record<string, Record<string, { value: string; updatedAt?: string }>>;
    };
    expect(document.version).toBe(1);
    const apiKeyRecord = document.secrets["plugin-a"]?.["apiKey"];
    expect(apiKeyRecord?.value).toBe("fake-secret-value");
    expect(typeof apiKeyRecord?.updatedAt).toBe("string");
  });

  it("缺失文件按空状态处理，首次 set 自动创建文件", () => {
    const store = new FileSecretStore({ filePath });
    expect(store.has("plugin-a", "apiKey")).toBe(false);
    expect(store.get("plugin-a", "apiKey")).toBeUndefined();
    expect(store.listNames("plugin-a")).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);

    store.set("plugin-a", "apiKey", "fake-secret-value");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("损坏文件不抛致命错误：按空状态处理、保留 .bak 备份并记录 warn", () => {
    fs.writeFileSync(filePath, "{ 这不是合法 JSON", "utf8");

    const store = new FileSecretStore({ filePath });
    expect(() => store.get("plugin-a", "apiKey")).not.toThrow();
    expect(store.get("plugin-a", "apiKey")).toBeUndefined();
    expect(store.listNames("plugin-a")).toEqual([]);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
    expect(fs.readFileSync(`${filePath}.bak`, "utf8")).toBe("{ 这不是合法 JSON");
    expect(warnSpy).toHaveBeenCalledWith(
      "plugin.secret.store_corrupt",
      expect.stringContaining("损坏"),
      expect.objectContaining({ filePath }),
    );

    // 损坏后仍可正常写入，且不会残留 .bak 以外的问题
    store.set("plugin-a", "apiKey", "fake-secret-value");
    expect(store.get("plugin-a", "apiKey")).toBe("fake-secret-value");
  });

  it("结构非法（version 不符）同样按空状态处理并备份", () => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, secrets: {} }), "utf8");

    const store = new FileSecretStore({ filePath });
    expect(store.listNames("plugin-a")).toEqual([]);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
  });

  it("单条记录格式异常只跳过该条，不丢弃其余合法数据", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        secrets: {
          "plugin-a": {
            good: { value: "keep-me" },
            bad: { value: 42 },
            missing: {},
          },
        },
      }),
      "utf8",
    );

    const store = new FileSecretStore({ filePath });
    expect(store.get("plugin-a", "good")).toBe("keep-me");
    expect(store.get("plugin-a", "bad")).toBeUndefined();
    expect(store.get("plugin-a", "missing")).toBeUndefined();
  });

  it("原子写：set 后目录无 .tmp 残留，文件为合法 JSON", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "fake-secret-value");

    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(() => JSON.parse(fs.readFileSync(filePath, "utf8"))).not.toThrow();
  });

  it("覆盖写入以最后一次为准，重启后读到的也是新值", () => {
    const first = new FileSecretStore({ filePath });
    first.set("plugin-a", "apiKey", "old-value");
    first.set("plugin-a", "apiKey", "new-value");

    const second = new FileSecretStore({ filePath });
    expect(second.get("plugin-a", "apiKey")).toBe("new-value");
  });

  it("remove 后立即落盘，重启后不再存在；移除不存在的 Secret 不写盘", () => {
    const first = new FileSecretStore({ filePath });
    first.set("plugin-a", "apiKey", "fake-secret-value");
    first.remove("plugin-a", "apiKey");

    const second = new FileSecretStore({ filePath });
    expect(second.has("plugin-a", "apiKey")).toBe(false);
    expect(second.get("plugin-a", "apiKey")).toBeUndefined();

    // 幂等：移除不存在的键不报错，且磁盘 mtime 不变化
    const before = fs.statSync(filePath).mtimeMs;
    second.remove("plugin-a", "apiKey");
    expect(fs.statSync(filePath).mtimeMs).toBe(before);
  });

  it("listNames 按 pluginId 隔离并按名称排序", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "zeta", "1");
    store.set("plugin-a", "alpha", "2");
    store.set("plugin-b", "gamma", "3");

    expect(store.listNames("plugin-a")).toEqual(["alpha", "zeta"]);
    expect(store.listNames("plugin-b")).toEqual(["gamma"]);
    expect(store.listNames("plugin-c")).toEqual([]);
  });

  it("多次变更后重启数据完整", () => {
    const first = new FileSecretStore({ filePath });
    first.set("plugin-a", "one", "v1");
    first.set("plugin-a", "two", "v2");
    first.remove("plugin-a", "one");
    first.set("plugin-a", "three", "v3");

    const second = new FileSecretStore({ filePath });
    expect(second.listNames("plugin-a")).toEqual(["three", "two"]);
    expect(second.get("plugin-a", "three")).toBe("v3");
    expect(second.get("plugin-a", "two")).toBe("v2");
    expect(second.get("plugin-a", "one")).toBeUndefined();
  });

  it("非 Windows 平台写入后文件权限为 0o600", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "fake-secret-value");

    if (process.platform === "win32") {
      // Windows 不支持完整 POSIX 权限位：跳过断言（best-effort 设计）
      return;
    }
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-3：写盘失败原子性——先持久化成功，再更新内存。
// 通过把目录路径替换成同名文件注入写盘失败（persistSnapshot 的
// mkdirSync 抛 ENOTDIR，等价 EPERM 类失败）：set/remove 必须抛错，
// 且内存与磁盘都保持变更前状态。
// ═══════════════════════════════════════════════════════════════
describe("FileSecretStore：写盘失败原子性（P0-3）", () => {
  let dir: string;
  let filePath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = makeTempDir();
    filePath = secretFilePath(dir);
    warnSpy = vi.spyOn(instrument, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.blocked`, { recursive: true, force: true });
  });

  /** 把目录移开、在原路径放一个同名文件：此后 persistSnapshot 的 mkdirSync 必然失败。 */
  function breakDirectory(): void {
    fs.renameSync(dir, `${dir}.blocked`);
    fs.writeFileSync(dir, "", "utf8");
  }

  /** 恢复目录（移回原位），用于断言磁盘内容未变。 */
  function restoreDirectory(): void {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(`${dir}.blocked`, dir);
  }

  it("set 写盘失败 → 抛错且内存保持旧值，磁盘也保持旧内容", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "old-value");
    const before = fs.readFileSync(filePath, "utf8");

    breakDirectory();
    expect(() => store.set("plugin-a", "apiKey", "new-value")).toThrow();
    expect(store.get("plugin-a", "apiKey")).toBe("old-value");
    expect(store.has("plugin-a", "apiKey")).toBe(true);
    expect(store.listNames("plugin-a")).toEqual(["apiKey"]);

    restoreDirectory();
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("首次 set 写盘失败 → 抛错且内存无该键（get undefined），磁盘不产生文件", () => {
    breakDirectory();

    const store = new FileSecretStore({ filePath });
    expect(() => store.set("plugin-a", "apiKey", "secret-value")).toThrow();
    expect(store.get("plugin-a", "apiKey")).toBeUndefined();
    expect(store.has("plugin-a", "apiKey")).toBe(false);

    restoreDirectory();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("remove 写盘失败 → 抛错且键仍存在，内存与磁盘均保持变更前状态", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "old-value");
    const before = fs.readFileSync(filePath, "utf8");

    breakDirectory();
    expect(() => store.remove("plugin-a", "apiKey")).toThrow();
    expect(store.has("plugin-a", "apiKey")).toBe(true);
    expect(store.get("plugin-a", "apiKey")).toBe("old-value");

    restoreDirectory();
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("写盘失败后内存保持旧值，后续 set 基于旧值继续，失败变更不残留", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "old-value");

    breakDirectory();
    expect(() => store.set("plugin-b", "webhook", "v2")).toThrow();
    expect(store.get("plugin-b", "webhook")).toBeUndefined();
    expect(store.get("plugin-a", "apiKey")).toBe("old-value");

    // 恢复可写后：旧值未因失败 set 丢失；失败写入的键从未进入内存与磁盘
    restoreDirectory();
    store.set("plugin-a", "apiKey", "updated-value");
    expect(store.get("plugin-a", "apiKey")).toBe("updated-value");

    const second = new FileSecretStore({ filePath });
    expect(second.get("plugin-a", "apiKey")).toBe("updated-value");
    expect(second.get("plugin-b", "webhook")).toBeUndefined();
    expect(second.listNames("plugin-a")).toEqual(["apiKey"]);
  });

  it("写盘成功后内存与磁盘一致（覆盖旧值与删除键均落盘）", () => {
    const store = new FileSecretStore({ filePath });
    store.set("plugin-a", "apiKey", "v1");
    store.set("plugin-a", "apiKey", "v2");
    store.remove("plugin-a", "apiKey");

    expect(store.has("plugin-a", "apiKey")).toBe(false);

    // 新实例（模拟重启）从磁盘读到同一状态
    const second = new FileSecretStore({ filePath });
    expect(second.has("plugin-a", "apiKey")).toBe(false);
    expect(second.get("plugin-a", "apiKey")).toBeUndefined();
    expect(second.listNames("plugin-a")).toEqual([]);
  });
});
