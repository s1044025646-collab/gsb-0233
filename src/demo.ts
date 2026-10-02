import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { exportReport } from './report.js';
import { generateSamples } from './samples.js';
import { Store } from './store.js';

const log = (message: string): void => console.log(message);

/**
 * 端到端离线演示：生成样例 -> 建集合 -> 导入（含重复导入）->
 * 在多档阈值下查询 -> 导出报告。返回演示文本摘要。
 */
export const runDemo = (dataDir = path.resolve(process.cwd(), 'data')): string => {
  const lines: string[] = [];
  const out = (msg: string): void => {
    lines.push(msg);
    log(msg);
  };

  const config = resolveConfig({ dataDir });
  const store = new Store(config);
  try {
    out('== 1. 生成演示 PNG（离线合成，无下载）==');
    const samples = generateSamples(config);
    for (const sample of samples) out(`  - ${path.basename(sample.file)}：${sample.description}`);

    out('');
    out('== 2. 创建集合 ==');
    const name = `demo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const collection = store.createCollection(name);
    out(`  集合已创建：id=${collection.id} name=${collection.name}`);

    out('');
    out('== 3. 导入图片（复制到数据目录，源文件不改动）==');
    const importedIds = new Map<string, number>();
    for (const sample of samples) {
      const result = store.importImage(
        collection.id,
        fs.readFileSync(sample.file),
        path.basename(sample.file),
      );
      if (result.image) importedIds.set(path.basename(sample.file), result.image.id);
      out(
        `  [${result.status}] ${path.basename(sample.file)} -> image_id=${result.image?.id ?? '-'} ` +
          `sha256=${result.image?.sha256.slice(0, 12) ?? '-'} dhash=${result.image?.dhash ?? '-'}`,
      );
    }

    out('');
    out('== 4. 重复导入同一文件（验证去重）==');
    const firstFile = samples[0]!.file;
    const again = store.importImage(
      collection.id,
      fs.readFileSync(firstFile),
      path.basename(firstFile),
    );
    out(`  [${again.status}] 重复导入返回既有 image_id=${again.image?.id}`);

    const queryImageId = importedIds.get(path.basename(firstFile))!;
    const queryAt = (threshold: number): number => {
      const result = store.queryByImageId(collection.id, queryImageId, {
        threshold,
        limit: config.defaultLimit,
        includeSelf: false,
      });
      out(`  -- 阈值 threshold=${threshold}（默认不返回自身，共 ${result.count} 个候选）--`);
      for (const item of result.results) {
        out(
          `     #${item.rank} distance=${String(item.distance).padStart(2)} ` +
            `[${item.match_type}] ${item.original_name} (image_id=${item.image_id})`,
        );
      }
      if (result.results.length === 0) out('     （无候选）');
      return result.queryId;
    };

    out('');
    out('== 5. 阈值扫描：0 / 8 / 16 / 24（演示候选随阈值增加）==');
    queryAt(0);
    queryAt(8);
    const queryIdDefault = queryAt(16);
    queryAt(24);

    out('');
    out('== 6. includeSelf=true 时应标出自身为 identical ==');
    const selfResult = store.queryByImageId(collection.id, queryImageId, {
      threshold: 0,
      limit: 10,
      includeSelf: true,
    });
    for (const item of selfResult.results) {
      out(`     distance=${item.distance} [${item.match_type}] ${item.original_name}`);
    }

    out('');
    out('== 7. 导出报告 ==');
    const reportPath = path.join(config.dataDir, 'reports', `query-${queryIdDefault}.json`);
    const written = exportReport(store, collection.id, queryIdDefault, reportPath);
    out(`  报告已导出：${written}`);
    out('');
    out(`演示集合 id=${collection.id}，可用 CLI/API 复查。`);
    return lines.join('\n');
  } finally {
    store.close();
  }
};
