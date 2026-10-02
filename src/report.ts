import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { Store } from './store.js';

export interface Report {
  generatedAt: string;
  collection: { id: number; name: string };
  query: unknown;
  results: unknown[];
  notes: string[];
}

export const buildReport = (store: Store, collectionId: number, queryId: number): Report => {
  const collection = store.getCollection(collectionId);
  const query = store.db
    .prepare('SELECT * FROM queries WHERE id = ? AND collection_id = ?')
    .get(queryId, collectionId) as Record<string, unknown> | undefined;
  if (!query) {
    throw new AppError('NOT_FOUND', `查询记录 id=${queryId} 不存在于集合 id=${collectionId}`, 404);
  }
  const results = store.db
    .prepare(
      `SELECT qr.rank, qr.distance, qr.match_type,
              i.id AS image_id, i.sha256, i.dhash, i.original_name,
              i.width, i.height, i.file_size
       FROM query_results qr JOIN images i ON i.id = qr.image_id
       WHERE qr.query_id = ? ORDER BY qr.rank ASC`,
    )
    .all(queryId);
  return {
    generatedAt: new Date().toISOString(),
    collection: { id: collection.id, name: collection.name },
    query,
    results,
    notes: [
      'distance 为 64 位 dHash 的 Hamming 距离，仅表示感知近似候选。',
      'identical 表示 SHA-256 字节相同（此时距离必为 0）；similar 不代表内容必然相同。',
      '本报告不触发任何自动合并或删除。',
    ],
  };
};

export const exportReport = (
  store: Store,
  collectionId: number,
  queryId: number,
  outPath: string,
): string => {
  const report = buildReport(store, collectionId, queryId);
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(report, null, 2), 'utf8');
  return resolved;
};
