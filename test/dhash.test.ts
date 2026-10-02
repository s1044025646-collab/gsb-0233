import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HASH_BITS,
  areaResizeGray,
  hashFromGrayGrid,
  hammingDistance,
  parseHashHex,
  pixelGray,
  toHashHex,
} from '../src/image.js';
import { makePngBuffer, corruptPng } from './helpers.js';
import { decodePng } from '../src/image.js';

describe('dHash 位序（手工 9x8 亮度矩阵）', () => {
  it('每行全部 左>右：结果为全 1', () => {
    const grid: number[] = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) grid.push(200 - col * 10);
    }
    const { hash, hashHex } = hashFromGrayGrid(grid);
    assert.equal(hash, (1n << BigInt(HASH_BITS)) - 1n);
    assert.equal(hashHex, 'ffffffffffffffff');
  });

  it('亮度相等的位为 0（严格大于才置 1）', () => {
    const grid = new Array(72).fill(128);
    const { hash, hashHex } = hashFromGrayGrid(grid);
    assert.equal(hash, 0n);
    assert.equal(hashHex, '0000000000000000');
  });

  it('仅第 0 行第 0 对为左>右时，只有最高位 bit63 为 1', () => {
    const grid = new Array(72).fill(100);
    grid[0] = 200;
    const { hash, hashHex } = hashFromGrayGrid(grid);
    assert.equal(hash, 1n << 63n);
    assert.equal(hashHex, '8000000000000000');
  });

  it('仅第 7 行第 7 对为左>右时，只有最低位 bit0 为 1', () => {
    const grid = new Array(72).fill(100);
    grid[7 * 9 + 7] = 200;
    const { hash, hashHex } = hashFromGrayGrid(grid);
    assert.equal(hash, 1n);
    assert.equal(hashHex, '0000000000000001');
  });
});

describe('十六进制前导零与解析', () => {
  it('小数值保留前导零固定为 16 位', () => {
    assert.equal(toHashHex(0n), '0000000000000000');
    assert.equal(toHashHex(0xffn), '00000000000000ff');
  });

  it('解析非 16 位或非法字符时报错', () => {
    assert.throws(() => parseHashHex('123'), /16 位十六进制/);
    assert.throws(() => parseHashHex('000000000000000g'), /16 位十六进制/);
    assert.equal(parseHashHex('000000000000000A'), 0xan);
  });
});

describe('Hamming 距离', () => {
  it('已知 BigInt 的位差计数', () => {
    assert.equal(hammingDistance(0n, 0n), 0);
    assert.equal(hammingDistance((1n << 64n) - 1n, 0n), 64);
    assert.equal(hammingDistance(0xffn, 0x01n), 7);
    assert.equal(hammingDistance(0x8000000000000000n, 0x0000000000000001n), 2);
  });

  it('十六进制字符串字符差异不等于 Hamming 距离（防回归）', () => {
    const a = parseHashHex('0f00000000000000');
    const b = parseHashHex('f000000000000000');
    assert.equal(hammingDistance(a, b), 8);
  });
});

describe('透明像素与缩放固定规则', () => {
  it('完全透明像素亮度为 0（合成到黑底）', () => {
    const { data } = decodePng(makePngBuffer(1, 1, () => ({ r: 255, g: 255, b: 255, a: 0 })));
    assert.equal(pixelGray(data, 0), 0);
    const { data: opaque } = decodePng(makePngBuffer(1, 1, () => ({ r: 255, g: 255, b: 255 })));
    assert.ok(Math.abs(pixelGray(opaque, 0) - 255) < 1e-9);
  });

  it('均匀灰图缩放后仍为同一灰度，缩放确定性可复现', () => {
    const img = decodePng(makePngBuffer(100, 100, () => ({ r: 128, g: 128, b: 128 })));
    const a = areaResizeGray(img, 9, 8);
    const b = areaResizeGray(img, 9, 8);
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.ok(a.every((value) => Math.abs(value - 128) < 1e-9));
  });

  it('左右亮度渐变缩放后行方向仍保持单调下降，哈希稳定', () => {
    const img = decodePng(
      makePngBuffer(90, 80, (x) => ({ r: 255 - Math.round((x / 89) * 255), g: 0, b: 0 })),
    );
    const grid = areaResizeGray(img, 9, 8);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        assert.ok(grid[row * 9 + col]! > grid[row * 9 + col + 1]!);
      }
    }
    assert.equal(hashFromGrayGrid(grid).hashHex, 'ffffffffffffffff');
  });

  it('损坏 PNG 抛出 INVALID_PNG', () => {
    assert.throws(() => decodePng(corruptPng()), /PNG 数据损坏/);
  });
});
