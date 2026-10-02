import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type DatabaseSync } from 'node:sqlite';
import { type AppConfig } from './config.js';
import { type ImageRow, type QueryResultRow, openDatabase } from './db.js';
import { AppError } from './errors.js';
import { analyzePng, hammingDistance, parseHashHex } from './image.js';

export interface Candidate extends QueryResultRow {}

export interface QueryInput {
  bytes: Buffer;
  originalName: string;
  threshold: number;
  limit: number;
  includeSelf: boolean;
  queryImageId?: number;
}

export interface QueryOutput {
  queryId: number;
  querySha256: string;
  queryDhash: string;
  threshold: number;
  count: number;
  results: Candidate[];
}

const sha256Hex = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

export class Store {
  readonly db: DatabaseSync;
  private closed = false;

  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(config.blobDir, { recursive: true });
    fs.mkdirSync(config.sampleDir, { recursive: true });
    this.db = openDatabase(config.dbPath);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  createCollection(name: string): { id: number; name: string; created_at: string } {
    const trimmed = name.trim();
    if (!/^[\w\-.一-龥]{1,64}$/u.test(trimmed)) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '集合名称长度需为 1-64，仅允许字母、数字、下划线、点、连字符与中文字符',
      );
    }
    try {
      const result = this.db.prepare('INSERT INTO collections (name) VALUES (?)').run(trimmed);
      return this.getCollection(Number(result.lastInsertRowid));
    } catch (err) {
      if (isUniqueError(err)) {
        throw new AppError('CONFLICT', `集合 "${trimmed}" 已存在`);
      }
      throw err;
    }
  }

  listCollections(): Array<{ id: number; name: string; created_at: string; image_count: number }> {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.created_at, COUNT(i.id) AS image_count
         FROM collections c
         LEFT JOIN images i ON i.collection_id = c.id
         GROUP BY c.id
         ORDER BY c.id ASC`,
      )
      .all() as Array<{ id: number; name: string; created_at: string; image_count: number }>;
  }

  getCollection(id: number): { id: number; name: string; created_at: string } {
    const row = this.db.prepare('SELECT id, name, created_at FROM collections WHERE id = ?').get(id) as
      | { id: number; name: string; created_at: string }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `集合 id=${id} 不存在`, 404);
    return row;
  }

  requireCollection(id: number): void {
    this.getCollection(id);
  }

  /**
   * 导入单张 PNG：
   * - 复制到 data/images/ 下，源文件不读取以外的任何操作；
   * - 同集合内 sha256 相同视为重复，不重复落盘、不新增图片记录，仅写 duplicate 导入记录；
   * - 落盘与落库在事务内完成，落盘失败/回滚时删除已写入的文件，绝不留下可查询假记录。
   */
  importImage(
    collectionId: number,
    bytes: Buffer,
    originalName: string,
  ): { status: 'imported' | 'duplicate'; image: ImageRow | null } {
    this.requireCollection(collectionId);
    const features = analyzePng(bytes, this.config);
    const sha = sha256Hex(bytes);
    const name = sanitizeName(originalName);

    const existing = this.db
      .prepare('SELECT * FROM images WHERE collection_id = ? AND sha256 = ?')
      .get(collectionId, sha) as ImageRow | undefined;
    if (existing) {
      this.db
        .prepare(
          `INSERT INTO imports (collection_id, sha256, status, image_id, original_name, file_size, reason)
           VALUES (?, ?, 'duplicate', ?, ?, ?, 'same sha-256 content already imported')`,
        )
        .run(collectionId, sha, existing.id, existing.original_name, bytes.length);
      return { status: 'duplicate', image: existing };
    }

    const storedDir = path.join(this.config.blobDir, String(collectionId));
    fs.mkdirSync(storedDir, { recursive: true });
    const storedPath = path.join(storedDir, `${sha}.png`);

    const writeFile = (): void => {
      try {
        fs.writeFileSync(storedPath, bytes, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw new AppError('STORAGE_ERROR', `保存图片失败: ${(err as Error).message}`, 500);
      }
    };

    let insertedId = 0;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      writeFile();
      const result = this.db
        .prepare(
          `INSERT INTO images
             (collection_id, sha256, dhash, width, height, file_size, original_name, stored_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          collectionId,
          sha,
          features.hashHex,
          features.width,
          features.height,
          bytes.length,
          name,
          storedPath,
        );
      insertedId = Number(result.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO imports (collection_id, sha256, status, image_id, original_name, file_size)
           VALUES (?, ?, 'imported', ?, ?, ?)`,
        )
        .run(collectionId, sha, insertedId, name, bytes.length);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 忽略回滚错误
      }
      if (insertedId === 0 && fs.existsSync(storedPath)) {
        try {
          fs.rmSync(storedPath, { force: true });
        } catch {
          // 删除失败不影响错误抛出
        }
      }
      if (err instanceof AppError) throw err;
      if (isUniqueError(err)) {
        throw new AppError('CONFLICT', '相同内容图片已被并发导入');
      }
      throw new AppError('STORAGE_ERROR', `导入失败: ${(err as Error).message}`, 500);
    }

    return { status: 'imported', image: this.getImage(collectionId, insertedId) };
  }

  getImage(collectionId: number, imageId: number): ImageRow {
    const row = this.db
      .prepare('SELECT * FROM images WHERE collection_id = ? AND id = ?')
      .get(collectionId, imageId) as ImageRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `图片 id=${imageId} 不存在于集合 id=${collectionId}`, 404);
    return row;
  }

  listImages(collectionId: number): ImageRow[] {
    this.requireCollection(collectionId);
    return this.db
      .prepare('SELECT * FROM images WHERE collection_id = ? ORDER BY id ASC')
      .all(collectionId) as unknown as ImageRow[];
  }

  listImports(collectionId: number, limit = 50): unknown[] {
    this.requireCollection(collectionId);
    return this.db
      .prepare(
        `SELECT id, sha256, status, image_id, original_name, file_size, reason, created_at
         FROM imports WHERE collection_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(collectionId, limit);
  }

  listQueries(collectionId: number, limit = 50): unknown[] {
    this.requireCollection(collectionId);
    return this.db
      .prepare(
        `SELECT id, query_image_id, query_sha256, query_dhash, threshold, limit_count,
                include_self, result_count, created_at
         FROM queries WHERE collection_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(collectionId, limit);
  }

  /**
   * 查询近似图片。仅在同一个集合内比对，全表计算 Hamming 距离（图片量为演示规模，
   * 不构建高级向量索引）。
   * 排序：distance ASC，随后 image_id ASC（稳定标识）。
   * distance=0 且 sha256 相同 -> identical；distance>0 -> similar。
   * includeSelf=false 时排除查询图自身（按 sha256 判定）。
   */
  querySimilar(collectionId: number, input: QueryInput): QueryOutput {
    this.requireCollection(collectionId);
    this.validateQueryParams(input);
    const features = analyzePng(input.bytes, this.config);
    const queryHash = parseHashHex(features.hashHex);
    const querySha = sha256Hex(input.bytes);
    const rows = this.listImages(collectionId);

    const candidates: Candidate[] = [];
    for (const row of rows) {
      if (!input.includeSelf && row.sha256 === querySha) continue;
      const distance = hammingDistance(queryHash, parseHashHex(row.dhash));
      if (distance > input.threshold) continue;
      candidates.push({
        image_id: row.id,
        sha256: row.sha256,
        dhash: row.dhash,
        original_name: row.original_name,
        width: row.width,
        height: row.height,
        file_size: row.file_size,
        distance,
        match_type: row.sha256 === querySha ? 'identical' : 'similar',
        rank: 0,
      });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.image_id - b.image_id);
    const limited = candidates.slice(0, input.limit);
    limited.forEach((item, index) => {
      item.rank = index + 1;
    });

    const queryResult = this.db
      .prepare(
        `INSERT INTO queries
           (collection_id, query_image_id, query_sha256, query_dhash, threshold,
            limit_count, include_self, result_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        collectionId,
        input.queryImageId ?? null,
        querySha,
        features.hashHex,
        input.threshold,
        input.limit,
        input.includeSelf ? 1 : 0,
        limited.length,
      );
    const queryId = Number(queryResult.lastInsertRowid);
    const insertResult = this.db.prepare(
      'INSERT INTO query_results (query_id, image_id, distance, match_type, rank) VALUES (?, ?, ?, ?, ?)',
    );
    for (const item of limited) {
      insertResult.run(queryId, item.image_id, item.distance, item.match_type, item.rank);
    }

    return {
      queryId,
      querySha256: querySha,
      queryDhash: features.hashHex,
      threshold: input.threshold,
      count: limited.length,
      results: limited,
    };
  }

  /** 使用集合内已导入图片作为查询图。 */
  queryByImageId(
    collectionId: number,
    imageId: number,
    params: { threshold: number; limit: number; includeSelf: boolean },
  ): QueryOutput {
    const image = this.getImage(collectionId, imageId);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(image.stored_path);
    } catch (err) {
      throw new AppError('STORAGE_ERROR', `读取已存储图片失败: ${(err as Error).message}`, 500);
    }
    return this.querySimilar(collectionId, {
      bytes,
      originalName: image.original_name,
      threshold: params.threshold,
      limit: params.limit,
      includeSelf: params.includeSelf,
      queryImageId: image.id,
    });
  }

  validateThreshold(threshold: number): void {
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > this.config.maxThreshold) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `distance 阈值必须是 0-${this.config.maxThreshold} 的整数`,
      );
    }
  }

  validateQueryParams(input: { threshold: number; limit: number }): void {
    this.validateThreshold(input.threshold);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > this.config.maxLimit) {
      throw new AppError('INVALID_ARGUMENT', `limit 必须是 1-${this.config.maxLimit} 的整数`);
    }
  }
}

const sanitizeName = (name: string): string => {
  const base = path.basename(name).trim();
  return base.length > 200 ? base.slice(-200) : base || 'unnamed.png';
};

const isUniqueError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (('code' in err &&
    ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      (err as { code?: number }).code === 2067)) ||
    ('message' in err &&
      typeof (err as { message?: unknown }).message === 'string' &&
      ((err as { message: string }).message.includes('UNIQUE constraint failed') ||
        (err as { message: string }).message.includes('constraint failed: UNIQUE'))));
