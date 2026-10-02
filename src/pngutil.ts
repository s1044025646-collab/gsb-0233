import { PNG } from 'pngjs';
import { AppError } from './errors';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 每像素 4 字节 */
  data: Buffer;
}

/** 解码 PNG，损坏或非 PNG 数据抛出 AppError(INVALID_PNG)。 */
export function decodePng(buf: Buffer): DecodedImage {
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (e) {
    throw new AppError('INVALID_PNG', `无法解码 PNG：${(e as Error).message}`, 422);
  }
  if (png.width <= 0 || png.height <= 0) {
    throw new AppError('INVALID_PNG', 'PNG 尺寸非法', 422);
  }
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * 灰度化规则（固定）：
 * 1. 透明像素按 alpha 合成到不透明白色背景上（全透明像素视为白色）。
 * 2. 灰度 = round((299*R + 587*G + 114*B) / 1000)，整数运算，范围 0..255。
 */
export function toGrayscale(img: DecodedImage): Uint8Array {
  const { width, height, data } = img;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = data[o + 3];
    // 合成到白底：c = (c*a + 255*(255-a)) / 255
    const r = (data[o] * a + 255 * (255 - a) + 127) / 255 | 0;
    const g = (data[o + 1] * a + 255 * (255 - a) + 127) / 255 | 0;
    const b = (data[o + 2] * a + 255 * (255 - a) + 127) / 255 | 0;
    gray[i] = Math.round((299 * r + 587 * g + 114 * b) / 1000);
  }
  return gray;
}

/**
 * 双线性缩放灰度图到 nw×nh。
 * 采样映射：src = (dst + 0.5) * (srcN / dstN) - 0.5，边缘截断。
 * 输出为四舍五入后的整数灰度。
 */
export function resizeGrayBilinear(
  gray: Uint8Array,
  w: number,
  h: number,
  nw: number,
  nh: number,
): Uint8Array {
  const out = new Uint8Array(nw * nh);
  const xScale = w / nw;
  const yScale = h / nh;
  for (let y = 0; y < nh; y++) {
    const srcY = (y + 0.5) * yScale - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(srcY)));
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, srcY - y0));
    for (let x = 0; x < nw; x++) {
      const srcX = (x + 0.5) * xScale - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(srcX)));
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, srcX - x0));
      const top = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx;
      const bot = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx;
      out[y * nw + x] = Math.max(0, Math.min(255, Math.round(top * (1 - fy) + bot * fy)));
    }
  }
  return out;
}
