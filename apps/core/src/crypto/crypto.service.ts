import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateInviteCode,
  generateOpaqueToken,
  hashToken,
  parseEncryptionKey,
  uuidToBytes,
  bytesToUuid,
  hashTokenPrefix,
  roomPseudonym,
} from '@anonyma/shared';
import { Keyring } from './keyring';

@Injectable()
export class CryptoService implements OnModuleInit {
  private key!: Buffer;
  private keyring!: Keyring;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.key = parseEncryptionKey(this.config.getOrThrow<string>('MESSAGE_ENCRYPTION_KEY'));
    // Rotation: set the new key, keep the old one here until its data is gone.
    const previousRaw = this.config.get<string>('MESSAGE_ENCRYPTION_KEY_PREVIOUS');
    this.keyring = new Keyring(this.key, previousRaw ? parseEncryptionKey(previousRaw) : undefined);
  }

  /** How a session appears to others in one room (see roomPseudonym). */
  pseudonym(roomId: string, sessionHashHex: string): string {
    return roomPseudonym(this.key, roomId, sessionHashHex);
  }

  createSessionToken(): string {
    return generateOpaqueToken(32);
  }

  hashSessionToken(token: string): string {
    return hashToken(token);
  }

  sessionHashPrefix(token: string): Buffer {
    return hashTokenPrefix(token, 8);
  }

  createInviteCode(): string {
    return generateInviteCode();
  }

  hashInvite(code: string): string {
    return hashToken(code.toUpperCase());
  }

  encryptMessage(plaintext: string, aad?: Buffer): { ciphertext: Buffer; iv: Buffer } {
    return this.keyring.encrypt('message', plaintext, aad);
  }

  decryptMessage(ciphertext: Buffer, iv: Buffer, aad?: Buffer): string {
    // AAD is required when provided; messages from before the subkey still open.
    return this.keyring.decrypt('message', ciphertext, iv, aad);
  }

  /** At-rest nickname for Postgres, bound to its room (moving it elsewhere fails). */
  sealNickname(nickname: string, roomId: string): string {
    return this.keyring.seal('nickname', nickname, Buffer.from(`nick:${roomId}`));
  }

  openNickname(sealed: string, roomId: string): string {
    return this.keyring.open('nickname', sealed, Buffer.from(`nick:${roomId}`));
  }

  /** Invite code at rest in Redis, bound to its room. */
  sealInvite(code: string, roomId: string): string {
    return this.keyring.seal('invite', code, Buffer.from(`invite:${roomId}`));
  }

  openInvite(sealed: string, roomId: string): string {
    return this.keyring.open('invite', sealed, Buffer.from(`invite:${roomId}`));
  }

  roomIdToBinary(roomId: string): Buffer {
    return uuidToBytes(roomId);
  }

  binaryToRoomId(buf: Buffer): string {
    return bytesToUuid(buf);
  }
}
