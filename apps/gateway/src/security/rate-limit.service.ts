import { Inject, Injectable, HttpException, HttpStatus } from '@nestjs/common';
import Redis from 'ioredis';
import {
  RATE_LIMIT_MESSAGES_PER_MINUTE,
  RATE_LIMIT_READS_PER_MINUTE,
  RATE_LIMIT_ROOMS_PER_HOUR,
  RATE_LIMIT_WS_TICKETS_PER_MINUTE,
  ErrorCodes,
  hashClientIp,
} from '@anonyma/shared';
import { REDIS } from '@anonyma/nest-common';
import { identityPepper } from '../common/identity-pepper';
import { rateLimitBucketFromKey, rateLimitRejectionsTotal } from '../metrics/metrics';

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private readonly pepper = identityPepper();

  private ipKey(ip: string): string {
    return hashClientIp(ip, this.pepper);
  }

  // Each limiter checks the per-IP bucket first: a request with a made-up session
  // cookie is refused there before it can create a per-session key in Redis.
  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    const redisKey = `rl:${key}`;
    // Atomic incr + expire so a crash between INCR and EXPIRE cannot sticky-ban forever.
    const count = await this.redis.eval(
      `
      local c = redis.call('INCR', KEYS[1])
      if c == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return c
      `,
      1,
      redisKey,
      String(windowSeconds),
    );
    if (Number(count) > limit) {
      rateLimitRejectionsTotal.inc({ bucket: rateLimitBucketFromKey(key) });
      throw new HttpException(
        { statusCode: 429, message: 'Rate limit exceeded', code: ErrorCodes.RATE_LIMITED },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async limitMessage(sessionHint: string, ip: string): Promise<void> {
    const ipH = this.ipKey(ip);
    await this.consume(`msgip:${ipH}`, RATE_LIMIT_MESSAGES_PER_MINUTE * 2, 60);
    await this.consume(`msg:${sessionHint}`, RATE_LIMIT_MESSAGES_PER_MINUTE, 60);
  }

  async limitRoom(sessionHint: string, ip: string): Promise<void> {
    const ipH = this.ipKey(ip);
    await this.consume(`roomip:${ipH}`, RATE_LIMIT_ROOMS_PER_HOUR * 2, 3600);
    await this.consume(`room:${sessionHint}`, RATE_LIMIT_ROOMS_PER_HOUR, 3600);
  }

  async limitSession(ip: string): Promise<void> {
    await this.consume(`sessionip:${this.ipKey(ip)}`, 20, 3600);
  }

  async limitJoin(sessionHint: string, ip: string): Promise<void> {
    const ipH = this.ipKey(ip);
    await this.consume(`joinip:${ipH}`, 120, 3600);
    await this.consume(`join:${sessionHint}`, 60, 3600);
  }

  async limitMatch(sessionHint: string, ip: string): Promise<void> {
    const ipH = this.ipKey(ip);
    await this.consume(`matchip:${ipH}`, 60, 3600);
    await this.consume(`match:${sessionHint}`, 30, 3600);
  }

  async limitVoice(sessionHint: string, ip: string): Promise<void> {
    const ipH = this.ipKey(ip);
    await this.consume(`voiceip:${ipH}`, 60, 3600);
    await this.consume(`voice:${sessionHint}`, 30, 3600);
  }

  async limitWsTicket(sessionHint: string, ip: string): Promise<void> {
    const ipH = this.ipKey(ip);
    await this.consume(`wsticketip:${ipH}`, RATE_LIMIT_WS_TICKETS_PER_MINUTE * 2, 60);
    await this.consume(`wsticket:${sessionHint}`, RATE_LIMIT_WS_TICKETS_PER_MINUTE, 60);
  }

  async limitRead(sessionHint: string, ip: string): Promise<void> {
    const ipH = this.ipKey(ip);
    await this.consume(`readip:${ipH}`, RATE_LIMIT_READS_PER_MINUTE * 2, 60);
    await this.consume(`read:${sessionHint}`, RATE_LIMIT_READS_PER_MINUTE, 60);
  }
}
