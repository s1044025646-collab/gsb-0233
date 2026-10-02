#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { runDemo } from './demo.js';
import { AppError } from './errors.js';
import { exportReport } from './report.js';
import { generateSamples } from './samples.js';
import { listen } from './server.js';
import { parsePort } from './config.js';
import { Store } from './store.js';

const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

const USAGE = `png-dhash — 本地 PNG 近似重复检测后端（CLI）

用法:
  npm run cli -- serve [--port 0] [--data-dir ./data]
  npm run demo [-- --data-dir ./data]
  npm run generate-samples
  collection create <名称>
  collection list
  images import <collectionId> <png文件...>
  images list <collectionId>
  image <collectionId> <imageId>
  query <collectionId> --image <imageId | png文件> [--threshold 10] [--limit 20] [--include-self]
  imports <collectionId>
  queries <collectionId>
  report <collectionId> <queryId> [输出文件]
  help

全局选项:
  --data-dir <目录>    项目内数据目录（默认 ./data）
  --port <端口>        serve 端口；0 或不传表示由系统选择空闲端口
`;

const optionValue = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const main = async (argv: string[]): Promise<number> => {
  const [command = 'help', ...rest] = argv;
  const dataDir = optionValue(rest, '--data-dir') ?? path.resolve(process.cwd(), 'data');
  const config = resolveConfig({ dataDir: path.resolve(dataDir) });

  switch (command) {
    case 'serve': {
      const port = parsePort(optionValue(rest, '--port'));
      const { app, port: actualPort } = await listen(port, { dataDir: config.dataDir });
      console.log(JSON.stringify({
        service: 'png-dhash',
        url: `http://127.0.0.1:${actualPort}`,
        dataDir: config.dataDir,
      }, null, 2));
      const shutdown = (): void => {
        app.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise<void>(() => {});
      return 0;
    }
    case 'demo':
      runDemo(config.dataDir);
      return 0;
    case 'generate-samples': {
      const files = generateSamples(config);
      print({ generated: files.map((item) => path.relative(process.cwd(), item.file)) });
      return 0;
    }
    default:
      return runStoreCommand(command, rest, config.dataDir);
  }
};

const runStoreCommand = (command: string, args: string[], dataDir: string): number => {
  const config = resolveConfig({ dataDir });
  const store = new Store(config);
  try {
    const thresholdArg = optionValue(args, '--threshold');
    const limitArg = optionValue(args, '--limit');
    const threshold = thresholdArg !== undefined ? Number(thresholdArg) : config.defaultThreshold;
    const limit = limitArg !== undefined ? Number(limitArg) : config.defaultLimit;
    const includeSelf = args.includes('--include-self');

    switch (command) {
      case 'collection': {
        const sub = args[0];
        if (sub === 'create') {
          const name = args[1];
          if (!name) throw new AppError('INVALID_ARGUMENT', '用法: collection create <名称>');
          print(store.createCollection(name));
          return 0;
        }
        if (sub === 'list') {
          print({ collections: store.listCollections() });
          return 0;
        }
        break;
      }
      case 'images': {
        const sub = args[0];
        if (sub === 'import') {
          const collectionId = Number(args[1]);
          const files = args.slice(2).filter((arg) => !arg.startsWith('--'));
          if (!Number.isInteger(collectionId) || files.length === 0) {
            throw new AppError('INVALID_ARGUMENT', '用法: images import <collectionId> <png文件...>');
          }
          const results = files.map((file) =>
            store.importImage(collectionId, fs.readFileSync(file), path.basename(file)),
          );
          print({ results });
          return 0;
        }
        if (sub === 'list') {
          const collectionId = Number(args[1]);
          print({ images: store.listImages(collectionId) });
          return 0;
        }
        break;
      }
      case 'image': {
        const collectionId = Number(args[0]);
        const imageId = Number(args[1]);
        print({ image: store.getImage(collectionId, imageId) });
        return 0;
      }
      case 'query': {
        const collectionId = Number(args[0]);
        const imageOption = optionValue(args, '--image');
        if (!imageOption) throw new AppError('INVALID_ARGUMENT', '查询需要 --image <imageId | png文件>');
        const asId = Number(imageOption);
        const result = Number.isInteger(asId) && !fs.existsSync(imageOption)
          ? store.queryByImageId(collectionId, asId, { threshold, limit, includeSelf })
          : store.querySimilar(collectionId, {
              bytes: fs.readFileSync(imageOption),
              originalName: path.basename(imageOption),
              threshold,
              limit,
              includeSelf,
            });
        print(result);
        return 0;
      }
      case 'imports':
        print({ imports: store.listImports(Number(args[0])) });
        return 0;
      case 'queries':
        print({ queries: store.listQueries(Number(args[0])) });
        return 0;
      case 'report': {
        const collectionId = Number(args[0]);
        const queryId = Number(args[1]);
        const outFile = args[2] ?? path.join(config.dataDir, 'reports', `query-${queryId}.json`);
        const written = exportReport(store, collectionId, queryId, outFile);
        print({ exported: written });
        return 0;
      }
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;
      default:
        console.log(USAGE);
        return command ? 1 : 0;
    }
    console.log(USAGE);
    return 1;
  } finally {
    store.close();
  }
};

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof AppError) {
      console.error(JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2));
      process.exitCode = 1;
    } else {
      console.error((err as Error).stack ?? err);
      process.exitCode = 1;
    }
  });
