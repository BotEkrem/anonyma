import { ErrorCodes } from '@anonyma/contracts';

const GONE_ROOM = 'This room is gone or expired. Head back to the lobby.';
const SESSION_ENDED = 'Your session ended. Reload the page to start a new one.';
const BAD_INVITE = 'That invite code is invalid or expired.';
const BUSY = 'The service is busy right now. Try again in a moment.';

/**
 * Copy for an API error code. Codes without their own copy (null) keep the
 * server's wording, which is already written for people.
 */
const COPY_BY_CODE: Record<string, string | null> = {
  [ErrorCodes.INVALID_ID]: 'This room link is invalid. Head back to the lobby.',
  [ErrorCodes.MESSAGE_NOT_FOUND]: 'That message is no longer available.',
  [ErrorCodes.SESSION_INVALID]: SESSION_ENDED,
  [ErrorCodes.SESSION_REQUIRED]: SESSION_ENDED,
  [ErrorCodes.ROOM_NOT_FOUND]: GONE_ROOM,
  [ErrorCodes.ROOM_EXPIRED]: GONE_ROOM,
  [ErrorCodes.NOT_ROOM_MEMBER]: 'Join this room to continue.',
  [ErrorCodes.INVITE_REQUIRED]: 'This room needs an invite code.',
  [ErrorCodes.INVITE_INVALID]: BAD_INVITE,
  [ErrorCodes.INVITE_UNAVAILABLE]: BAD_INVITE,
  [ErrorCodes.VERIFICATION_FAILED]: 'Complete the verification challenge, then try again.',
  [ErrorCodes.RATE_LIMITED]: 'Too many attempts. Wait a moment and try again.',
  [ErrorCodes.ROOM_FULL]: 'This room is full.',
  [ErrorCodes.NOT_MESSAGE_OWNER]: 'You can only change your own messages.',
  [ErrorCodes.SESSION_CHECK_UNAVAILABLE]: BUSY,
  [ErrorCodes.UPSTREAM_UNAVAILABLE]: BUSY,
  [ErrorCodes.MESSAGE_INVALID]: null,
  [ErrorCodes.MESSAGE_CONFLICT]: null,
  [ErrorCodes.ROOM_HAS_NO_CALLS]: null,
  [ErrorCodes.MEDIA_UNAVAILABLE]: null,
};

/** User-facing copy for a code, or null when the code has none (or is unknown). */
export function copyForCode(code: string | undefined): string | null {
  return code ? (COPY_BY_CODE[code] ?? null) : null;
}

/** Map raw API / validation errors to short user-facing copy. */
export function friendlyError(raw: unknown, fallback = 'Something went wrong'): string {
  // Errors from api.ts already carry copy chosen from their code.
  const code = (raw as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && raw instanceof Error && raw.message.trim()) {
    return raw.message.trim();
  }
  const msg = (raw instanceof Error ? raw.message : String(raw ?? '')).trim();
  if (!msg) return fallback;
  // Older servers send no code: guess from the wording.

  if (/uuid|roomid must|must be a uuid|validation failed/i.test(msg)) {
    return 'This room link is invalid. Head back to the lobby.';
  }
  // Specific "not found"s first: a missing message is not a missing room.
  if (/message not found|reply target|cannot edit a deleted/i.test(msg)) {
    return 'That message is no longer available.';
  }
  if (/invalid session|session (expired|not found)|\b401\b/i.test(msg)) {
    return 'Your session ended. Reload the page to start a new one.';
  }
  if (/not found|expired|404/i.test(msg)) {
    return 'This room is gone or expired. Head back to the lobby.';
  }
  if (/not a room member|forbidden|403/i.test(msg)) {
    return 'Join this room to continue.';
  }
  if (/invite required/i.test(msg)) {
    return 'This room needs an invite code.';
  }
  if (/invite|invalid invite/i.test(msg)) {
    return 'That invite code is invalid or expired.';
  }
  if (/turnstile|verification|challenge|human/i.test(msg)) {
    return 'Complete the verification challenge, then try again.';
  }
  if (/rate limit|too many/i.test(msg)) {
    return 'Too many attempts. Wait a moment and try again.';
  }
  // Chrome: "Failed to fetch"; Safari: "Load failed"; Firefox: "NetworkError…".
  if (/network|failed to fetch|load failed|unreachable/i.test(msg)) {
    return 'Connection problem. Check your network and try again.';
  }
  // Hide Nest/class-validator style internals
  if (/must be|should not|must not|expected|dto|validation/i.test(msg) && msg.length < 120) {
    return fallback;
  }
  return msg.length > 160 ? fallback : msg;
}
