import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface CollectionRow {
  id: number;
  name: string;
  created_at: string;
}

export interface ImageRow {
  id: number;
  collection_id: number;
  sha256: string;
  dhash: string;
  width: number;
  height: number;
  file_size: number;
  original_name: string;
  stored_path: string;
  created_at: string;
}

export interface QueryResultRow {
  image_id: number;
  sha256: string;
  dhash: string;
  original_name: string;
  width: number;
  height: number;
  file_size: number;
  distance: number;
  match_type: 'identical' | 'similar';
  rank: number;
}

export const openDatabase = (dbPath: string): DatabaseSync => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
};

const migrate = (db: DatabaseSync): void => {
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
      file_size INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (collection_id, sha256)
    );

    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('imported','duplicate','failed')),
      image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      query_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
      query_sha256 TEXT NOT NULL,
      query_dhash TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      limit_count INTEGER NOT NULL,
      include_self INTEGER NOT NULL,
      result_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS query_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id INTEGER NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      distance INTEGER NOT NULL,
      match_type TEXT NOT NULL CHECK (match_type IN ('identical','similar')),
      rank INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_images_collection ON images(collection_id);
    CREATE INDEX IF NOT EXISTS idx_imports_collection ON imports(collection_id);
    CREATE INDEX IF NOT EXISTS idx_queries_collection ON queries(collection_id);
  `);
};
