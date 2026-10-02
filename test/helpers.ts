import { PNG } from 'pngjs';

/** 用灰度矩阵构造 PNG（每像素 RGBA=(v,v,v,alpha)）。 */
export function pngFromGrayMatrix(matrix: number[][], alpha = 255): Buffer {
  const height = matrix.length;
  const width = matrix[0].length;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = matrix[y][x];
      const o = (y * width + x) * 4;
      png.data[o] = v;
      png.data[o + 1] = v;
      png.data[o + 2] = v;
      png.data[o + 3] = alpha;
    }
  }
  return PNG.sync.write(png);
}

/** 构造 9x8 矩阵：仅在 (row, col) 处左亮右暗，其余全等。 */
export function matrixWithSingleEdge(row: number, col: number): number[][] {
  const m: number[][] = Array.from({ length: 8 }, () => Array(9).fill(128));
  m[row][col] = 200;
  m[row][col + 1] = 100;
  return m;
}
