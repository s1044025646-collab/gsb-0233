export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'INVALID_PNG'
  | 'FILE_TOO_LARGE'
  | 'DIMENSIONS_TOO_LARGE'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badArg(message: string): AppError {
  return new AppError('INVALID_ARGUMENT', message, 400);
}

export function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', message, 404);
}
