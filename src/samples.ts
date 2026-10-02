import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { type AppConfig } from './config.js';

export interface SampleFile {
  file: string;
  description: string;
}

const savePng = (file: string, png: PNG): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
};

/**
 * 基础图案：水平方向正弦条纹（dHash 对水平相邻差异敏感），
 * 垂直方向缓慢变化。variant 决定变体类型。
 */
const makePattern = (width: number, height: number, variant: string): PNG => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const u = x / Math.max(1, width - 1);
      const v = y / Math.max(1, height - 1);
      const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 6);
      let r = Math.round((0.25 + 0.75 * wave) * 255);
      let g = Math.round((0.2 + 0.4 * v) * 255);
      let b = Math.round((0.35 + 0.3 * wave) * 255);
      let a = 255;
      if (variant === 'tweak' && Math.abs(u - 0.5) < 0.1) r = wave > 0.5 ? 40 : 240;
      if (variant === 'tweakMore' && u >= 0.3 && u < 0.55) {
        r = 255 - r;
        b = 255 - b;
      }
      if (variant === 'transparent') {
        a = x < width / 2 ? 0 : 255;
      }
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }
  return png;
};

const makeBlocks = (width: number, height: number): PNG => {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const block = (Math.floor(x / Math.max(1, width / 6)) +
        Math.floor(y / Math.max(1, height / 4))) % 2;
      const value = block === 0 ? 235 : 30;
      png.data[idx] = value;
      png.data[idx + 1] = value;
      png.data[idx + 2] = value;
      png.data[idx + 3] = 255;
    }
  }
  return png;
};

/**
 * 生成全部演示图片（离线、确定性合成，无人物、无内容理解）。
 */
export const generateSamples = (config: AppConfig): SampleFile[] => {
  const dir = config.sampleDir;
  const files: SampleFile[] = [
    { file: path.join(dir, '01_original_320x240.png'), description: '原图：彩色渐变 320x240' },
    { file: path.join(dir, '02_resized_160x120.png'), description: '尺寸变化：同一渐变缩小为 160x120' },
    { file: path.join(dir, '03_resized_480x360.png'), description: '尺寸变化：同一渐变放大为 480x360' },
    { file: path.join(dir, '04_tweaked_320x240.png'), description: '轻微改动：中央窄条反色（约 8 位差异）' },
    { file: path.join(dir, '05_tweaked_more_320x240.png'), description: '较强改动：宽条反色（约 16 位差异）' },
    { file: path.join(dir, '06_transparent_320x240.png'), description: '透明图：左半完全透明、右半不透明' },
    { file: path.join(dir, '07_blocks_320x240.png'), description: '明显不同：黑白棋盘块' },
    { file: path.join(dir, '08_solid_dark_256x256.png'), description: '明显不同：近纯色深灰方块' },
  ];

  savePng(files[0]!.file, makePattern(320, 240, 'base'));
  savePng(files[1]!.file, makePattern(160, 120, 'base'));
  savePng(files[2]!.file, makePattern(480, 360, 'base'));
  savePng(files[3]!.file, makePattern(320, 240, 'tweak'));
  savePng(files[4]!.file, makePattern(320, 240, 'tweakMore'));
  savePng(files[5]!.file, makePattern(320, 240, 'transparent'));
  savePng(files[6]!.file, makeBlocks(320, 240));

  const dark = new PNG({ width: 256, height: 256 });
  dark.data.fill(28);
  for (let i = 3; i < dark.data.length; i += 4) dark.data[i] = 255;
  savePng(files[7]!.file, dark);

  return files;
};
