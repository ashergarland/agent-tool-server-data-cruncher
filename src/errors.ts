export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'payload_too_large'
  | 'output_limit'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_error'
  | 'busy'
  | 'internal_error';

const statusByCode: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  output_limit: 413,
  rate_limited: 429,
  timeout: 504,
  upstream_error: 502,
  busy: 503,
  internal_error: 500,
};

export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly statusCode: number;

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.statusCode = statusByCode[code];
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', message, details);
export const unauthorized = (message: string): AppError => new AppError('unauthorized', message);
export const forbidden = (message: string, details?: unknown): AppError =>
  new AppError('forbidden', message, details);
export const notFound = (message: string, details?: unknown): AppError =>
  new AppError('not_found', message, details);
export const payloadTooLarge = (message: string, details?: unknown): AppError =>
  new AppError('payload_too_large', message, details);
export const outputLimit = (message: string, details?: unknown): AppError =>
  new AppError('output_limit', message, details);
export const timedOut = (message: string, details?: unknown): AppError =>
  new AppError('timeout', message, details);
export const busy = (message: string, details?: unknown): AppError =>
  new AppError('busy', message, details, true);
export const upstreamError = (message: string, details?: unknown): AppError =>
  new AppError('upstream_error', message, details, true);

export const toAppError = (error: unknown): AppError =>
  error instanceof AppError
    ? error
    : new AppError(
        'internal_error',
        'The tool server failed to complete the request',
        undefined,
        false,
        error,
      );
