import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getRuntimePaths } from "../../src/config/paths.js";
import { SessionService } from "../../src/runtime/session-service.js";
import { openMetadataDatabase } from "../../src/storage/database.js";
import { SessionIndex } from "../../src/storage/session-index.js";

// ═══════════════════════════════════════════════════════════════
// P1 审计修复（§10-3）：Fork JSONL/SQLite 对账与孤儿清理。
// 缺陷：forkSession 先写 JSONL、后写 SQLite——同进程索引失败已有补偿，
// 但跨进程崩溃（JSONL 已落、索引行未落）残留孤儿文件。修复：
// 1. 索引失败补偿删除（AggregateError 聚合清理失败）；
// 2. 启动期 reconcileOrphanForks：只删"parentSession 仍被索引 + 自身无行
//    （路径/会话 id 双查）+ 位于受控平面 sessions 目录"的 fork 残留；
//    索引缺失/损坏（全库无行）时零删除，JSONL 唯一事实源不误伤。
// ═══════════════════════════════════════════════════════════════

const temporaryDirectories: string[] = [];
const openDatabases: ReturnType<typeof openMetadataDatabase>[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    try { database.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

interface Fixture {
  readonly paths: ReturnType<typeof getRuntimePaths>;
  readonly database: ReturnType<typeof openMetadataDatabase>;
  readonly index: SessionIndex;
  readonly service: SessionService;
  /** 模拟"索引失败"的可注入索引（create 可切换为抛错） */
  setIndexCreateFailure(fail: boolean): void;
}

function createFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencolorful-fork-reconcile-"));
  temporaryDirectories.push(directory);
  const paths = getRuntimePaths({ OPENCOLORFUL_HOME: directory });
  fs.mkdirSync(paths.sessions, { recursive: true });
  const database = openMetadataDatabase(paths.database);
  openDatabases.push(database);
  const index = new SessionIndex(database);
  const service = new SessionService(paths, index);
  let failCreate = false;
  const originalCreate = index.create.bind(index);
  index.create = ((input: Parameters<SessionIndex["create"]>[0]) => {
    if (failCreate) throw new Error("模拟 SQLite 索引写入失败");
    return originalCreate(input);
  }) as SessionIndex["create"];
  return {
    paths,
    database,
    index,
    service,
    setIndexCreateFailure(fail: boolean) {
      failCreate = fail;
    },
  };
}

function listSessionFiles(home: string): string[] {
  return fs
    .readdirSync(path.join(home, "sessions"), { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".jsonl"))
    .map((dirent) => dirent.name)
    .sort();
}

function readHeader(sessionPath: string): { id: string; parentSession?: string } {
  const firstLine = fs.readFileSync(sessionPath, "utf8").split("\n", 1)[0] ?? "";
  return JSON.parse(firstLine) as { id: string; parentSession?: string };
}

/** 绕过 service，手工构造一个"JSONL 已写、索引无行"的 fork 残留（parentSession 指向源） */
function plantOrphanFork(sourcePath: string): string {
  const orphanId = `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = fs
    .readFileSync(sourcePath, "utf8")
    .split("\n")
    .filter((line) => {
      if (line.trim() === "") return false;
      try {
        return (JSON.parse(line) as { type?: string }).type !== "session";
      } catch {
        return true;
      }
    })
    .join("\n");
  const orphanPath = path.join(path.dirname(sourcePath), `manual_${orphanId}.jsonl`);
  const header = {
    type: "session",
    version: 2,
    id: orphanId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    parentSession: sourcePath,
  };
  fs.writeFileSync(orphanPath, `${JSON.stringify(header)}\n${body}\n`, "utf8");
  return orphanPath;
}

describe("Fork 索引失败补偿（同进程）", () => {
  it("索引写入失败：fork 抛错且刚创建的 JSONL 被补偿删除，源会话不受影响", () => {
    const fixture = createFixture();
    const source = fixture.service.create({ title: "源会话", cwd: process.cwd() });
    source.appendUserMessage("源提问");
    source.appendAssistantMessage("源回答");
    source.persist();
    const sourcePath = source.path;
    const filesBefore = listSessionFiles(fixture.paths.home);

    fixture.setIndexCreateFailure(true);
    try {
      expect(() => fixture.service.forkSession(source.id)).toThrow();
    } finally {
      fixture.setIndexCreateFailure(false);
    }

    // 没有新增文件：fork 产物已被补偿删除；源会话仍在
    expect(listSessionFiles(fixture.paths.home)).toEqual(filesBefore);
    expect(fs.existsSync(sourcePath)).toBe(true);
    // 索引里只有源会话
    expect(fixture.index.list().map((metadata) => metadata.id)).toEqual([source.id]);
  });

  it("补偿删除失败：AggregateError 同时携带索引错误与清理错误", () => {
    const fixture = createFixture();
    const source = fixture.service.create({ title: "源会话", cwd: process.cwd() });
    source.appendUserMessage("源提问");
    source.appendAssistantMessage("源回答");
    source.persist();
    const sourcePath = source.path;

    fixture.setIndexCreateFailure(true);
    // 让 removeSessionFile 的 assertSessionPath 拒绝删除（模拟清理失败）
    const originalAssert = (
      fixture.service as unknown as { assertSessionPath(p: string): void }
    ).assertSessionPath.bind(fixture.service);
    (fixture.service as unknown as { assertSessionPath(p: string): void }).assertSessionPath = (
      sessionPath: string,
    ) => {
      const resolved = path.resolve(sessionPath);
      if (resolved !== path.resolve(sourcePath)) {
        throw new Error("模拟清理失败");
      }
      originalAssert(sessionPath);
    };
    try {
      let caught: unknown;
      try {
        fixture.service.forkSession(source.id);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(String(aggregate.errors[0])).toContain("模拟 SQLite 索引写入失败");
      expect(String(aggregate.errors[1])).toContain("模拟清理失败");
    } finally {
      fixture.setIndexCreateFailure(false);
      (fixture.service as unknown as { assertSessionPath(p: string): void }).assertSessionPath =
        originalAssert;
    }
  });
});

describe("启动期 Fork 孤儿对账（reconcileOrphanForks）", () => {
  function seedSource(fixture: Fixture): { id: string; path: string } {
    const source = fixture.service.create({ title: "源会话", cwd: process.cwd() });
    source.appendUserMessage("源提问");
    source.appendAssistantMessage("源回答");
    source.persist();
    return { id: source.id, path: source.path };
  }

  it("孤儿 fork 残留（parentSession 仍被索引）被清理；源会话与索引行不受影响", () => {
    const fixture = createFixture();
    const source = seedSource(fixture);
    const orphanPath = plantOrphanFork(source.path);
    expect(fs.existsSync(orphanPath)).toBe(true);

    const report = fixture.service.reconcileOrphanForks();
    expect(report.removed).toBe(1);
    expect(fs.existsSync(orphanPath)).toBe(false);
    // 源会话文件与索引行完好
    expect(fs.existsSync(source.path)).toBe(true);
    expect(fixture.index.get(source.id)).toBeDefined();
  });

  it("索引整体缺失/损坏（文件全无行）时零删除——JSONL 唯一事实源不误伤", () => {
    const fixture = createFixture();
    const source = seedSource(fixture);
    const orphanPath = plantOrphanFork(source.path);
    // 模拟库损坏：清空 sessions 索引行（含源会话）
    fixture.index.remove(source.id);
    expect(fixture.index.list({ includeArchived: true })).toHaveLength(0);

    const report = fixture.service.reconcileOrphanForks();
    expect(report.removed).toBe(0);
    expect(fs.existsSync(orphanPath)).toBe(true);
    expect(fs.existsSync(source.path)).toBe(true);
  });

  it("无 parentSession 的新建会话残留不被触碰", () => {
    const fixture = createFixture();
    const stray = `stray_${Date.now()}.jsonl`;
    const strayPath = path.join(fixture.paths.sessions, stray);
    fs.writeFileSync(
      strayPath,
      `${JSON.stringify({
        type: "session",
        version: 2,
        id: "stray-session-id",
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      })}\n`,
      "utf8",
    );

    const report = fixture.service.reconcileOrphanForks();
    expect(report.removed).toBe(0);
    expect(fs.existsSync(strayPath)).toBe(true);
  });

  it("parentSession 指向无索引行的源（源同样孤儿）时不删除", () => {
    const fixture = createFixture();
    const source = seedSource(fixture);
    const orphanPath = plantOrphanFork(source.path);
    // 源会话被手工从索引移除（例如源也是残留）——parentSession 不再被索引
    fixture.index.remove(source.id);

    const report = fixture.service.reconcileOrphanForks();
    expect(report.removed).toBe(0);
    expect(fs.existsSync(orphanPath)).toBe(true);
  });

  it("header 会话 id 已被索引占用（行路径不同）的文件不删除", () => {
    const fixture = createFixture();
    const source = seedSource(fixture);
    const sourceHeader = readHeader(source.path);
    // 构造一个 id 与源会话相同、路径不同的文件（双查保护）
    const clonePath = path.join(fixture.paths.sessions, `clone_${Date.now()}.jsonl`);
    fs.writeFileSync(
      clonePath,
      `${JSON.stringify({ ...sourceHeader, parentSession: source.path })}\n`,
      "utf8",
    );

    const report = fixture.service.reconcileOrphanForks();
    expect(report.removed).toBe(0);
    expect(fs.existsSync(clonePath)).toBe(true);
  });
});
