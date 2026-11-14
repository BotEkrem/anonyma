import { INVITE_CODE_LENGTH } from '../model/constants';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function parseEncryptionKey(hexOrBase64: string): Buffer {
  const trimmed = hexOrBase64.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    throw new Error('MESSAGE_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  }
  return buf;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** HMAC client IP for rate-limit keys — avoids storing raw IPs in Redis. */
export function hashClientIp(ip: string, pepper: string): string {
  return createHmac('sha256', pepper).update(ip.trim()).digest('hex').slice(0, 32);
}

/** Opaque LiveKit identity: room-scoped, not the durable session UUID. */
export function livekitIdentity(sessionId: string, roomId: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(`${sessionId}:${roomId}`)
    .digest('base64url')
    .slice(0, 32);
}

/**
 * A separate key per purpose (messages, nicknames, invites, the event bus),
 * derived from the one configured key: one key no longer encrypts every kind
 * of data. Data written before this used the configured key itself, so readers
 * fall back to it.
 */
export function deriveSubkey(masterKey: Buffer, purpose: string): Buffer {
  return createHmac('sha256', masterKey).update(`anonyma-key-v1:${purpose}`).digest();
}

/**
 * A session's id inside one room, as other people see it. The same person gets
 * an unrelated id in every room, so peers cannot follow someone from room to
 * room (they used to see the session's lasting id). Keyed by a subkey of the
 * message key, so no new secret is needed. Input is the first 16 hex chars of
 * the session hash (what messages store). apps/realtime/src/room/pseudonym.rs must
 * compute the same value.
 */
export function roomPseudonym(masterKey: Buffer, roomId: string, sessionHashHex: string): string {
  const subkey = createHmac('sha256', masterKey).update('anonyma-pseudonym-v1').digest();
  return createHmac('sha256', subkey)
    .update(`${roomId}:${sessionHashHex.slice(0, 16).toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

export function hashTokenPrefix(token: string, bytes = 8): Buffer {
  return createHash('sha256').update(token).digest().subarray(0, bytes);
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateInviteCode(length = INVITE_CODE_LENGTH): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[buf[i]! % alphabet.length];
  }
  return out;
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function encryptAesGcm(plaintext: string, key: Buffer, aad?: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  if (aad && aad.length > 0) {
    cipher.setAAD(aad);
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]),
    iv,
    authTag,
  };
}

/** Ciphertext buffer layout: encrypted || authTag(16) */
export function decryptAesGcm(
  ciphertextWithTag: Buffer,
  iv: Buffer,
  key: Buffer,
  aad?: Buffer,
): string {
  if (ciphertextWithTag.length <= AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext');
  }
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - AUTH_TAG_LENGTH);
  const data = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  if (aad && aad.length > 0) {
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error('Invalid UUID');
  }
  return Buffer.from(hex, 'hex');
}

export function bytesToUuid(buf: Buffer): string {
  if (buf.length !== 16) {
    throw new Error('UUID bytes must be 16 long');
  }
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}
