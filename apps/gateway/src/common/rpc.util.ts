import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCodes, readRpcError, withRpcSecret } from '@anonyma/shared';
import { catchError, throwError, type MonoTypeOperatorFunction } from 'rxjs';

export function rpc<T extends Record<string, unknown>>(
  config: ConfigService,
  payload: T,
): T & { rpcSecret: string } {
  return withRpcSecret(payload, config.getOrThrow<string>('INTERNAL_RPC_SECRET'));
}

/** Status for errors that arrive without a code (older services, bare strings). */
function legacyStatus(message: string): number | undefined {
  if (/invalid or expired session|missing session|session required|unauthorized/i.test(message)) {
    return HttpStatus.UNAUTHORIZED;
  }
  if (
    /not message owner|forbidden|not a room member|invalid invite|invite required/i.test(message)
  ) {
    return HttpStatus.FORBIDDEN;
  }
  if (/not found|expired/i.test(message)) return HttpStatus.NOT_FOUND;
  if (/invalid message length|bad request/i.test(message)) return HttpStatus.BAD_REQUEST;
  return undefined;
}

/**
 * The HTTP answer for an error from core or match. Coded errors keep their
 * status and code; only uncoded 5xx strings still have their status guessed
 * from the wording (a coded "Internal RPC rejected" must stay a 500: a 401
 * makes the page drop its session).
 */
export function httpErrorFromRpc(err: unknown): HttpException {
  if ((err as { name?: unknown })?.name === 'TimeoutError') {
    return new HttpException(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Service temporarily unavailable',
        code: ErrorCodes.UPSTREAM_UNAVAILABLE,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  const info = readRpcError(err);
  let status = info.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
  const message: string | string[] =
    info.message && info.message !== 'Internal server error' ? info.message : 'Upstream error';
  if (info.code) {
    return new HttpException({ statusCode: status, message, code: info.code }, status);
  }
  if (status >= 500 && typeof message === 'string') {
    status = legacyStatus(message) ?? status;
  }
  return new HttpException(message, status);
}

/** Maps Nest microservice / RMQ errors into HTTP exceptions (preserve 4xx). */
export function mapRpc<T>(): MonoTypeOperatorFunction<T> {
  return catchError((err: unknown) => throwError(() => httpErrorFromRpc(err)));
}
