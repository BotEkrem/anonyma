import { RpcException } from '@nestjs/microservices';
import { assertRpcSecret, ErrorCodes } from '@anonyma/shared';

/**
 * A wrong or missing RPC secret is our own misconfiguration, not the user's:
 * it answers 500 "internal", never 401 (a 401 makes the page drop its session).
 * The wording avoids words old gateways read as statuses ("unauthorized").
 */
function rejected(): never {
  throw new RpcException({
    statusCode: 500,
    message: 'Internal RPC rejected',
    code: ErrorCodes.INTERNAL,
  });
}

export function requireRpcSecret(payload: { rpcSecret?: string }): void {
  const expected = process.env.INTERNAL_RPC_SECRET;
  if (!expected || expected.length < 32) {
    rejected();
  }
  try {
    assertRpcSecret(payload, expected);
  } catch {
    rejected();
  }
}
