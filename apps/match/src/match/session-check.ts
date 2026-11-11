import { RpcException } from '@nestjs/microservices';
import { ErrorCodes, readRpcError } from '@anonyma/shared';

/**
 * Only core saying "this session is invalid" is a 401. A timeout or a core
 * outage used to answer 401 too, and the page then dropped a good session.
 */
export function sessionCheckError(err: unknown): RpcException {
  if (readRpcError(err).status === 401) {
    return new RpcException({
      statusCode: 401,
      message: 'Invalid session',
      code: ErrorCodes.SESSION_INVALID,
    });
  }
  return new RpcException({
    statusCode: 503,
    message: 'Session check unavailable',
    code: ErrorCodes.SESSION_CHECK_UNAVAILABLE,
  });
}
