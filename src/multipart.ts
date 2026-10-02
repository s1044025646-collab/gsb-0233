import { AppError } from './errors.js';

export interface MultipartFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartResult {
  fields: Record<string, string>;
  files: Record<string, MultipartFile>;
}

const CRLF = Buffer.from('\r\n');

/**
 * 最小化 multipart/form-data 解析器，仅满足本服务上传单个 PNG 的需求。
 */
export const parseMultipart = (body: Buffer, contentType: string): MultipartResult => {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) {
    throw new AppError('BAD_REQUEST', 'Content-Type 缺少 multipart boundary');
  }
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  const fields: Record<string, string> = {};
  const files: Record<string, MultipartFile> = {};

  let cursor = body.indexOf(boundary);
  if (cursor === -1) throw new AppError('BAD_REQUEST', 'multipart 数据中找不到 boundary');
  cursor += boundary.length;

  while (true) {
    if (body.slice(cursor, cursor + 2).equals(CRLF)) cursor += 2;
    if (body.slice(cursor, cursor + 2).equals(Buffer.from('--'))) break;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) throw new AppError('BAD_REQUEST', 'multipart 分块头不完整');
    const headersText = body.toString('utf8', cursor, headerEnd);
    const partStart = headerEnd + 4;
    const nextBoundary = body.indexOf(Buffer.concat([CRLF, boundary]), partStart);
    if (nextBoundary === -1) throw new AppError('BAD_REQUEST', 'multipart 分块数据不完整');
    const partData = body.subarray(partStart, nextBoundary);

    let name = '';
    let filename = '';
    let partContentType = 'application/octet-stream';
    for (const line of headersText.split('\r\n')) {
      const nameMatch = /name="([^"]*)"/.exec(line);
      if (nameMatch) name = nameMatch[1]!;
      const filenameMatch = /filename="([^"]*)"/.exec(line);
      if (filenameMatch) filename = filenameMatch[1]!;
      if (line.toLowerCase().startsWith('content-type:')) {
        partContentType = line.slice('content-type:'.length).trim();
      }
    }

    if (filename) {
      files[name] = { filename, contentType: partContentType, data: Buffer.from(partData) };
    } else if (name) {
      fields[name] = partData.toString('utf8');
    }
    cursor = nextBoundary + CRLF.length + boundary.length;
  }
  return { fields, files };
};
