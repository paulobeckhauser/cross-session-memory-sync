/**
 * Runtime-agnostic SQLite adapter.
 * Uses bun:sqlite when running under Bun, falls back to better-sqlite3 for Node.js.
 */

export interface SQLiteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

export function openDatabase(dbPath: string): SQLiteDatabase {
  if (isBun) {
    return openBunDatabase(dbPath);
  }
  return openBetterSqlite3Database(dbPath);
}

function openBunDatabase(dbPath: string): SQLiteDatabase {
  // Dynamic require to avoid bundler issues when not running in Bun
  const Database = require("bun:sqlite").default ?? require("bun:sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.query(sql);
      return {
        run: (...params: unknown[]) => {
          const result = stmt.run(...params);
          return { changes: result?.changes ?? 0 };
        },
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    transaction: <T>(fn: () => T) => db.transaction(fn),
    close: () => db.close(),
  };
}

function openBetterSqlite3Database(dbPath: string): SQLiteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    transaction: <T>(fn: () => T) => db.transaction(fn),
    close: () => db.close(),
  };
}
