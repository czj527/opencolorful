import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { applyMigrations } from "./migrations.js";

export function openMetadataDatabase(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  applyMigrations(database);
  return database;
}
