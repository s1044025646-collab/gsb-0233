import { DecodedImage, resizeGrayBilinear, toGrayscale } from './pngutil';

export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;
export const DHASH_BITS = 64;

/**
 * 64 位 dHash：
 * - 灰度化（见 pngutil.toGrayscale）后双线性缩放到 9×8。
 * - 每行 8 个比特：bit = 1 当且仅当 左像素亮度 > 右相邻像素亮度；
 *   亮度相等时比特为 0（严格大于才置 1）。
 * - 比特次序：按行优先（row 0..7，每行 col 0..7），第 i 位（i = row*8+col）
 *   放在 64 位整数的第 (63 - i) 位，即 hex 字符串从左到右与位序一致。
 * - hex 固定 16 个小写字符，保留前导零。
 */
export function computeDHash(img: DecodedImage): { hex: string; value: bigint } {
  const gray = toGrayscale(img);
  const small = resizeGrayBilinear(gray, img.width, img.height, DHASH_WIDTH, DHASH_HEIGHT);
  let value = 0n;
  for (let row = 0; row < DHASH_HEIGHT; row++) {
    for (let col = 0; col < DHASH_WIDTH - 1; col++) {
      const bitIndex = row * (DHASH_WIDTH - 1) + col;
      const left = small[row * DHASH_WIDTH + col];
      const right = small[row * DHASH_WIDTH + col + 1];
      if (left > right) {
        value |= 1n << BigInt(DHASH_BITS - 1 - bitIndex);
      }
    }
  }
  return { hex: value.toString(16).padStart(16, '0'), value };
}

/** Hamming 距离：两个 64 位哈希不同比特的数量（按位异或后数 1）。 */
export function hammingDistance(hexA: string, hexB: string): number {
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}
