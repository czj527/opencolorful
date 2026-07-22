import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMetadataDatabase } from "../../src/storage/database.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations.js";
import { SessionIndex } from "../../src/storage/session-index.js";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "person-agent-storage-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "metadata.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("session metadata index", () => {
  it("enables WAL and applies migrations idempotently", () => {
    const databasePath = createDatabasePath();
    const first = openMetadataDatabase(databasePath);

    expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(first.prepare("SELECT version FROM schema_version").pluck().get()).toBe(CURRENT_SCHEMA_VERSION);
    first.close();

    const reopened = openMetadataDatabase(databasePath);
    expect(reopened.prepare("SELECT version FROM schema_version").pluck().get()).toBe(CURRENT_SCHEMA_VERSION);
    reopened.close();
  });

  it("persists session metadata after close and reopen", () => {
    const databasePath = createDatabasePath();
    const first = openMetadataDatabase(databasePath);
    const index = new SessionIndex(first);

    index.create({
      id: "session-1",
      title: "第一段会话",
      sessionPath: "sessions/session-1.jsonl",
      createdAt: "2026-07-21T15:00:00.000Z",
    });
    first.close();

    const reopened = openMetadataDatabase(databasePath);
    expect(new SessionIndex(reopened).get("session-1")).toMatchObject({
      id: "session-1",
      title: "第一段会话",
      archived: false,
      toolMode: "off",
    });
    reopened.close();
  });

  it("touches sessions and excludes archived sessions by default", () => {
    const database = openMetadataDatabase(createDatabasePath());
    const index = new SessionIndex(database);
    index.create({
      id: "session-1",
      title: "会话",
      sessionPath: "sessions/session-1.jsonl",
      createdAt: "2026-07-21T15:00:00.000Z",
    });

    index.touch("session-1", "2026-07-21T16:00:00.000Z");
    expect(index.get("session-1")?.updatedAt).toBe("2026-07-21T16:00:00.000Z");

    index.archive("session-1", "2026-07-21T17:00:00.000Z");
    expect(index.list()).toEqual([]);
    expect(index.list({ includeArchived: true })[0]).toMatchObject({ archived: true });
    database.close();
  });

  it("enforces unique session ids and never creates a messages table", () => {
    const database = openMetadataDatabase(createDatabasePath());
    const index = new SessionIndex(database);
    const input = {
      id: "session-1",
      title: "会话",
      sessionPath: "sessions/session-1.jsonl",
      createdAt: "2026-07-21T15:00:00.000Z",
    };

    index.create(input);
    expect(() => index.create(input)).toThrow();
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all(),
    ).not.toContain("messages");
    database.close();
  });
});
