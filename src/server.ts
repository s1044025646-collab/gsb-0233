import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { type AppConfig, resolveConfig } from './config.js';
import { AppError, errorStatus } from './errors.js';
import { parseMultipart } from './multipart.js';
import { Store } from './store.js';

const readBody = (req: http.IncomingMessage, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError('FILE_TOO_LARGE', `请求体超过上限 ${maxBytes} 字节（含 multipart 开销）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(new AppError('BAD_REQUEST', `读取请求体失败: ${err.message}`)));
  });

export const createServer = (configOverrides?: Partial<AppConfig>) => {
  const config = resolveConfig(configOverrides);
  const store = new Store(config);

  const sendJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof AppError) {
        sendJson(res, err.httpStatus || errorStatus(err.code), {
          error: { code: err.code, message: err.message, details: err.details },
        });
      } else {
        sendJson(res, 500, {
          error: { code: 'INTERNAL', message: (err as Error).message ?? '未知错误' },
        });
      }
    });
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    let match = /^\/api\/collections\/(\d+)\/queries\/(\d+)$/.exec(pathname);
    if (match && method === 'GET') {
      const collectionId = Number(match[1]);
      const queryId = Number(match[2]);
      const row = store.db
        .prepare('SELECT * FROM queries WHERE id = ? AND collection_id = ?')
        .get(queryId, collectionId);
      if (!row) throw new AppError('NOT_FOUND', `查询记录 id=${queryId} 不存在`, 404);
      const results = store.db
        .prepare(
          `SELECT qr.rank, qr.distance, qr.match_type,
                  i.id AS image_id, i.sha256, i.dhash, i.original_name,
                  i.width, i.height, i.file_size
           FROM query_results qr JOIN images i ON i.id = qr.image_id
           WHERE qr.query_id = ? ORDER BY qr.rank ASC`,
        )
        .all(queryId);
      sendJson(res, 200, { query: row, results });
      return;
    }

    match = /^\/api\/collections\/(\d+)\/images\/(\d+)\/query$/.exec(pathname);
    if (match && method === 'POST') {
      const postCollectionId = Number(match[1]);
      const imageId = Number(match[2]);
      const params = queryParams(url, config);
      const result = store.queryByImageId(postCollectionId, imageId, params);
      sendJson(res, 200, result);
      return;
    }

    match = /^\/api\/collections\/(\d+)\/query$/.exec(pathname);
    if (match && method === 'POST') {
      const uploadCollectionId = Number(match[1]);
      const body = await readBody(req, config.maxFileBytes + 1024 * 1024);
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', '查询上传需要 multipart/form-data，字段名为 image');
      }
      const parsed = parseMultipart(body, contentType);
      const file = parsed.files['image'];
      if (!file) throw new AppError('BAD_REQUEST', '缺少文件字段 image');
      const threshold = url.searchParams.has('threshold')
        ? Number(url.searchParams.get('threshold'))
        : parsed.fields['threshold'] !== undefined
          ? Number(parsed.fields['threshold'])
          : config.defaultThreshold;
      const limit = url.searchParams.has('limit')
        ? Number(url.searchParams.get('limit'))
        : parsed.fields['limit'] !== undefined
          ? Number(parsed.fields['limit'])
          : config.defaultLimit;
      const includeSelf = url.searchParams.has('includeSelf')
        ? url.searchParams.get('includeSelf') === 'true'
        : (parsed.fields['includeSelf'] ?? 'false') === 'true';
      const result = store.querySimilar(uploadCollectionId, {
        bytes: file.data,
        originalName: file.filename,
        threshold,
        limit,
        includeSelf,
      });
      sendJson(res, 200, result);
      return;
    }

    match = /^\/api\/collections\/(\d+)\/imports$/.exec(pathname);
    if (match && method === 'GET') {
      sendJson(res, 200, { imports: store.listImports(Number(match[1])) });
      return;
    }

    match = /^\/api\/collections\/(\d+)\/queries$/.exec(pathname);
    if (match && method === 'GET') {
      sendJson(res, 200, { queries: store.listQueries(Number(match[1])) });
      return;
    }

    match = /^\/api\/collections\/(\d+)\/images\/(\d+)$/.exec(pathname);
    if (match && method === 'GET') {
      sendJson(res, 200, { image: store.getImage(Number(match[1]), Number(match[2])) });
      return;
    }

    match = /^\/api\/collections\/(\d+)\/images$/.exec(pathname);
    if (match) {
      const collectionId = Number(match[1]);
      if (method === 'GET') {
        sendJson(res, 200, { images: store.listImages(collectionId) });
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req, config.maxFileBytes + 1024 * 1024);
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
          throw new AppError('UNSUPPORTED_MEDIA_TYPE', '导入需要 multipart/form-data，字段名为 image');
        }
        const parsed = parseMultipart(body, contentType);
        const file = parsed.files['image'];
        if (!file) throw new AppError('BAD_REQUEST', '缺少文件字段 image');
        if (!file.filename.toLowerCase().endsWith('.png')) {
          throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 .png 文件');
        }
        const result = store.importImage(collectionId, file.data, file.filename);
        sendJson(res, result.status === 'imported' ? 201 : 200, result);
        return;
      }
    }

    match = /^\/api\/collections\/(\d+)$/.exec(pathname);
    if (match && method === 'GET') {
      const id = Number(match[1]);
      const collection = store.getCollection(id);
      sendJson(res, 200, {
        ...collection,
        image_count: store.listImages(id).length,
      });
      return;
    }

    if (pathname === '/api/collections') {
      if (method === 'GET') {
        sendJson(res, 200, { collections: store.listCollections() });
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req, 64 * 1024);
        let parsed: { name?: string } = {};
        try {
          parsed = body.length ? (JSON.parse(body.toString('utf8')) as { name?: string }) : {};
        } catch {
          throw new AppError('BAD_REQUEST', '请求体必须是合法 JSON，例如 {"name":"demo"}');
        }
        if (typeof parsed.name !== 'string') {
          throw new AppError('INVALID_ARGUMENT', '缺少字符串字段 name');
        }
        const collection = store.createCollection(parsed.name);
        sendJson(res, 201, collection);
        return;
      }
    }

    throw new AppError('NOT_FOUND', `未找到路由 ${method} ${pathname}`, 404);
  };

  return {
    server,
    store,
    close: (): void => {
      server.close();
      store.close();
    },
  };
};

const queryParams = (
  url: URL,
  config: AppConfig,
): { threshold: number; limit: number; includeSelf: boolean } => {
  const threshold = url.searchParams.has('threshold')
    ? Number(url.searchParams.get('threshold'))
    : config.defaultThreshold;
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : config.defaultLimit;
  const includeSelf = url.searchParams.get('includeSelf') === 'true';
  return { threshold, limit, includeSelf };
};

export const listen = async (
  port: number | undefined,
  configOverrides?: Partial<AppConfig>,
): Promise<{ app: ReturnType<typeof createServer>; port: number }> => {
  const app = createServer(configOverrides);
  await new Promise<void>((resolve) => {
    app.server.listen(port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = app.server.address() as AddressInfo;
  return { app, port: address.port };
};
