/**
 * Stable error codes, sent next to the message in API error bodies as
 * `{ statusCode, message, code }`. Clients branch on the code, never on the
 * wording. This file imports nothing: the web app uses it through
 * src/contracts.ts.
 */
export const ErrorCodes = {
  SESSION_REQUIRED: 'session_required',
  SESSION_INVALID: 'session_invalid',
  /** The session could not be checked (a service is down): not a sign-out. */
  SESSION_CHECK_UNAVAILABLE: 'session_check_unavailable',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  INTERNAL: 'internal',
  INVALID_ID: 'invalid_id',
  BAD_REQUEST: 'bad_request',
  VERIFICATION_FAILED: 'verification_failed',
  RATE_LIMITED: 'rate_limited',
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_EXPIRED: 'room_expired',
  ROOM_FULL: 'room_full',
  NOT_ROOM_MEMBER: 'not_room_member',
  INVITE_REQUIRED: 'invite_required',
  INVITE_INVALID: 'invite_invalid',
  INVITE_UNAVAILABLE: 'invite_unavailable',
  ROOM_HAS_NO_CALLS: 'room_has_no_calls',
  MEDIA_UNAVAILABLE: 'media_unavailable',
  MESSAGE_NOT_FOUND: 'message_not_found',
  MESSAGE_INVALID: 'message_invalid',
  MESSAGE_CONFLICT: 'message_conflict',
  NOT_MESSAGE_OWNER: 'not_message_owner',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** What an RPC error carries, whichever shape Nest's RabbitMQ transport gave it. */
export interface RpcErrorInfo {
  status?: number;
  message?: string | string[];
  code?: string;
}

function pickMessage(raw: unknown): string | string[] | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw) && raw.length) return raw.map(String);
  return undefined;
}

function pickCode(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[a-z_]{2,40}$/.test(raw) ? raw : undefined;
}

function pickStatus(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof n === 'number' && n >= 100 && n <= 599 ? n : undefined;
}

/**
 * Reads status, message and code from an error received over RPC. The shapes
 * seen: `{ statusCode, message, code }` (RpcException with an object), that
 * object under `message` or `error`, `{ status, message }`, or a bare string.
 */
export function readRpcError(err: unknown): RpcErrorInfo {
  if (typeof err === 'string') return { message: pickMessage(err) };
  if (!err || typeof err !== 'object') return {};
  const e = err as Record<string, unknown>;
  for (const inner of [e.message, e.error]) {
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && 'statusCode' in inner) {
      const o = inner as Record<string, unknown>;
      return {
        status: pickStatus(o.statusCode),
        message: pickMessage(o.message),
        code: pickCode(o.code),
      };
    }
  }
  return {
    status: pickStatus(e.statusCode) ?? pickStatus(e.status),
    message: pickMessage(e.message),
    code: pickCode(e.code),
  };
}
