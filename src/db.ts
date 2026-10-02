import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export function openDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      dhash TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (collection_id, sha256)
    );
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
      original_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT,
      status TEXT NOT NULL CHECK (status IN ('imported', 'duplicate', 'failed')),
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('stored', 'upload')),
      source_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
      query_sha256 TEXT NOT NULL,
      query_dhash TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      limit_n INTEGER NOT NULL,
      result_count INTEGER NOT NULL,
      results_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
