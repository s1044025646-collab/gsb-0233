import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

/** 生成确定性演示 PNG（不下载任何在线图片）。 */

function makePng(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const o = (y * width + x) * 4;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

function baseScene(scale: number) {
  return (x: number, y: number): [number, number, number, number] => {
    // 渐变背景 + 圆形 + 矩形，构成可识别的固定图案
    let r = Math.floor((x / (96 * scale)) * 200);
    let g = Math.floor((y / (96 * scale)) * 200);
    let b = 120;
    const cx = 30 * scale, cy = 30 * scale, rad = 18 * scale;
    if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) {
      r = 230; g = 60; b = 60;
    }
    if (x > 55 * scale && x < 85 * scale && y > 55 * scale && y < 85 * scale) {
      r = 40; g = 90; b = 220;
    }
    return [r, g, b, 255];
  };
}

export interface DemoImage {
  filename: string;
  description: string;
  buffer: Buffer;
}

export function generateDemoImages(): DemoImage[] {
  const images: DemoImage[] = [];

  images.push({
    filename: 'base-96.png',
    description: '原图：96x96 渐变+圆形+矩形',
    buffer: makePng(96, 96, baseScene(1)),
  });

  images.push({
    filename: 'base-96-copy.png',
    description: '原图的字节副本（演示字节相同去重）',
    buffer: Buffer.from(images[0].buffer),
  });

  images.push({
    filename: 'resized-48.png',
    description: '尺寸变化图：同图案 48x48 重新绘制',
    buffer: makePng(48, 48, baseScene(0.5)),
  });

  images.push({
    filename: 'slight-change.png',
    description: '轻微改动图：蓝色矩形平移 4 像素且整体亮度 +12',
    buffer: makePng(96, 96, (x, y) => {
      const [r0, g0, b0, a] = baseScene(1)(x, y);
      // 撤销原位置矩形，在新位置（偏移 4px）绘制
      const inOld = x > 55 && x < 85 && y > 55 && y < 85;
      const inNew = x > 59 && x < 89 && y > 59 && y < 89;
      let r = r0, g = g0, b = b0;
      if (inOld && !inNew) {
        r = Math.floor((x / 96) * 200);
        g = Math.floor((y / 96) * 200);
        b = 120;
      }
      if (inNew) {
        r = 40; g = 90; b = 220;
      }
      return [Math.min(255, r + 12), Math.min(255, g + 12), Math.min(255, b + 12), a];
    }),
  });

  images.push({
    filename: 'transparent.png',
    description: '透明图：同图案但圆形区域半透明（合成到白底）',
    buffer: makePng(96, 96, (x, y) => {
      const [r, g, b] = baseScene(1)(x, y);
      const cx = 30, cy = 30;
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < 18 * 18;
      return [r, g, b, inCircle ? 80 : 255];
    }),
  });

  images.push({
    filename: 'different.png',
    description: '明显不同的图：竖条纹',
    buffer: makePng(96, 96, (x) => (x % 16 < 8 ? [20, 20, 20, 255] : [235, 235, 235, 255])),
  });

  return images;
}

export function writeDemoImages(dir: string): DemoImage[] {
  fs.mkdirSync(dir, { recursive: true });
  const images = generateDemoImages();
  for (const img of images) {
    fs.writeFileSync(path.join(dir, img.filename), img.buffer);
  }
  return images;
}
