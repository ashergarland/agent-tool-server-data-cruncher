import type { AppConfig } from '../config/index.js';
import { AppError, toAppError, type ErrorCode } from '../errors.js';
import type { HttpServer } from './types.js';

const codeByStatus: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'bad_request',
  406: 'bad_request',
  413: 'payload_too_large',
  415: 'bad_request',
  429: 'rate_limited',
};

/**
 * Framework-level failures such as malformed JSON or an oversized body already carry a 4xx status.
 * Without this mapping they would surface as a misleading internal error.
 */
const asAppError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status in codeByStatus) {
    const message = (error as { message?: unknown }).message;
    return new AppError(
      codeByStatus[status] as ErrorCode,
      typeof message === 'string' && message.length > 0 && message.length <= 300
        ? message
        : 'The request could not be processed',
      undefined,
      status === 429,
    );
  }
  return toAppError(error);
};

export const registerErrorHandler = (app: HttpServer, config: AppConfig): void => {
  app.setErrorHandler((error, request, reply) => {
    const appError = asAppError(error);
    const message =
      config.isProduction && appError.statusCode >= 500
        ? 'The tool server failed to complete the request'
        : appError.message;

    if (appError.statusCode >= 500) {
      request.log.error({ err: error, event: 'request.error' }, 'unhandled request failure');
    }

    void reply.status(appError.statusCode).send({
      error: {
        code: appError.code,
        message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
        retryable: appError.retryable,
        requestId: request.id,
      },
    });
  });
};
