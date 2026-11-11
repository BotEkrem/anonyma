import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { EMPTY_ROOM_GRACE_SECONDS, MESSAGE_TTL_SECONDS } from '@anonyma/shared';
import { REDIS } from '@anonyma/nest-common';
import { nextExpiry } from '../room/members';
import { DRIZZLE, type DrizzleDb } from './database.module';
import { anonymousSessions, moderationEvents, rooms } from './schema';

/**
 * Realtime's presence contract (apps/realtime/src/presence.rs): sorted set
 * `online:{roomId}`, member `session|conn`, score = last heartbeat in unix
 * seconds; a socket counts for 90 s after its last beat (it beats every 30 s).
 */
const PRESENCE_KEY = (roomId: string) => `online:${roomId}`;
const PRESENCE_WINDOW_SECONDS = 90;
/** Purge runs every minute: look this far ahead so a present room never lapses. */
const KEEPALIVE_LOOKAHEAD_MS = 3 * 60_000;

@Injectable()
export class PurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PurgeService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  /** Someone has a live socket in the room right now. */
  private async hasPresence(roomId: string): Promise<boolean> {
    const since = Math.floor(Date.now() / 1000) - PRESENCE_WINDOW_SECONDS;
    const live = await this.redis.zcount(PRESENCE_KEY(roomId), `(${since}`, '+inf');
    return live > 0;
  }

  /**
   * Only joining, sending, editing, a chat (re)connect and a call start used to
   * extend a room; a quiet call or a room people only read was deleted under
   * them after ten minutes. Rooms with a live socket now stay.
   */
  private async keepPresentRoomsAlive(ttlSeconds: number): Promise<void> {
    const dueBy = new Date(Date.now() + KEEPALIVE_LOOKAHEAD_MS);
    const due = await this.db
      .select({ id: rooms.id, expiresAt: rooms.expiresAt })
      .from(rooms)
      .where(lt(rooms.expiresAt, dueBy));
    for (const room of due) {
      if (!(await this.hasPresence(room.id))) continue;
      const expiresAt = nextExpiry(room.expiresAt, Date.now(), ttlSeconds * 1000);
      await this.db.update(rooms).set({ expiresAt }).where(eq(rooms.id, room.id));
      // The invite lives in Redis with the room's remaining life.
      const inviteKey = `room:invite:${room.id}`;
      if (await this.redis.exists(inviteKey)) {
        await this.redis.expire(inviteKey, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
      }
    }
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.purgeExpired();
    }, 60_000);
    void this.purgeExpired();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async purgeExpired(): Promise<void> {
    const now = new Date();
    const ttl = Number(this.config.get('MESSAGE_TTL_SECONDS') ?? MESSAGE_TTL_SECONDS);
    const grace = Number(
      this.config.get('EMPTY_ROOM_GRACE_SECONDS') ?? EMPTY_ROOM_GRACE_SECONDS,
    );
    try {
      // Legacy public/private rooms had no expiry; align them with message lifetime.
      await this.db
        .update(rooms)
        .set({
          expiresAt: sql`${rooms.createdAt} + make_interval(secs => ${ttl})`,
        })
        .where(and(isNull(rooms.expiresAt), ne(rooms.type, 'match')));

      // Orphan empty rooms (left without scheduling grace, or pre-fix rows):
      // pull expiry in so they do not linger for the full message TTL.
      await this.db.execute(sql`
        UPDATE rooms AS r
        SET expires_at = now() + make_interval(secs => ${grace})
        WHERE NOT EXISTS (
          SELECT 1 FROM room_members AS m WHERE m.room_id = r.id
        )
        AND (r.expires_at IS NULL OR r.expires_at > now() + make_interval(secs => ${grace}))
      `);

      try {
        await this.keepPresentRoomsAlive(ttl);
      } catch (err) {
        // Presence is a bonus: without Redis, rooms expire as they always did.
        this.logger.warn(`Presence keepalive failed: ${(err as Error).message}`);
      }

      await this.db.delete(anonymousSessions).where(lt(anonymousSessions.expiresAt, now));
      await this.db.delete(rooms).where(lt(rooms.expiresAt, new Date()));
      await this.db.delete(moderationEvents).where(lt(moderationEvents.expiresAt, now));
    } catch (err) {
      this.logger.warn(`Purge failed: ${(err as Error).message}`);
    }
  }
}
