import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDHash, hammingDistance } from '../src/dhash';
import { decodePng } from '../src/pngutil';
import { matrixWithSingleEdge, pngFromGrayMatrix } from './helpers';

function hashOf(buf: Buffer): string {
  return computeDHash(decodePng(buf)).hex;
}

test('位序：第一个比特对应 hex 最高位', () => {
  const hex = hashOf(pngFromGrayMatrix(matrixWithSingleEdge(0, 0)));
  assert.equal(hex, '8000000000000000');
});

test('位序：最后一个比特对应 hex 最低位，前导零保留', () => {
  const hex = hashOf(pngFromGrayMatrix(matrixWithSingleEdge(7, 7)));
  assert.equal(hex, '0000000000000001');
  assert.equal(hex.length, 16);
});

test('相等亮度比特为 0：全同亮度图哈希全零', () => {
  const m = Array.from({ length: 8 }, () => Array(9).fill(77));
  assert.equal(hashOf(pngFromGrayMatrix(m)), '0000000000000000');
});

test('递增亮度行全 0；递减亮度行全 1', () => {
  const inc = Array.from({ length: 8 }, () => [0, 10, 20, 30, 40, 50, 60, 70, 80]);
  assert.equal(hashOf(pngFromGrayMatrix(inc)), '0000000000000000');
  const dec = Array.from({ length: 8 }, () => [80, 70, 60, 50, 40, 30, 20, 10, 0]);
  assert.equal(hashOf(pngFromGrayMatrix(dec)), 'ffffffffffffffff');
});

test('透明像素合成到白底：全透明图等于全白图', () => {
  const m = Array.from({ length: 8 }, () => Array(9).fill(0));
  const transparent = hashOf(pngFromGrayMatrix(m, 0));
  const white = hashOf(pngFromGrayMatrix(Array.from({ length: 8 }, () => Array(9).fill(255))));
  assert.equal(transparent, white);
  assert.equal(transparent, '0000000000000000');
});

test('已知 Hamming 距离', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistance('8000000000000000', '0000000000000000'), 1);
  assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(hammingDistance('0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0'), 64);
  assert.equal(hammingDistance('00ff00ff00ff00ff', '0000000000000000'), 32);
});

test('缩放固定样例：18x16 明暗交替条纹缩到 9x8 后保持交替', () => {
  const m = Array.from({ length: 16 }, () =>
    Array.from({ length: 18 }, (_, x) => (Math.floor(x / 2) % 2 === 0 ? 200 : 50)),
  );
  const hex = hashOf(pngFromGrayMatrix(m));
  assert.equal(hex, 'aaaaaaaaaaaaaaaa');
});
