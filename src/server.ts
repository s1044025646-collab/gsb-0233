import express, { NextFunction, Request, Response } from 'express';
import { AddressInfo } from 'net';
import { AppConfig } from './config';
import { AppError } from './errors';
import { Store } from './store';

export function createApp(store: Store, config: AppConfig) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const rawPng = express.raw({
    type: ['image/png', 'application/octet-stream'],
    limit: config.maxFileBytes,
  });

  const parseId = (v: string, what: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      throw new AppError('INVALID_ARGUMENT', `${what} 必须是正整数`);
    }
    return n;
  };
  const intParam = (v: unknown): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new AppError('INVALID_ARGUMENT', `参数必须是整数：${v}`);
    return n;
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/collections', (req, res) => {
    const name = (req.body as { name?: string })?.name;
    if (!name) throw new AppError('INVALID_ARGUMENT', '缺少 name');
    res.status(201).json(store.createCollection(name));
  });

  app.get('/api/collections', (_req, res) => res.json(store.listCollections()));

  app.get('/api/collections/:id', (req, res) => {
    res.json(store.getCollection(parseId(req.params.id, '集合 ID')));
  });

  app.post('/api/collections/:id/images', rawPng, (req, res) => {
    const collectionId = parseId(req.params.id, '集合 ID');
    const filename =
      (req.query.filename as string) ||
      (req.headers['x-filename'] as string) ||
      'upload.png';
    const result = store.importImage(collectionId, req.body as Buffer, filename);
    res.status(result.status === 'duplicate' ? 200 : 201).json(result);
  });

  app.get('/api/collections/:id/images', (req, res) => {
    res.json(store.listImages(parseId(req.params.id, '集合 ID')));
  });

  app.get('/api/collections/:id/imports', (req, res) => {
    res.json(store.listImports(parseId(req.params.id, '集合 ID')));
  });

  app.get('/api/images/:id', (req, res) => {
    res.json(store.getImage(parseId(req.params.id, '图片 ID')));
  });

  app.get('/api/images/:id/file', (req, res) => {
    const img = store.getImage(parseId(req.params.id, '图片 ID'));
    res.type('image/png').sendFile(img.stored_path);
  });

  // 用已导入图片查询
  app.post('/api/collections/:id/query', (req, res) => {
    const collectionId = parseId(req.params.id, '集合 ID');
    const body = req.body as { imageId?: number; threshold?: number; limit?: number };
    if (!body || body.imageId === undefined) {
      throw new AppError('INVALID_ARGUMENT', '缺少 imageId');
    }
    res.json(
      store.querySimilar({
        collectionId,
        source: 'stored',
        imageId: body.imageId,
        threshold: body.threshold,
        limit: body.limit,
      }),
    );
  });

  // 用新上传图片查询（不写入图片表）
  app.post('/api/collections/:id/query-upload', rawPng, (req, res) => {
    const collectionId = parseId(req.params.id, '集合 ID');
    res.json(
      store.querySimilar({
        collectionId,
        source: 'upload',
        uploadBuffer: req.body as Buffer,
        threshold: intParam(req.query.threshold),
        limit: intParam(req.query.limit),
      }),
    );
  });

  app.get('/api/collections/:id/queries', (req, res) => {
    res.json(store.listQueries(parseId(req.params.id, '集合 ID')));
  });

  app.get('/api/queries/:id', (req, res) => {
    res.json(store.getQuery(parseId(req.params.id, '查询 ID')));
  });

  app.get('/api/queries/:id/export', (req, res) => {
    const format = req.query.format === 'md' ? 'md' : 'json';
    const content = store.exportQuery(parseId(req.params.id, '查询 ID'), format);
    res
      .type(format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json')
      .send(content);
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const anyErr = err as { type?: string; status?: number };
    if (anyErr.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: '请求体超过大小上限' } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
  });

  return app;
}

export function startServer(
  store: Store,
  config: AppConfig,
  port: number,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createApp(store, config).listen(port, () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
