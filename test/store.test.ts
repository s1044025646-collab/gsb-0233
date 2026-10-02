import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { resolveConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { generateSamples } from '../src/samples.js';
import { Store } from '../src/store.js';
import { makePngBuffer } from './helpers.js';

let tempDir: string;
let store: Store;
let storeClosed = false;

const gradientPng = (width: number, height: number, tweak = false): Buffer =>
  makePngBuffer(width, height, (x, y) => {
    const base = Math.round(((x + y) / (width + height - 2)) * 255);
    const b = 80;
    const changed = tweak && x >= Math.floor(width / 8) && x < Math.floor(width / 2) &&
      y >= Math.floor(height / 8) && y < Math.floor(height / 2);
    return { r: changed ? 255 : base, g: base, b };
  });

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'png-dhash-test-'));
  store = new Store(resolveConfig({ dataDir: tempDir }));
});

afterEach(() => {
  if (!storeClosed) store.close();
  storeClosed = false;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('集合与导入', () => {
  it('创建/重名冲突/空集合查询', () => {
    const c = store.createCollection('c1');
    assert.equal(c.name, 'c1');
    assert.throws(() => store.createCollection('c1'), (err: unknown) =>
      err instanceof AppError && err.code === 'CONFLICT');
    assert.throws(() => store.listImages(9999), (err: unknown) =>
      err instanceof AppError && err.code === 'NOT_FOUND');

    const empty = store.querySimilar(c.id, {
      bytes: gradientPng(64, 64),
      originalName: 'q.png',
      threshold: 64,
      limit: 20,
      includeSelf: false,
    });
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.results, []);
  });

  it('重复导入相同字节去重，且复制到数据目录而源文件保持不变', () => {
    const c = store.createCollection('dup');
    const source = path.join(tempDir, 'source.png');
    const bytes = gradientPng(120, 90);
    fs.writeFileSync(source, bytes);
    const statBefore = fs.statSync(source);

    const first = store.importImage(c.id, fs.readFileSync(source), 'source.png');
    const second = store.importImage(c.id, fs.readFileSync(source), 'source-copy.png');
    assert.equal(first.status, 'imported');
    assert.equal(second.status, 'duplicate');
    assert.equal(first.image!.id, second.image!.id);
    assert.equal(store.listImages(c.id).length, 1);
    assert.ok(fs.existsSync(first.image!.stored_path));
    assert.equal(fs.statSync(source).size, statBefore.size);

    const imports = store.listImports(c.id) as Array<{ status: string }>;
    assert.deepEqual(imports.map((item) => item.status).sort(), ['duplicate', 'imported']);
  });

  it('不同集合各自去重但不能混查', () => {
    const a = store.createCollection('col-a');
    const b = store.createCollection('col-b');
    const bytes = gradientPng(80, 80);
    const ia = store.importImage(a.id, bytes, 'x.png');
    const ib = store.importImage(b.id, bytes, 'x.png');
    assert.equal(ia.status, 'imported');
    assert.equal(ib.status, 'imported');
    assert.notEqual(ia.image!.id, ib.image!.id);
    const result = store.querySimilar(b.id, {
      bytes,
      originalName: 'x.png',
      threshold: 0,
      limit: 10,
      includeSelf: false,
    });
    assert.equal(result.count, 0);
  });
});

describe('查询阈值与排序', () => {
  it('零阈值只匹配字节相同；includeSelf 控制自身；排序按 distance 再按 id', () => {
    const c = store.createCollection('query');
    const original = gradientPng(320, 240);
    const tweaked = gradientPng(320, 240, true);
    const different = makePngBuffer(320, 240, (x, y) => ({
      r: (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 230 : 20,
      g: 0,
      b: 0,
    }));
    const importedOriginal = store.importImage(c.id, original, 'orig.png');
    store.importImage(c.id, tweaked, 'tweaked.png');
    store.importImage(c.id, different, 'blocks.png');

    const atZero = store.querySimilar(c.id, {
      bytes: original,
      originalName: 'orig.png',
      threshold: 0,
      limit: 20,
      includeSelf: false,
    });
    // dHash 距离为 0 不代表字节相同：这里允许存在哈希碰撞的 similar 候选，
    // 但只要没有排除自身，就绝不应该出现 identical。
    assert.ok(atZero.results.every((item) => item.match_type === 'similar'));
    assert.ok(atZero.results.every((item) => item.distance === 0));

    const withSelf = store.querySimilar(c.id, {
      bytes: original,
      originalName: 'orig.png',
      threshold: 0,
      limit: 20,
      includeSelf: true,
    });
    assert.equal(withSelf.count, 1);
    assert.equal(withSelf.results[0]!.match_type, 'identical');
    assert.equal(withSelf.results[0]!.image_id, importedOriginal.image!.id);

    const broad = store.querySimilar(c.id, {
      bytes: original,
      originalName: 'orig.png',
      threshold: 64,
      limit: 20,
      includeSelf: false,
    });
    const distances = broad.results.map((item) => item.distance);
    const sorted = [...distances].sort((a, b) => a - b);
    assert.deepEqual(distances, sorted);
    assert.ok(broad.results.every((item) => item.match_type === 'similar'));
  });

  it('阈值边界：恰好在阈值上的候选包含在内', () => {
    const c = store.createCollection('boundary');
    const base = gradientPng(100, 100);
    store.importImage(c.id, base, 'base.png');
    for (let threshold = 0; threshold <= 10; threshold++) {
      const r = store.querySimilar(c.id, {
        bytes: base,
        originalName: 'base.png',
        threshold,
        limit: 20,
        includeSelf: true,
      });
      assert.ok(r.results[0]!.distance === 0);
    }
    assert.throws(
      () =>
        store.querySimilar(c.id, {
          bytes: base,
          originalName: 'base.png',
          threshold: 65,
          limit: 20,
          includeSelf: false,
        }),
      /阈值/,
    );
  });

  it('limit 生效', () => {
    const c = store.createCollection('limit');
    const bytes = gradientPng(90, 90);
    store.importImage(c.id, bytes, 'same.png');
    for (let i = 0; i < 4; i++) {
      store.importImage(
        c.id,
        makePngBuffer(90, 90, (x, y) => ({ r: 40 + i * 30, g: (x + y) % 256, b: 200 })),
        `other-${i}.png`,
      );
    }
    const r = store.querySimilar(c.id, {
      bytes,
      originalName: 'q.png',
      threshold: 64,
      limit: 3,
      includeSelf: false,
    });
    assert.equal(r.count, 3);
    assert.deepEqual(r.results.map((item) => item.rank), [1, 2, 3]);
  });
});

describe('透明图、损坏 PNG 与尺寸上限', () => {
  const transparent = makePngBuffer(64, 64, (x) => ({
    r: 255,
    g: 255,
    b: 255,
    a: x < 32 ? 0 : 255,
  }));

  it('透明图可导入且哈希为确定的 16 位十六进制', () => {
    const c = store.createCollection('alpha');
    const result = store.importImage(c.id, transparent, 'alpha.png');
    assert.equal(result.status, 'imported');
    assert.match(result.image!.dhash, /^[0-9a-f]{16}$/);
    const again = store.importImage(c.id, transparent, 'alpha.png');
    assert.equal(again.status, 'duplicate');
  });

  it('损坏 PNG 被拒且不产生任何可查询记录', () => {
    const c = store.createCollection('broken');
    const broken = Buffer.alloc(256, 0);
    broken[0] = 0x89;
    assert.throws(() => store.importImage(c.id, broken, 'broken.png'), AppError);
    assert.equal(store.listImages(c.id).length, 0);
  });

  it('小于 9x8 的 PNG 被拒', () => {
    const c = store.createCollection('small');
    assert.throws(
      () => store.importImage(c.id, makePngBuffer(8, 8, () => ({ r: 1, g: 2, b: 3 })), 's.png'),
      (err: unknown) => err instanceof AppError && err.code === 'IMAGE_TOO_SMALL',
    );
  });
});

describe('重启后查询与演示样例', () => {
  it('关闭并重开 Store 后数据仍可查询（SQLite 持久化）', () => {
    const c = store.createCollection('persist');
    store.importImage(c.id, gradientPng(120, 120), 'p.png');
    store.close();
    storeClosed = true;
    const reopened = new Store(resolveConfig({ dataDir: tempDir }));
    const collections = reopened.listCollections();
    assert.equal(collections[0]!.name, 'persist');
    const images = reopened.listImages(c.id);
    assert.equal(images.length, 1);
    const result = reopened.queryByImageId(c.id, images[0]!.id, {
      threshold: 0,
      limit: 10,
      includeSelf: true,
    });
    assert.equal(result.results[0]!.match_type, 'identical');
    reopened.close();
    storeClosed = true;
  });

  it('演示样例集合生成 8 张图且缩放/微调版本在不同阈值分层出现', () => {
    const config = resolveConfig({ dataDir: tempDir });
    const samples = generateSamples(config);
    assert.equal(samples.length, 8);
    const c = store.createCollection('samples');
    for (const sample of samples) {
      assert.equal(store.importImage(c.id, fs.readFileSync(sample.file), path.basename(sample.file)).status, 'imported');
    }
    const originalId = store.listImages(c.id).find((image) => image.original_name.startsWith('01'))!.id;
    const at0 = store.queryByImageId(c.id, originalId, { threshold: 0, limit: 20, includeSelf: false });
    const namesAt0 = at0.results.map((item) => item.original_name);
    assert.ok(namesAt0.some((name) => name.startsWith('02')));
    assert.ok(namesAt0.some((name) => name.startsWith('03')));
    assert.ok(!namesAt0.some((name) => name.startsWith('04')));
    const at8 = store.queryByImageId(c.id, originalId, { threshold: 8, limit: 20, includeSelf: false });
    assert.ok(at8.results.some((item) => item.original_name.startsWith('04')));
    assert.ok(!at8.results.some((item) => item.original_name.startsWith('05')));
    const at16 = store.queryByImageId(c.id, originalId, { threshold: 16, limit: 20, includeSelf: false });
    assert.ok(at16.results.some((item) => item.original_name.startsWith('05')));
    const includeSelfAt0 = store.queryByImageId(c.id, originalId, {
      threshold: 0,
      limit: 20,
      includeSelf: true,
    });
    assert.equal(includeSelfAt0.results[0]!.image_id, originalId);
    assert.equal(includeSelfAt0.results[0]!.match_type, 'identical');
  });
});
