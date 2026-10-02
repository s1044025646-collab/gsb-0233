import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { generateSamples } from '../src/samples.js';
import { resolveConfig } from '../src/config.js';
import { listen } from '../src/server.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'png-dhash-api-'));
let base = '';
let closeApp: () => void;

const json = async (response: Response): Promise<any> => response.json();

before(async () => {
  const config = resolveConfig({ dataDir: tempDir });
  generateSamples(config);
  const { app, port } = await listen(0, { dataDir: tempDir });
  base = `http://127.0.0.1:${port}`;
  closeApp = () => app.close();
});

after(() => {
  closeApp();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('HTTP API 端到端', () => {
  it('建集合 -> 上传导入 -> multipart 上传查询（URL 阈值生效）-> 查询记录', async () => {
    const created = await json(
      await fetch(`${base}/api/collections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'api-smoke' }),
      }),
    );
    const cid = created.id;

    const form = new FormData();
    form.append(
      'image',
      new Blob([fs.readFileSync(path.join(tempDir, 'samples', '01_original_320x240.png'))], {
        type: 'image/png',
      }),
      '01_original_320x240.png',
    );
    const imported = await json(await fetch(`${base}/api/collections/${cid}/images`, { method: 'POST', body: form }));
    assert.equal(imported.status, 'imported');

    const formTweak = new FormData();
    formTweak.append(
      'image',
      new Blob([fs.readFileSync(path.join(tempDir, 'samples', '04_tweaked_320x240.png'))], {
        type: 'image/png',
      }),
      '04_tweaked_320x240.png',
    );
    await fetch(`${base}/api/collections/${cid}/images`, { method: 'POST', body: formTweak });

    const q0 = await json(
      await (async () => {
        const f = new FormData();
        f.append(
          'image',
          new Blob([fs.readFileSync(path.join(tempDir, 'samples', '01_original_320x240.png'))], {
            type: 'image/png',
          }),
          'q.png',
        );
        return fetch(`${base}/api/collections/${cid}/query?threshold=0`, { method: 'POST', body: f });
      })(),
    );
    assert.equal(q0.threshold, 0);
    assert.equal(q0.count, 0);

    const q8 = await json(
      await (async () => {
        const f = new FormData();
        f.append(
          'image',
          new Blob([fs.readFileSync(path.join(tempDir, 'samples', '01_original_320x240.png'))], {
            type: 'image/png',
          }),
          'q.png',
        );
        return fetch(`${base}/api/collections/${cid}/query?threshold=8`, { method: 'POST', body: f });
      })(),
    );
    assert.equal(q8.threshold, 8);
    assert.equal(q8.count, 1);
    assert.equal(q8.results[0].distance, 8);

    const record = await json(await fetch(`${base}/api/collections/${cid}/queries/${q8.queryId}`));
    assert.equal(record.results[0].distance, 8);
  });

  it('错误码：非法 JSON、阈值越界、跨集合图片不存在', async () => {
    const bad = await fetch(`${base}/api/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error.code, 'BAD_REQUEST');

    const c = await json(
      await fetch(`${base}/api/collections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'api-errors' }),
      }),
    );
    const badThresholdRes = await fetch(`${base}/api/collections/${c.id}/images/1/query?threshold=100`);
    assert.equal(badThresholdRes.status, 404);
    const badThreshold = await json(badThresholdRes);
    assert.equal(badThreshold.error.code, 'NOT_FOUND');

    const missing = await json(
      await fetch(`${base}/api/collections/${c.id}/images/9999`),
    );
    assert.equal(missing.error.code, 'NOT_FOUND');
  });
});
