import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { parseEncryptionKey, encryptAesGcm, decryptAesGcm, deriveSubkey } from './crypto';

export function assertRpcSecret(payload: { rpcSecret?: string }, expected: string): void {
  const provided = payload?.rpcSecret ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Unauthorized RPC');
  }
}

export function withRpcSecret<T extends Record<string, unknown>>(
  payload: T,
  rpcSecret: string,
): T & { rpcSecret: string } {
  return { ...payload, rpcSecret };
}

export interface WsTicketClaims {
  sessionHash: string;
  roomId: string;
  exp: number;
  jti: string;
}

function ticketSigningKey(secret: string): Buffer {
  return createHmac('sha256', 'anonyma-ws-ticket-v2').update(secret).digest();
}

export function issueWsTicket(
  claims: Omit<WsTicketClaims, 'exp' | 'jti'> & { ttlSeconds?: number; jti?: string },
  secret: string,
): string {
  const exp = Math.floor(Date.now() / 1000) + (claims.ttlSeconds ?? 60);
  const jti = claims.jti ?? randomBytes(16).toString('base64url');
  const payload = JSON.stringify({
    sessionHash: claims.sessionHash,
    roomId: claims.roomId,
    exp,
    jti,
  });
  const { ciphertext, iv } = encryptAesGcm(payload, ticketSigningKey(secret));
  const body = Buffer.concat([iv, ciphertext]).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyWsTicket(ticket: string, secret: string): WsTicketClaims {
  const [body, sig] = ticket.split('.');
  if (!body || !sig) {
    throw new Error('Invalid ticket');
  }
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid ticket signature');
  }
  const packed = Buffer.from(body, 'base64url');
  if (packed.length <= 12) {
    throw new Error('Invalid ticket body');
  }
  const iv = packed.subarray(0, 12);
  const ciphertext = packed.subarray(12);
  const claims = JSON.parse(
    decryptAesGcm(ciphertext, iv, ticketSigningKey(secret)),
  ) as WsTicketClaims;
  if (!claims.sessionHash || !claims.roomId || !claims.exp || !claims.jti) {
    throw new Error('Invalid ticket claims');
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Ticket expired');
  }
  return claims;
}

export function wsTicketRedisKey(jti: string): string {
  return `wsticket:${jti}`;
}

/** Encrypt a JSON-serializable payload for the RMQ bus. */
export function encryptBusPayload(payload: unknown, keyHex: string): { c: string; iv: string } {
  // The bus has its own subkey (apps/realtime derives the same one).
  const key = deriveSubkey(parseEncryptionKey(keyHex), 'bus');
  const { ciphertext, iv } = encryptAesGcm(JSON.stringify(payload), key);
  return {
    c: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
  };
}
