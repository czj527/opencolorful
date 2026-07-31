import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { applyMigrations } from "./migrations.js";

export function openMetadataDatabase(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    applyMigrations(database);
  } catch (error) {
    // 迁移失败（如更高版本 schema）必须关闭句柄，否则调用方无法清理/重试
    database.close();
    throw error;
  }
  return database;
}
