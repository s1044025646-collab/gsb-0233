import path from 'node:path';
import { AppError } from './errors.js';

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  blobDir: string;
  sampleDir: string;
  maxFileBytes: number;
  maxImageDimension: number;
  defaultThreshold: number;
  maxThreshold: number;
  defaultLimit: number;
  maxLimit: number;
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_DIMENSION = 4096;
export const DEFAULT_THRESHOLD = 10;
export const MAX_THRESHOLD = 64;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

export const resolveConfig = (overrides: Partial<AppConfig> = {}): AppConfig => {
  const dataDir = overrides.dataDir ?? path.resolve(process.cwd(), 'data');
  return {
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'app.sqlite'),
    blobDir: overrides.blobDir ?? path.join(dataDir, 'images'),
    sampleDir: overrides.sampleDir ?? path.join(dataDir, 'samples'),
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxImageDimension: overrides.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
    defaultThreshold: overrides.defaultThreshold ?? DEFAULT_THRESHOLD,
    maxThreshold: overrides.maxThreshold ?? MAX_THRESHOLD,
    defaultLimit: overrides.defaultLimit ?? DEFAULT_LIMIT,
    maxLimit: overrides.maxLimit ?? MAX_LIMIT,
  };
};

export const parsePort = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AppError('INVALID_ARGUMENT', `端口必须是 0-65535 的整数，实际为 "${value}"`);
  }
  return port;
};
