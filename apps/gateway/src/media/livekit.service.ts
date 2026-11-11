import { ErrorCodes } from '@anonyma/shared';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

export interface LiveKitJoinCredentials {
  url: string;
  token: string;
  roomName: string;
}

@Injectable()
export class LiveKitService {
  private healthCache: { ok: boolean; checkedAt: number } | null = null;
  private readonly healthOkTtlMs = 10_000;
  private readonly healthFailTtlMs = 3_000;

  private readonly logger = new Logger(LiveKitService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Take someone out of a room's call when they leave the room or end their
   * session. The token they joined with no longer lets them back in either: it
   * is short-lived, and they are no longer a member to get a new one.
   */
  async removeParticipant(roomName: string, identity: string): Promise<void> {
    const url = this.url();
    const apiKey = this.apiKey();
    const apiSecret = this.apiSecret();
    if (!url || !apiKey || !apiSecret) return;
    const host = url.replace(/^ws/i, 'http').replace(/\/+$/, '');
    try {
      await new RoomServiceClient(host, apiKey, apiSecret).removeParticipant(roomName, identity);
    } catch (err) {
      // Not in the call (the usual case for text rooms) is fine.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not found|does not exist|404/i.test(msg)) {
        this.logger.warn(`removeParticipant failed: ${msg}`);
      }
    }
  }

  isConfigured(): boolean {
    return Boolean(this.url() && this.apiKey() && this.apiSecret());
  }

  /** Configured env + recent successful reachability probe (cached). */
  async isAvailable(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const now = Date.now();
    if (this.healthCache) {
      const ttl = this.healthCache.ok ? this.healthOkTtlMs : this.healthFailTtlMs;
      if (now - this.healthCache.checkedAt < ttl) return this.healthCache.ok;
    }
    const ok = await this.probe();
    this.healthCache = { ok, checkedAt: now };
    return ok;
  }

  publicUrl(): string | null {
    return this.isConfigured() ? this.url() : null;
  }

  async issueJoinToken(input: {
    roomId: string;
    identity: string;
    nickname: string;
  }): Promise<LiveKitJoinCredentials> {
    const url = this.url();
    const apiKey = this.apiKey();
    const apiSecret = this.apiSecret();
    if (!url || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: 'Live media is not configured',
        code: ErrorCodes.MEDIA_UNAVAILABLE,
      });
    }
    if (!(await this.isAvailable())) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: 'Live media is not available right now',
        code: ErrorCodes.MEDIA_UNAVAILABLE,
      });
    }

    const roomName = input.roomId;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: input.identity,
      name: input.nickname.slice(0, 64) || 'anon',
      // Long enough to join; a connected call keeps going past it (LiveKit
      // refreshes the connection itself), but a token kept after leaving the
      // room stops working soon.
      ttl: '15m',
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return {
      url,
      token: await at.toJwt(),
      roomName,
    };
  }

  private async probe(): Promise<boolean> {
    const wsUrl = this.url();
    if (!wsUrl) return false;
    const httpUrl = wsUrl.replace(/^ws/i, 'http').replace(/\/+$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_500);
    try {
      const res = await fetch(httpUrl, { method: 'GET', signal: ctrl.signal });
      // LiveKit answers 200 on /. Proxies may 401/403/404 the root while the
      // process is up — treat those as available. 5xx / network errors = down
      // (do NOT treat every TCP response as healthy; that hid LiveKit-down).
      return res.status > 0 && res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private url(): string | null {
    const raw = this.config.get<string>('LIVEKIT_URL')?.trim();
    return raw || null;
  }

  private apiKey(): string | null {
    const raw = this.config.get<string>('LIVEKIT_API_KEY')?.trim();
    return raw || null;
  }

  private apiSecret(): string | null {
    const raw = this.config.get<string>('LIVEKIT_API_SECRET')?.trim();
    return raw || null;
  }
}
