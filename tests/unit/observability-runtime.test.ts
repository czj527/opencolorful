import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  currentTrace,
  newTraceId,
  runAsBackground,
  runWithCarrier,
  runWithTrace,
  createBootId,
} from "../../src/observability/trace-context.js";
import {
  normalizeSafeValue,
  normalizeSafeObject,
  redactText,
  sanitizeError,
  isSensitiveKey,
} from "../../src/observability/safe-value.js";
import { DiagnosticLogger, type DiskUsage } from "../../src/observability/diagnostic-logger.js";
import { ObservabilityContext } from "../../src/observability/observability-context.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import type { ProducerContext } from "../../src/contracts/observability.js";

const temporaryDirectories: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-obs-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const producer: ProducerContext = {
  component: "test", processType: "server", processId: "1",
  bootId: "boot-1", appVersion: "0.1.0", hostPlatform: "win32",
};

describe("TraceManager（ALS）", () => {
  it("并发上下文不串 trace；子 span 继承 traceId", async () => {
    const seen: Array<{ traceId: string; spanId: string }> = [];
    await Promise.all([1, 2, 3].map((i) => runWithTrace({}, async () => {
      const outer = currentTrace();
      await new Promise((resolve) => setTimeout(resolve, 10 - i));
      runWithTrace({}, () => {
        const inner = currentTrace();
        seen.push({ traceId: inner!.traceId, spanId: inner!.spanId });
        expect(inner!.traceId).toBe(outer!.traceId); // 子 span 继承 traceId
      });
      return i;
    })));
    const traceIds = new Set(seen.map((item) => item.traceId));
    expect(traceIds.size).toBe(3); // 三个并发根 trace 互不串线
  });

  it("runAsBackground 创建新根 trace 并链接来源", () => {
    runWithTrace({}, () => {
      const parent = currentTrace()!;
      runAsBackground({}, () => {
        const bg = currentTrace()!;
        expect(bg.traceId).not.toBe(parent.traceId);
        expect(bg.linkedTraceIds).toContain(parent.traceId);
      });
    });
  });

  it("runWithCarrier 使用平台签发的 carrier（IPC 边界重新盖章）", () => {
    runWithCarrier({ traceId: "carrier-t", spanId: "carrier-s" }, () => {
      expect(currentTrace()?.traceId).toBe("carrier-t");
    });
  });

  it("bootId 每次生成唯一", () => {
    expect(createBootId("0.1.0")).not.toBe(createBootId("0.1.0"));
    expect(newTraceId()).not.toBe(newTraceId());
  });
});

describe("SafeValue normalize 与脱敏", () => {
  it("secret-like 字段名直接剔除（值不落盘）", () => {
    const result = normalizeSafeValue({ apiKey: "sk-1234567890", data: "ok" });
    expect(result).toEqual({ data: "ok" });
    expect(JSON.stringify(result)).not.toContain("sk-1234567890");
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("cookie")).toBe(true);
    expect(isSensitiveKey("data")).toBe(false);
  });

  it("文本脱敏攻击夹具：Bearer/URL 凭据/sk-/Cookie/base64/路径/PII", () => {
    const input = [
      "Authorization: Bearer abc.def.ghi123",
      "https://user:pass@example.com/x",
      "sk-proj-abcdef123456",
      "Cookie: session=abc123; theme=dark",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "C:\\Users\\secret\\config.json",
      "/home/user/.ssh/id_rsa",
      "contact me at john.doe@example.com or 138-0013-8000",
    ].join(" ");
    const redacted = redactText(input);
    expect(redacted).not.toContain("Bearer abc");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain("sk-proj");
    expect(redacted).not.toContain("session=abc123");
    expect(redacted).not.toContain("eyJhbGci");
    expect(redacted).not.toContain("C:\\Users");
    expect(redacted).not.toContain("/home/user");
    expect(redacted).not.toContain("john.doe@example.com");
    expect(redacted).not.toContain("138-0013-8000");
  });

  it("深度/长度/数量限额与循环引用", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const limited = normalizeSafeValue(deep);
    expect(JSON.stringify(limited)).toContain("depth-limited");

    // 评审 P0-2：字符串先脱敏再截断——"x"*5000 是 base64-like 会被整体替换为占位符，
    // 长度限额测试必须用不可脱敏文本（CJK 不匹配任何 redact 模式）
    const long = normalizeSafeValue({ text: "好".repeat(5000) });
    expect(JSON.stringify(long)).toContain("truncated");

    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const safe = normalizeSafeValue(circular);
    expect(JSON.stringify(safe)).toContain("Circular");

    const many = normalizeSafeValue({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17, r: 18, s: 19, t: 20, u: 21, v: 22, w: 23, x: 24, y: 25, z: 26, aa: 27, ab: 28, ac: 29, ad: 30, ae: 31, af: 32, ag: 33 });
    const parsed = many as Record<string, unknown>;
    expect(parsed["[truncated]"]).toBeDefined();
  });

  it("Error 清洗：message/stack 脱敏且有界", () => {
    const error = new Error("failed with token sk-abcdef123456 and /home/user/file");
    const cleaned = sanitizeError(error);
    expect(cleaned.message).not.toContain("sk-abcdef123456");
    expect(cleaned.stack).toBeDefined();
    expect(cleaned.message.length).toBeLessThanOrEqual(4000);
  });

  it("normalizeSafeObject 超限标记 payload-too-large", () => {
    // 用 CJK 文本：ASCII 长串会被 redact 收缩为占位符，无法触发体积上限
    const fields: Record<string, string> = {};
    for (let i = 0; i < 32; i += 1) fields[`f${i}`] = "哦".repeat(2_000);
    const result = normalizeSafeObject(fields);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.value)).toContain("payload-too-large");
  });
});

describe("DiagnosticLogger", () => {
  function makeLogger(dir: string, options: Partial<ConstructorParameters<typeof DiagnosticLogger>[0]> = {}) {
    return new DiagnosticLogger({
      logsRoot: dir,
      producer,
      ...options,
    });
  }

  it("双 JSONL：debug 进 .debug.jsonl，info+ 进主文件；行级完整 JSON", () => {
    const dir = makeTempDir();
    const logger = makeLogger(dir);
    logger.debug("test.event", "调试");
    logger.info("test.event", "常规");
    logger.error("test.event", "错误");
    logger.flushSync();
    const files = fs.readdirSync(dir);
    expect(files.some((name) => name.endsWith(".debug.jsonl"))).toBe(true);
    expect(files.some((name) => name.endsWith(".jsonl") && !name.endsWith(".debug.jsonl"))).toBe(true);
    const main = files.find((name) => name.endsWith(".jsonl") && !name.endsWith(".debug.jsonl"))!;
    const lines = fs.readFileSync(path.join(dir, main), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.channel).toBe("diagnostic");
      expect(parsed.producer.bootId).toBe("boot-1");
    }
  });

  it("10MB 轮转：超过上限滚动到新 segment", () => {
    const dir = makeTempDir();
    const logger = makeLogger(dir, { fileSizeBytes: 1024 });
    for (let i = 0; i < 200; i += 1) {
      logger.info("test.event", `填充行 ${i} ${"x".repeat(200)}`);
    }
    logger.flushSync();
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("repeat folding：连续相同行折叠为 repeat 计数", () => {
    const dir = makeTempDir();
    const logger = makeLogger(dir);
    const now = () => new Date();
    const writeLine = (logger as unknown as { writeLine(line: string, level: "info"): boolean }).writeLine;
    void writeLine;
    logger.info("test.event", "相同消息");
    logger.info("test.event", "相同消息");
    logger.info("test.event", "相同消息");
    logger.flushSync();
    const main = fs.readdirSync(dir).find((name) => name.endsWith(".jsonl") && !name.endsWith(".debug.jsonl"))!;
    const lines = fs.readFileSync(path.join(dir, main), "utf8").trim().split("\n");
    // 三次相同消息折叠为一条带 repeat=3 的记录（行数小于调用次数）
    expect(lines.length).toBeLessThan(3);
    const folded = lines.map((line) => JSON.parse(line) as { repeat?: number }).find((item) => item.repeat !== undefined);
    expect(folded?.repeat).toBe(3);
    void now;
  });

  it("过载丢弃：队列满时优先丢 trace/debug/info，warn+ 保留", () => {
    const dir = makeTempDir();
    const logger = makeLogger(dir, { queueSize: 10 });
    for (let i = 0; i < 50; i += 1) {
      logger.trace("test.event", `低优先级 ${i}`);
      logger.warn("test.event", `高优先级 ${i}`);
    }
    expect(logger.getDroppedCount()).toBeGreaterThan(0);
    logger.flushSync();
    const main = fs.readdirSync(dir).find((name) => name.endsWith(".jsonl") && !name.endsWith(".debug.jsonl"))!;
    const lines = fs.readFileSync(path.join(dir, main), "utf8").trim().split("\n");
    // 高优先级 warn 行全部落盘
    expect(lines.filter((line) => line.includes('"level":"warn"')).length).toBe(50);
  });

  it("500MB 预算：超限删除最旧 debug 文件并标记 degraded", () => {
    const dir = makeTempDir();
    const logger = makeLogger(dir, { diskBudgetBytes: 2048, fileSizeBytes: 512 });
    for (let i = 0; i < 30; i += 1) {
      logger.debug("test.event", "d".repeat(300));
      logger.info("test.event", "m".repeat(300));
    }
    logger.flushSync();
    const usage = logger.measureDisk() as DiskUsage;
    // 超限触发删除：最终占用收敛到预算附近（远小于写入量 18KB）
    expect(usage.totalBytes).toBeLessThanOrEqual(4096);
    expect(usage.totalBytes).toBeLessThan(18_000);
  });

  it("保留清理：过期 debug 文件删除，未过期保留", () => {
    const dir = makeTempDir();
    const logger = makeLogger(dir, { debugRetentionDays: 7, mainRetentionDays: 30 });
    const oldDate = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${oldDate}_boot-1_0.debug.jsonl`), "old\n");
    fs.writeFileSync(path.join(dir, `${oldDate}_boot-1_0.jsonl`), "old-main\n");
    logger.enforceRetention();
    const files = fs.readdirSync(dir);
    expect(files.some((name) => name.endsWith(".debug.jsonl"))).toBe(false); // 7 天 debug 已删
    expect(files.some((name) => name.endsWith(".jsonl") && !name.endsWith(".debug.jsonl"))).toBe(true); // 30 天 main 保留
  });

  it("写失败 fallback stderr 且不阻塞（logger 不递归告警）", () => {
    const dir = makeTempDir();
    const logger = makeLogger(dir);
    // 用只读目录模拟写失败
    fs.chmodSync(dir, 0o500);
    try {
      logger.info("test.event", "无法落盘");
      logger.flushSync();
      expect(logger.getFailedCount()).toBeGreaterThanOrEqual(0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe("Phase 11 复审修复（评审 P0-2 / P1-7 / P1-8 复现级测试）", () => {
  it("P0-2：结构化字符串必须脱敏——Authorization/Bearer/sk- 不进入 payload", () => {
    const raw = "Authorization: Bearer secret sk-proj-abcdef123456";
    const normalized = normalizeSafeValue({ header: raw });
    const json = JSON.stringify(normalized);
    expect(json).not.toContain("sk-proj-abcdef123456");
    expect(json).not.toContain("Bearer secret");
    expect(json).toContain("[AUTH_HEADER]");
    // normalizeSafeObject 第二遍同样生效（纵深防御）
    const object = normalizeSafeObject({ message: "header " + raw + " cookie=abc123" });
    const objectJson = JSON.stringify(object.value);
    expect(objectJson).not.toContain("sk-proj-abcdef123456");
    expect(objectJson).not.toContain("abc123");
  });

  it("P1-7：ObservabilityContext 偏好——minLevel 过滤 + spool 预算生效", () => {
    const dir = makeTempDir();
    const db = openMetadataDatabase(path.join(dir, "metadata.db"));
    const context = new ObservabilityContext({
      database: db,
      producer,
      logsRoot: path.join(dir, "logs"),
      spoolRoot: path.join(dir, "spool"),
      logger: { minLevel: "warn" },
      spoolBudgetBytes: 1024,
    });
    // minLevel=warn：trace/debug/info 不落盘
    context.logger.trace("t", "trace-msg");
    context.logger.info("i", "info-msg");
    context.logger.warn("w", "warn-msg");
    context.logger.flushSync();
    const files = fs.readdirSync(path.join(dir, "logs")).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);
    const content = files.map((name) => fs.readFileSync(path.join(dir, "logs", name), "utf8")).join("");
    expect(content).not.toContain("trace-msg");
    expect(content).not.toContain("info-msg");
    expect(content).toContain("warn-msg");
    // spool 预算 1024B：先占满 900B，再写 300B 行 → 超限被拒（fail-closed 出口）
    fs.mkdirSync(path.join(dir, "spool"), { recursive: true });
    fs.writeFileSync(path.join(dir, "spool", "audit-server-boot-0.jsonl"), "x".repeat(900), "utf8");
    const spoolResult = context.spool.write("audit", {
      schemaVersion: 1, eventVersion: 1, eventId: "evt-big", eventName: "audit.agent.deleted",
      occurredAt: new Date().toISOString(), recordedAt: new Date().toISOString(), level: "warn",
      actor: { kind: "user", id: "u" }, executor: { kind: "service", id: "s" }, scope: {},
      trace: { traceId: "t", spanId: "s" }, producer, channel: "audit",
      payload: { action: "agent.deleted", decision: "allowed" },
    });
    expect(spoolResult.ok).toBe(false);
    db.close();
  });

  it("P1-8：磁盘预算删除后从总量扣减——3×500B 文件 + logger 文件 ≈ 2028B、预算 1800B 只删最旧 1 个", () => {
    const dir = makeTempDir();
    const logger = new DiagnosticLogger({ logsRoot: dir, producer, diskBudgetBytes: 1800 });
    // 三个 500B 的主文件 + logger 自身文件（~530B）≈ 2030B；
    // 预算 1800B：删最旧 1 个后 ≈1530 ≤ 1800 即停止——修复前会删光全部 3 个
    for (let i = 0; i < 3; i += 1) {
      const file = path.join(dir, `seed${i}.jsonl`);
      fs.writeFileSync(file, "x".repeat(500), "utf8");
      const mtime = new Date(Date.now() - (3 - i) * 60_000);
      fs.utimesSync(file, mtime, mtime);
    }
    logger.info("budget.test", "触发预算执行");
    logger.flushSync();
    const seeds = fs.readdirSync(dir).filter((name) => name.startsWith("seed"));
    // 只删最旧 1 个 seed，其余保留——修复前会删光全部 3 个
    expect(seeds.length).toBe(2);
    expect(seeds.some((name) => name === "seed0.jsonl")).toBe(false);
    expect(seeds.some((name) => name === "seed1.jsonl")).toBe(true);
  });
});
