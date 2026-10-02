export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'FILE_TOO_LARGE'
  | 'IMAGE_TOO_SMALL'
  | 'IMAGE_TOO_LARGE_DIMENSIONS'
  | 'INVALID_PNG'
  | 'EMPTY_COLLECTION'
  | 'STORAGE_ERROR'
  | 'METHOD_NOT_ALLOWED'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, httpStatus = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const errorStatus = (code: ErrorCode): number => {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 415;
    case 'FILE_TOO_LARGE':
    case 'IMAGE_TOO_LARGE_DIMENSIONS':
      return 413;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'STORAGE_ERROR':
    case 'INTERNAL':
      return 500;
    default:
      return 400;
  }
};
