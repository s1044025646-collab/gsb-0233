import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { AppConfig } from './config';
import { AppError, badArg, notFound } from './errors';
import { computeDHash, hammingDistance } from './dhash';
import { decodePng } from './pngutil';

export interface ImageRow {
  id: number;
  collection_id: number;
  sha256: string;
  dhash: string;
  width: number;
  height: number;
  size_bytes: number;
  original_name: string;
  stored_path: string;
  created_at: string;
}

export interface QueryResultItem {
  imageId: number;
  originalName: string;
  sha256: string;
  dhash: string;
  distance: number;
  byteIdentical: boolean;
  matchType: 'byte-identical' | 'perceptual';
}

export class Store {
  constructor(
    public readonly db: Database.Database,
    public readonly config: AppConfig,
  ) {}

  // ---------- collections ----------
  createCollection(name: string) {
    if (!name || !name.trim()) throw badArg('集合名称不能为空');
    try {
      const info = this.db
        .prepare('INSERT INTO collections (name) VALUES (?)')
        .run(name.trim());
      return this.getCollection(Number(info.lastInsertRowid));
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) {
        throw new AppError('INVALID_ARGUMENT', `集合名称已存在：${name}`, 409);
      }
      throw e;
    }
  }

  listCollections() {
    return this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM images i WHERE i.collection_id = c.id) AS image_count
         FROM collections c ORDER BY c.id`,
      )
      .all();
  }

  getCollection(idOrName: number | string) {
    const row =
      typeof idOrName === 'number'
        ? this.db.prepare('SELECT * FROM collections WHERE id = ?').get(idOrName)
        : this.db.prepare('SELECT * FROM collections WHERE name = ?').get(idOrName);
    if (!row) throw notFound(`集合不存在：${idOrName}`);
    return row as { id: number; name: string; created_at: string };
  }

  // ---------- import ----------
  /**
   * 导入一张 PNG：复制字节到数据目录并写入元数据。
   * 同一集合内 sha256 已存在时不重复复制，记录 status='duplicate' 并返回已存在图片。
   * 文件写盘失败时不会留下可查询的数据库记录。
   */
  importImage(collectionId: number, buf: Buffer, originalName: string) {
    this.getCollection(collectionId);
    if (!buf || buf.length === 0) throw badArg('文件内容为空');
    if (buf.length > this.config.maxFileBytes) {
      throw new AppError(
        'FILE_TOO_LARGE',
        `文件大小 ${buf.length} 超过上限 ${this.config.maxFileBytes} 字节`,
        413,
      );
    }
    const decoded = decodePng(buf); // 损坏时抛 INVALID_PNG
    if (
      decoded.width > this.config.maxDimension ||
      decoded.height > this.config.maxDimension
    ) {
      throw new AppError(
        'DIMENSIONS_TOO_LARGE',
        `图片尺寸 ${decoded.width}x${decoded.height} 超过上限 ${this.config.maxDimension}`,
        413,
      );
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const name = originalName && originalName.trim() ? originalName.trim() : 'unnamed.png';

    const existing = this.db
      .prepare('SELECT * FROM images WHERE collection_id = ? AND sha256 = ?')
      .get(collectionId, sha256) as ImageRow | undefined;
    if (existing) {
      const imp = this.db
        .prepare(
          `INSERT INTO imports (collection_id, image_id, original_name, size_bytes, sha256, status, message)
           VALUES (?, ?, ?, ?, ?, 'duplicate', ?)`,
        )
        .run(collectionId, existing.id, name, buf.length, sha256, '字节相同，已去重');
      return {
        image: existing,
        importId: Number(imp.lastInsertRowid),
        status: 'duplicate' as const,
      };
    }

    const { hex: dhash } = computeDHash(decoded);
    const dir = path.join(this.config.dataDir, 'images', String(collectionId));
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, `${sha256}.png`);
    // 先写文件，成功后才写数据库；数据库失败时清理文件，避免假记录。
    fs.writeFileSync(storedPath, buf, { flag: 'wx' });
    let imageId: number;
    try {
      const info = this.db
        .prepare(
          `INSERT INTO images (collection_id, sha256, dhash, width, height, size_bytes, original_name, stored_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(collectionId, sha256, dhash, decoded.width, decoded.height, buf.length, name, storedPath);
      imageId = Number(info.lastInsertRowid);
    } catch (e) {
      fs.rmSync(storedPath, { force: true });
      throw e;
    }
    const imp = this.db
      .prepare(
        `INSERT INTO imports (collection_id, image_id, original_name, size_bytes, sha256, status)
         VALUES (?, ?, ?, ?, ?, 'imported')`,
      )
      .run(collectionId, imageId, name, buf.length, sha256);
    return {
      image: this.getImage(imageId),
      importId: Number(imp.lastInsertRowid),
      status: 'imported' as const,
    };
  }

  // ---------- images ----------
  getImage(id: number): ImageRow {
    const row = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as
      | ImageRow
      | undefined;
    if (!row) throw notFound(`图片不存在：${id}`);
    return row;
  }

  listImages(collectionId: number): ImageRow[] {
    this.getCollection(collectionId);
    return this.db
      .prepare('SELECT * FROM images WHERE collection_id = ? ORDER BY id')
      .all(collectionId) as ImageRow[];
  }

  listImports(collectionId: number) {
    this.getCollection(collectionId);
    return this.db
      .prepare('SELECT * FROM imports WHERE collection_id = ? ORDER BY id')
      .all(collectionId);
  }

  // ---------- query ----------
  /**
   * 在同一集合内查询近似图片。
   * - source 为 'stored' 时以已导入图片为查询图，结果默认排除其自身；
   * - source 为 'upload' 时查询图仅用于计算，不写入图片表。
   * 结果按 (distance, imageId) 升序，限制数量，并区分字节相同与感知近似。
   */
  querySimilar(params: {
    collectionId: number;
    source: 'stored' | 'upload';
    imageId?: number;
    uploadBuffer?: Buffer;
    threshold?: number;
    limit?: number;
  }) {
    const collection = this.getCollection(params.collectionId);
    const threshold = params.threshold ?? this.config.defaultThreshold;
    const limit = params.limit ?? this.config.defaultLimit;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) {
      throw badArg('threshold 必须是 0..64 的整数');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.maxLimit) {
      throw badArg(`limit 必须是 1..${this.config.maxLimit} 的整数`);
    }

    let querySha: string;
    let queryDhash: string;
    let sourceImageId: number | null = null;

    if (params.source === 'stored') {
      if (params.imageId === undefined) throw badArg('缺少 imageId');
      const img = this.getImage(params.imageId);
      if (img.collection_id !== collection.id) {
        throw badArg(`图片 ${img.id} 不属于集合 ${collection.id}，不允许跨集合查询`);
      }
      querySha = img.sha256;
      queryDhash = img.dhash;
      sourceImageId = img.id;
    } else {
      if (!params.uploadBuffer || params.uploadBuffer.length === 0) {
        throw badArg('缺少上传的 PNG 内容');
      }
      if (params.uploadBuffer.length > this.config.maxFileBytes) {
        throw new AppError('FILE_TOO_LARGE', '上传文件超过大小上限', 413);
      }
      const decoded = decodePng(params.uploadBuffer);
      if (
        decoded.width > this.config.maxDimension ||
        decoded.height > this.config.maxDimension
      ) {
        throw new AppError('DIMENSIONS_TOO_LARGE', '上传图片尺寸超过上限', 413);
      }
      querySha = crypto.createHash('sha256').update(params.uploadBuffer).digest('hex');
      queryDhash = computeDHash(decoded).hex;
    }

    const candidates = this.listImages(collection.id);
    const results: QueryResultItem[] = [];
    for (const img of candidates) {
      if (sourceImageId !== null && img.id === sourceImageId) continue; // 不返回自身
      const distance = hammingDistance(queryDhash, img.dhash);
      if (distance > threshold) continue;
      const byteIdentical = img.sha256 === querySha;
      results.push({
        imageId: img.id,
        originalName: img.original_name,
        sha256: img.sha256,
        dhash: img.dhash,
        distance,
        byteIdentical,
        matchType: byteIdentical ? 'byte-identical' : 'perceptual',
      });
    }
    results.sort((a, b) => a.distance - b.distance || a.imageId - b.imageId);
    const limited = results.slice(0, limit);

    const info = this.db
      .prepare(
        `INSERT INTO queries (collection_id, source, source_image_id, query_sha256, query_dhash, threshold, limit_n, result_count, results_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        collection.id,
        params.source,
        sourceImageId,
        querySha,
        queryDhash,
        threshold,
        limit,
        limited.length,
        JSON.stringify(limited),
      );
    return {
      queryId: Number(info.lastInsertRowid),
      collectionId: collection.id,
      threshold,
      limit,
      querySha256: querySha,
      queryDhash,
      resultCount: limited.length,
      results: limited,
    };
  }

  getQuery(queryId: number) {
    const row = this.db.prepare('SELECT * FROM queries WHERE id = ?').get(queryId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw notFound(`查询记录不存在：${queryId}`);
    return { ...row, results: JSON.parse(row.results_json as string) };
  }

  listQueries(collectionId: number) {
    this.getCollection(collectionId);
    return this.db
      .prepare(
        'SELECT id, collection_id, source, source_image_id, threshold, limit_n, result_count, created_at FROM queries WHERE collection_id = ? ORDER BY id',
      )
      .all(collectionId);
  }

  /** 导出查询报告（JSON 或 Markdown 文本）。 */
  exportQuery(queryId: number, format: 'json' | 'md'): string {
    const q = this.getQuery(queryId) as unknown as {
      id: number;
      collection_id: number;
      source: string;
      source_image_id: number | null;
      query_sha256: string;
      query_dhash: string;
      threshold: number;
      limit_n: number;
      result_count: number;
      created_at: string;
      results: QueryResultItem[];
    };
    if (format === 'json') {
      const { results, ...rest } = q;
      return JSON.stringify({ ...rest, results }, null, 2);
    }
    const lines = [
      `# 近似重复查询报告 #${q.id}`,
      ``,
      `- 集合 ID：${q.collection_id}`,
      `- 查询来源：${q.source}${q.source_image_id ? `（图片 #${q.source_image_id}）` : ''}`,
      `- 查询 SHA-256：\`${q.query_sha256}\``,
      `- 查询 dHash：\`${q.query_dhash}\``,
      `- 阈值：${q.threshold}，数量上限：${q.limit_n}，命中：${q.result_count}`,
      `- 时间：${q.created_at}`,
      ``,
      `| 排名 | 图片 ID | 距离 | 类型 | 原文件名 | dHash |`,
      `| --- | --- | --- | --- | --- | --- |`,
      ...q.results.map(
        (r, i) =>
          `| ${i + 1} | ${r.imageId} | ${r.distance} | ${r.byteIdentical ? '字节相同' : '感知近似'} | ${r.originalName} | \`${r.dhash}\` |`,
      ),
      ``,
      `> 说明：感知近似仅为候选，距离小不代表内容必然相同，需人工确认。`,
    ];
    return lines.join('\n');
  }
}
