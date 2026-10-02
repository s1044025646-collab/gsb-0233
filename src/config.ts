import path from 'path';

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  maxFileBytes: number;
  maxDimension: number;
  defaultThreshold: number;
  defaultLimit: number;
  maxLimit: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir =
    overrides.dataDir ??
    process.env.PNGDUP_DATA_DIR ??
    path.join(process.cwd(), 'data');
  return {
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'pngdup.sqlite'),
    maxFileBytes: overrides.maxFileBytes ?? numEnv('PNGDUP_MAX_FILE_BYTES', 20 * 1024 * 1024),
    maxDimension: overrides.maxDimension ?? numEnv('PNGDUP_MAX_DIMENSION', 4096),
    defaultThreshold: overrides.defaultThreshold ?? numEnv('PNGDUP_DEFAULT_THRESHOLD', 10),
    defaultLimit: overrides.defaultLimit ?? numEnv('PNGDUP_DEFAULT_LIMIT', 50),
    maxLimit: overrides.maxLimit ?? numEnv('PNGDUP_MAX_LIMIT', 500),
  };
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
