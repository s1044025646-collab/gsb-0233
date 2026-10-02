#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { Store } from './store';
import { startServer } from './server';
import { writeDemoImages } from './demo-images';

function openStore() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  return { store: new Store(db, config), config };
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function printQueryResult(q: ReturnType<Store['querySimilar']>) {
  console.log(`查询 #${q.queryId}  阈值=${q.threshold}  上限=${q.limit}  命中=${q.resultCount}`);
  console.log(`查询 dHash: ${q.queryDhash}  SHA-256: ${q.querySha256}`);
  if (q.results.length === 0) {
    console.log('（无候选）');
    return;
  }
  console.log('排名  图片ID  距离  类型        原文件名');
  for (const [i, r] of q.results.entries()) {
    const type = r.byteIdentical ? '字节相同' : '感知近似';
    console.log(
      `${String(i + 1).padEnd(6)}${String(r.imageId).padEnd(8)}${String(r.distance).padEnd(6)}${type.padEnd(12)}${r.originalName}`,
    );
  }
  console.log('说明：感知近似仅为候选，距离小不代表内容必然相同，请人工确认。');
}

const USAGE = `用法：node dist/src/cli.js <命令> [参数]

命令：
  serve [--port N]                     启动 HTTP API（默认端口 0，即自动选择空闲端口）
  create <名称>                        创建集合
  collections                          列出集合
  import <集合ID> <文件...>            导入 PNG（字节相同自动去重）
  list <集合ID>                        列出集合内图片
  imports <集合ID>                     列出导入记录
  show <图片ID>                        查看图片元数据
  query <集合ID> --image <图片ID> [--threshold N] [--limit N] [--export 文件.(json|md)]
  query <集合ID> --file <路径>         [--threshold N] [--limit N] [--export 文件.(json|md)]
  queries <集合ID>                     列出查询记录
  report <查询ID> [--format json|md] [--export 文件]
  demo [--dir 目录]                    生成演示图片并演示不同阈值下的查询
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }

  if (cmd === 'serve') {
    const { store, config } = openStore();
    const port = argValue(args, '--port')
      ? Number(argValue(args, '--port'))
      : Number(process.env.PORT ?? 0);
    const { port: actual } = await startServer(store, config, port);
    console.log(`API 已启动: http://127.0.0.1:${actual}/api  (数据目录: ${config.dataDir})`);
    return;
  }

  const { store } = openStore();

  switch (cmd) {
    case 'create':
      console.log(store.createCollection(args[0]));
      break;
    case 'collections':
      console.table(store.listCollections());
      break;
    case 'import': {
      const collectionId = Number(args[0]);
      for (const file of args.slice(1)) {
        const buf = fs.readFileSync(file);
        const r = store.importImage(collectionId, buf, path.basename(file));
        console.log(`${r.status === 'duplicate' ? '去重' : '导入'}: ${file} -> 图片 #${r.image.id} (dHash ${r.image.dhash})`);
      }
      break;
    }
    case 'list':
      console.table(
        store.listImages(Number(args[0])).map((i) => ({
          id: i.id,
          name: i.original_name,
          size: i.size_bytes,
          dim: `${i.width}x${i.height}`,
          dhash: i.dhash,
        })),
      );
      break;
    case 'imports':
      console.table(store.listImports(Number(args[0])));
      break;
    case 'show':
      console.log(store.getImage(Number(args[0])));
      break;
    case 'query': {
      const collectionId = Number(args[0]);
      const threshold = argValue(args, '--threshold');
      const limit = argValue(args, '--limit');
      const imageId = argValue(args, '--image');
      const file = argValue(args, '--file');
      const exportPath = argValue(args, '--export');
      const q = imageId
        ? store.querySimilar({
            collectionId,
            source: 'stored',
            imageId: Number(imageId),
            threshold: threshold ? Number(threshold) : undefined,
            limit: limit ? Number(limit) : undefined,
          })
        : store.querySimilar({
            collectionId,
            source: 'upload',
            uploadBuffer: fs.readFileSync(file!),
            threshold: threshold ? Number(threshold) : undefined,
            limit: limit ? Number(limit) : undefined,
          });
      printQueryResult(q);
      if (exportPath) {
        const format = exportPath.endsWith('.md') ? 'md' : 'json';
        fs.writeFileSync(exportPath, store.exportQuery(q.queryId, format), 'utf8');
        console.log(`报告已导出: ${exportPath}`);
      }
      break;
    }
    case 'queries':
      console.table(store.listQueries(Number(args[0])));
      break;
    case 'report': {
      const format = argValue(args, '--format') === 'md' ? 'md' : 'json';
      const content = store.exportQuery(Number(args[0]), format);
      const exportPath = argValue(args, '--export');
      if (exportPath) {
        fs.writeFileSync(exportPath, content, 'utf8');
        console.log(`报告已导出: ${exportPath}`);
      } else {
        console.log(content);
      }
      break;
    }
    case 'demo': {
      const dir = argValue(args, '--dir') ?? path.join(process.cwd(), 'demo-images');
      const images = writeDemoImages(dir);
      console.log(`已生成 ${images.length} 张演示图片到 ${dir}`);
      let collection;
      try {
        collection = store.createCollection('demo');
      } catch {
        collection = store.getCollection('demo');
      }
      const ids: number[] = [];
      for (const img of images) {
        const r = store.importImage(collection.id, img.buffer, img.filename);
        ids.push(r.image.id);
        console.log(`  ${img.filename} (${img.description}) -> #${r.image.id} [${r.status}] dHash=${r.image.dhash}`);
      }
      const baseId = ids[0];
      for (const threshold of [0, 5, 10, 20]) {
        console.log(`\n=== 以 #${baseId} (base-96.png) 查询，阈值 ${threshold} ===`);
        printQueryResult(
          store.querySimilar({ collectionId: collection.id, source: 'stored', imageId: baseId, threshold }),
        );
      }
      break;
    }
    default:
      console.error(`未知命令: ${cmd}\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message ?? e}`);
  process.exitCode = 1;
});
