import { decryptAesGcm, deriveSubkey, encryptAesGcm } from '@anonyma/shared';

type Purpose = 'message' | 'nickname' | 'invite';

/**
 * Keys per purpose, derived from the configured key (and the previous one while
 * rotating). New data uses the current subkey; reading tries the subkeys, then
 * the plain configured key(s) that sealed everything before subkeys existed.
 */
export class Keyring {
  private readonly sub: Record<Purpose, Buffer[]>;
  private readonly legacy: Buffer[];

  constructor(current: Buffer, previous?: Buffer) {
    const masters = previous ? [current, previous] : [current];
    const derive = (purpose: Purpose) => masters.map((m) => deriveSubkey(m, purpose));
    this.sub = { message: derive('message'), nickname: derive('nickname'), invite: derive('invite') };
    this.legacy = masters;
  }

  encrypt(purpose: Purpose, plaintext: string, aad?: Buffer): { ciphertext: Buffer; iv: Buffer } {
    return encryptAesGcm(plaintext, this.sub[purpose][0]!, aad);
  }

  decrypt(purpose: Purpose, ciphertext: Buffer, iv: Buffer, aad?: Buffer): string {
    return tryKeys(ciphertext, iv, [...this.sub[purpose], ...this.legacy], aad);
  }

  /** `v2.iv.ciphertext`: purpose subkey, bound to `aad` (e.g. the room). */
  seal(purpose: Purpose, text: string, aad: Buffer): string {
    const { ciphertext, iv } = encryptAesGcm(text, this.sub[purpose][0]!, aad);
    return `v2.${iv.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  /** Opens `v2.` blobs and the older `iv.ciphertext` ones (plain key, no AAD); returns the input when it can't. */
  open(purpose: Purpose, sealed: string, aad: Buffer): string {
    try {
      if (sealed.startsWith('v2.')) {
        const [, ivB64, cB64] = sealed.split('.');
        if (!ivB64 || !cB64) return sealed;
        return tryKeys(b64(cB64), b64(ivB64), this.sub[purpose], aad);
      }
      const [ivB64, cB64] = sealed.split('.');
      if (!ivB64 || !cB64) return sealed;
      return tryKeys(b64(cB64), b64(ivB64), this.legacy);
    } catch {
      return sealed;
    }
  }
}

function b64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function tryKeys(ciphertext: Buffer, iv: Buffer, keys: Buffer[], aad?: Buffer): string {
  let lastErr: unknown;
  for (const key of keys) {
    try {
      return decryptAesGcm(ciphertext, iv, key, aad);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('decrypt failed');
}
