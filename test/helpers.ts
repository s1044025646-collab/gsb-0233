import { PNG } from 'pngjs';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export const makePngBuffer = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba,
): Buffer => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const { r, g, b, a = 255 } = pixel(x, y);
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }
  return PNG.sync.write(png);
};

export const corruptPng = (): Buffer => {
  const buf = makePngBuffer(16, 16, () => ({ r: 10, g: 20, b: 30 }));
  for (let i = 32; i < Math.min(buf.length, 80); i++) buf[i] = 0;
  return buf;
};
