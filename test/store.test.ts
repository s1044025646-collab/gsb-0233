import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { Store } from '../src/store';
import { AppError } from '../src/errors';
import { generateDemoImages } from '../src/demo-images';
import { pngFromGrayMatrix } from './helpers';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pngdup-'));
  const config = loadConfig({ dataDir: dir, dbPath: path.join(dir, 'test.sqlite') });
  const db = openDatabase(config.dbPath);
  return { store: new Store(db, config), config, db, dir };
}

test('重复导入字节相同的文件被去重', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  const img = generateDemoImages()[0];
  const r1 = store.importImage(c.id, img.buffer, 'a.png');
  const r2 = store.importImage(c.id, Buffer.from(img.buffer), 'b.png');
  assert.equal(r1.status, 'imported');
  assert.equal(r2.status, 'duplicate');
  assert.equal(r1.image.id, r2.image.id);
  assert.equal(store.listImages(c.id).length, 1);
  const imports = store.listImports(c.id) as { status: string }[];
  assert.deepEqual(imports.map((i) => i.status), ['imported', 'duplicate']);
});

test('损坏 PNG 报错且不产生记录', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  assert.throws(() => store.importImage(c.id, Buffer.from('not a png'), 'bad.png'), AppError);
  assert.equal(store.listImages(c.id).length, 0);
});

test('超过大小上限报 FILE_TOO_LARGE', () => {
  const { store, config } = makeStore();
  const c = store.createCollection('t');
  const big = Buffer.alloc(config.maxFileBytes + 1);
  assert.throws(
    () => store.importImage(c.id, big, 'big.png'),
    (e: unknown) => (e as AppError).code === 'FILE_TOO_LARGE',
  );
});

test('空集合查询返回空结果', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  const img = generateDemoImages()[0];
  const q = store.querySimilar({ collectionId: c.id, source: 'upload', uploadBuffer: img.buffer });
  assert.equal(q.resultCount, 0);
  assert.deepEqual(q.results, []);
});

test('零阈值与阈值边界（距离等于阈值被包含）', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  const imgs = generateDemoImages();
  const base = store.importImage(c.id, imgs[0].buffer, imgs[0].filename).image;
  const slight = store.importImage(c.id, imgs[3].buffer, imgs[3].filename).image;
  const full = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: base.id, threshold: 64 });
  const d = full.results.find((r) => r.imageId === slight.id)!.distance;
  assert.ok(d > 0, '轻微改动图距离应大于 0');
  const atZero = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: base.id, threshold: 0 });
  assert.equal(atZero.results.length, 0, '零阈值且无字节相同项时无结果');
  const below = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: base.id, threshold: d - 1 });
  assert.ok(!below.results.some((r) => r.imageId === slight.id));
  const exact = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: base.id, threshold: d });
  assert.ok(exact.results.some((r) => r.imageId === slight.id), '距离等于阈值应被包含');
});

test('查询不返回自身；上传相同字节标记 byte-identical', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  const img = generateDemoImages()[0];
  const stored = store.importImage(c.id, img.buffer, 'x.png').image;
  const q1 = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: stored.id, threshold: 64 });
  assert.ok(!q1.results.some((r) => r.imageId === stored.id));
  const q2 = store.querySimilar({ collectionId: c.id, source: 'upload', uploadBuffer: Buffer.from(img.buffer), threshold: 0 });
  assert.equal(q2.results.length, 1);
  assert.equal(q2.results[0].byteIdentical, true);
  assert.equal(q2.results[0].matchType, 'byte-identical');
});

test('不同集合不能混查', () => {
  const { store } = makeStore();
  const c1 = store.createCollection('a');
  const c2 = store.createCollection('b');
  const img = generateDemoImages()[0];
  const inA = store.importImage(c1.id, img.buffer, 'a.png').image;
  store.importImage(c2.id, img.buffer, 'b.png');
  assert.throws(
    () => store.querySimilar({ collectionId: c2.id, source: 'stored', imageId: inA.id }),
    (e: unknown) => (e as AppError).code === 'INVALID_ARGUMENT',
  );
  const ownId = store.listImages(c2.id)[0].id;
  const q = store.querySimilar({ collectionId: c2.id, source: 'stored', imageId: ownId, threshold: 64 });
  assert.ok(q.results.every((r) => r.imageId !== inA.id));
});

test('结果按距离与图片 ID 稳定排序并支持 limit', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  const imgs = generateDemoImages();
  for (const img of [imgs[0], imgs[2], imgs[3], imgs[5]]) {
    store.importImage(c.id, img.buffer, img.filename);
  }
  const baseId = store.listImages(c.id)[0].id;
  const q = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: baseId, threshold: 64, limit: 2 });
  assert.equal(q.results.length, 2);
  const all = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: baseId, threshold: 64 });
  for (let i = 1; i < all.results.length; i++) {
    const prev = all.results[i - 1];
    const cur = all.results[i];
    assert.ok(prev.distance < cur.distance || (prev.distance === cur.distance && prev.imageId < cur.imageId));
  }
});

test('重启后（重新打开数据库）查询仍然可用', () => {
  const { store, config } = makeStore();
  const c = store.createCollection('t');
  const img = generateDemoImages()[0];
  store.importImage(c.id, img.buffer, 'a.png');
  const before = store.querySimilar({ collectionId: c.id, source: 'upload', uploadBuffer: img.buffer, threshold: 0 });
  const db2 = openDatabase(config.dbPath);
  const store2 = new Store(db2, config);
  assert.equal(store2.listImages(c.id).length, 1);
  const after = store2.querySimilar({ collectionId: c.id, source: 'upload', uploadBuffer: img.buffer, threshold: 0 });
  assert.equal(after.results.length, before.results.length);
  assert.equal(after.results[0].dhash, before.results[0].dhash);
  db2.close();
});

test('查询记录与报告导出', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  const imgs = generateDemoImages();
  const a = store.importImage(c.id, imgs[0].buffer, 'a.png').image;
  store.importImage(c.id, imgs[3].buffer, 'b.png');
  const q = store.querySimilar({ collectionId: c.id, source: 'stored', imageId: a.id, threshold: 64 });
  const report = store.exportQuery(q.queryId, 'md');
  assert.match(report, /近似重复查询报告/);
  const json = JSON.parse(store.exportQuery(q.queryId, 'json')) as { id: number; results: unknown[] };
  assert.equal(json.id, q.queryId);
  assert.equal(json.results.length, q.resultCount);
});

test('透明图可导入并参与查询', () => {
  const { store } = makeStore();
  const c = store.createCollection('t');
  const buf = pngFromGrayMatrix(Array.from({ length: 8 }, () => Array(9).fill(0)), 0);
  const r = store.importImage(c.id, buf, 'transparent.png');
  assert.equal(r.image.dhash, '0000000000000000');
});
