import { PNG } from 'pngjs';
import { AppError } from './errors.js';

export const DHASH_COLS = 9;
export const DHASH_ROWS = 8;
export const HASH_BITS = 64;

export interface DecodedImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface ImageFeatures {
  width: number;
  height: number;
  /** 64 位 dHash 的 BigInt 表示 */
  hash: bigint;
  /** 固定 16 位小写十六进制，保留前导零 */
  hashHex: string;
}

/**
 * 解码 PNG 字节。仅接受 PNG；损坏数据抛出 INVALID_PNG。
 */
export const decodePng = (bytes: Buffer): DecodedImage => {
  if (bytes.length < 8 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅支持 PNG 图片（缺少 PNG 签名）');
  }
  try {
    const png = PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: png.data };
  } catch {
    throw new AppError('INVALID_PNG', 'PNG 数据损坏或无法解码');
  }
};

/**
 * RGBA 转灰度的固定规则：
 * 先把像素按 alpha 合成到黑色背景，再按 ITU-R BT.601 加权：
 *   gray = (0.299*R + 0.587*G + 0.114*B) * (A/255)
 * 因此完全透明像素的亮度为 0（等同黑色）。结果为 0..255 的浮点数。
 */
export const pixelGray = (data: Buffer, index: number): number => {
  const r = data[index] ?? 0;
  const g = data[index + 1] ?? 0;
  const b = data[index + 2] ?? 0;
  const a = data[index + 3] ?? 255;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return (luma * a) / 255;
};

/**
 * 区域平均（box / area）缩放：每个目标像素对应源图中的一块矩形区域，
 * 按源像素与该矩形的重叠面积做加权平均。该规则确定性、无随机抖动。
 */
export const areaResizeGray = (
  img: DecodedImage,
  dstCols: number,
  dstRows: number,
): Float64Array => {
  const { width: sw, height: sh, data } = img;
  const out = new Float64Array(dstCols * dstRows);
  for (let dy = 0; dy < dstRows; dy++) {
    const sx0 = (dy * sh) / dstRows;
    const sx1 = ((dy + 1) * sh) / dstRows;
    const y0 = Math.floor(sx0);
    const y1 = Math.max(y0 + 1, Math.ceil(sx1));
    for (let dx = 0; dx < dstCols; dx++) {
      const sy0 = (dx * sw) / dstCols;
      const sy1 = ((dx + 1) * sw) / dstCols;
      const x0 = Math.floor(sy0);
      const x1 = Math.max(x0 + 1, Math.ceil(sy1));
      let weighted = 0;
      let weightSum = 0;
      for (let y = y0; y < y1; y++) {
        const yy = Math.min(Math.max(y, 0), sh - 1);
        const wy = Math.min(y + 1, sx1) - Math.max(y, sx0);
        if (wy <= 0) continue;
        for (let x = x0; x < x1; x++) {
          const xx = Math.min(Math.max(x, 0), sw - 1);
          const wx = Math.min(x + 1, sy1) - Math.max(x, sy0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          weighted += pixelGray(data, (yy * sw + xx) * 4) * weight;
          weightSum += weight;
        }
      }
      out[dy * dstCols + dx] = weightSum > 0 ? weighted / weightSum : 0;
    }
  }
  return out;
};

/**
 * 计算 64 位 dHash：
 * 1) 区域平均缩放为 9 列 x 8 行灰度；
 * 2) 每行从左到右比较相邻像素：左亮度 > 右亮度 -> 1，否则 -> 0
 *    （亮度相等时该位为 0，不采用四舍五入或符号随机化）；
 * 3) 位序固定：第 0 行（最上面一行）第 0 列（最左一对）为 64 位整数的
 *    最高位（bit 63），按行优先、每行从左到右依次填充到 bit 0。
 */
export const computeDHash = (img: DecodedImage): ImageFeatures => {
  const features = hashFromGrayGrid(areaResizeGray(img, DHASH_COLS, DHASH_ROWS));
  return { ...features, width: img.width, height: img.height };
};

/**
 * 由已经是 9 列 x 8 行的灰度矩阵直接计算 dHash（供测试用手工矩阵核对位序）。
 */
export const hashFromGrayGrid = (grid: ArrayLike<number>): ImageFeatures => {
  if (grid.length !== DHASH_COLS * DHASH_ROWS) {
    throw new AppError('INVALID_ARGUMENT', `灰度矩阵必须恰好为 ${DHASH_COLS}x${DHASH_ROWS}`);
  }
  let hash = 0n;
  for (let row = 0; row < DHASH_ROWS; row++) {
    for (let col = 0; col < DHASH_COLS - 1; col++) {
      const left = grid[row * DHASH_COLS + col] ?? 0;
      const right = grid[row * DHASH_COLS + col + 1] ?? 0;
      if (left > right) {
        const bitIndex = row * (DHASH_COLS - 1) + col;
        hash |= 1n << BigInt(HASH_BITS - 1 - bitIndex);
      }
    }
  }
  return {
    width: DHASH_COLS,
    height: DHASH_ROWS,
    hash,
    hashHex: toHashHex(hash),
  };
};

/** 格式化为固定 16 位小写十六进制，保留前导零。 */
export const toHashHex = (hash: bigint): string => hash.toString(16).padStart(16, '0');

/** 从十六进制字符串解析为 BigInt，校验长度与字符。 */
export const parseHashHex = (hex: string): bigint => {
  if (!/^[0-9a-fA-F]{16}$/.test(hex)) {
    throw new AppError('INVALID_ARGUMENT', `哈希必须为 16 位十六进制字符串，实际为 "${hex}"`);
  }
  return BigInt('0x' + hex.toLowerCase());
};

/**
 * 计算两个 64 位哈希的 Hamming 距离：异或后统计值为 1 的位的数量。
 * 注意：绝不能对十六进制字符串逐字符比较。
 */
export const hammingDistance = (a: bigint, b: bigint): number => {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
};

export const analyzePng = (
  bytes: Buffer,
  limits: { maxFileBytes: number; maxImageDimension: number },
): ImageFeatures => {
  if (bytes.length > limits.maxFileBytes) {
    throw new AppError(
      'FILE_TOO_LARGE',
      `PNG 文件大小 ${bytes.length} 字节超过上限 ${limits.maxFileBytes} 字节`,
    );
  }
  const img = decodePng(bytes);
  if (img.width < DHASH_COLS || img.height < DHASH_ROWS) {
    throw new AppError(
      'IMAGE_TOO_SMALL',
      `图片尺寸 ${img.width}x${img.height} 小于计算 dHash 所需的最小尺寸 ${DHASH_COLS}x${DHASH_ROWS}`,
    );
  }
  if (img.width > limits.maxImageDimension || img.height > limits.maxImageDimension) {
    throw new AppError(
      'IMAGE_TOO_LARGE_DIMENSIONS',
      `图片尺寸 ${img.width}x${img.height} 超过最大边长 ${limits.maxImageDimension}`,
    );
  }
  return computeDHash(img);
};
