import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { firstValueFrom, timeout } from 'rxjs';
import {
  encryptBusPayload,
  hashToken,
  MATCH_MODES,
  MATCH_QUEUE_TTL_SECONDS,
  MATCH_ROOM_TTL_SECONDS,
  RmqPatterns,
  RMQ_EXCHANGE,
  RmqRoutingKeys,
  withRpcSecret,
  type MatchMode,
  type MatchPairView,
  type RoomView,
} from '@anonyma/shared';
import { BusPublisher, REDIS } from '@anonyma/nest-common';
import { judgeCandidate } from './pairing';
import {
  busPublishFailuresTotal,
  matchCancelTotal,
  matchEnqueueTotal,
  matchPairedTotal,
  matchQueueDepth,
} from '../metrics/metrics';
import { sessionCheckError } from './session-check';

const META_PREFIX = 'match:meta:';
const RESULT_PREFIX = 'match:result:';
/** Set while a waiter polls; a waiter without it has left (tab closed). */
const ALIVE_PREFIX = 'match:alive:';
/** Claimed by a pairing that is creating the room; status keeps saying queued. */
const PAIRING_PREFIX = 'match:pairing:';
const QUEUE_TTL_MS = MATCH_QUEUE_TTL_SECONDS * 1000;
/**
 * The page polls every 1.5 s, but a hidden tab's timers can slow to once a
 * minute, so liveness has to outlast that.
 */
const ALIVE_TTL_SECONDS = 90;

interface QueueEntry {
  sessionHash: string;
  nickname: string;
  mode: MatchMode;
  enqueuedAt: number;
}

interface QueueMeta {
  nickname: string;
  mode: MatchMode;
}

function queueKey(mode: MatchMode): string {
  return `match:queue:${mode}`;
}

function parseMode(raw: unknown): MatchMode {
  if (raw === 'voice' || raw === 'video' || raw === 'text') return raw;
  return 'text';
}

@Injectable()
export class MatchService implements OnModuleInit {
  private readonly logger = new Logger(MatchService.name);
  private readonly bus: BusPublisher;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject('CORE_SERVICE') private readonly core: ClientProxy,
    private readonly config: ConfigService,
  ) {
    this.bus = new BusPublisher(
      this.config.get<string>('RABBITMQ_EXCHANGE') ?? RMQ_EXCHANGE,
      (routingKey) => busPublishFailuresTotal.inc({ routing_key: routingKey }),
    );
  }

  onModuleInit(): void {
    this.bus.connect();
    void this.refreshQueueDepth();
    setInterval(() => void this.refreshQueueDepth(), 15_000).unref?.();
  }

  private async refreshQueueDepth(): Promise<void> {
    try {
      for (const mode of MATCH_MODES) {
        const len = await this.redis.llen(queueKey(mode));
        matchQueueDepth.set({ mode }, len);
      }
    } catch (err) {
      this.logger.warn(`queue depth scrape failed: ${(err as Error).message}`);
    }
  }

  private rpcSecret(): string {
    return this.config.getOrThrow<string>('INTERNAL_RPC_SECRET');
  }

  private async requireValidSession(sessionToken: string): Promise<void> {
    try {
      await firstValueFrom(
        this.core
          .send(RmqPatterns.GET_SESSION, withRpcSecret({ sessionToken }, this.rpcSecret()))
          .pipe(timeout(8_000)),
      );
    } catch (err) {
      throw sessionCheckError(err);
    }
  }

  async enqueue(input: {
    sessionToken: string;
    nickname: string;
    mode?: MatchMode;
    next?: boolean;
  }): Promise<{ status: 'queued' | 'paired'; pair?: MatchPairView }> {
    await this.requireValidSession(input.sessionToken);
    const mode = parseMode(input.mode);
    const sessionHash = hashToken(input.sessionToken);
    if (input.next) {
      await this.cancelByHash(sessionHash);
    }

    const q = queueKey(mode);
    // A second Find (double click, a retry) must not leave two entries behind.
    await this.removeQueueEntries(sessionHash);

    let peerRaw: string | null = null;
    let peer: QueueEntry | null = null;
    for (let i = 0; i < 32; i += 1) {
      const raw = await this.redis.lpop(q);
      if (!raw) break;
      let candidate: QueueEntry;
      try {
        candidate = JSON.parse(raw) as QueueEntry;
      } catch {
        continue;
      }
      const alive = (await this.redis.exists(`${ALIVE_PREFIX}${candidate.sessionHash}`)) === 1;
      const verdict = judgeCandidate(candidate, {
        selfHash: sessionHash,
        now: Date.now(),
        ttlMs: QUEUE_TTL_MS,
        alive,
      });
      if (verdict === 'self') continue;
      if (verdict !== 'take') {
        await this.redis.del(`${META_PREFIX}${candidate.sessionHash}`);
        continue;
      }
      // Claim: whoever deletes the meta first wins, so a cancel arriving now either
      // beats the pairing (we move on) or loses to it (the pair goes ahead).
      await this.redis.set(`${PAIRING_PREFIX}${candidate.sessionHash}`, '1', 'EX', 30);
      const claimed = await this.redis.del(`${META_PREFIX}${candidate.sessionHash}`);
      if (claimed !== 1) {
        await this.redis.del(`${PAIRING_PREFIX}${candidate.sessionHash}`);
        continue;
      }
      peerRaw = raw;
      peer = candidate;
      break;
    }
    if (!peerRaw || !peer) {
      const entry: QueueEntry = {
        sessionHash,
        nickname: input.nickname,
        mode,
        enqueuedAt: Date.now(),
      };
      await this.redis.rpush(q, JSON.stringify(entry));
      const meta: QueueMeta = { nickname: input.nickname, mode };
      await this.redis.set(
        `${META_PREFIX}${sessionHash}`,
        JSON.stringify(meta),
        'EX',
        MATCH_QUEUE_TTL_SECONDS,
      );
      await this.redis.set(`${ALIVE_PREFIX}${sessionHash}`, '1', 'EX', ALIVE_TTL_SECONDS);
      await this.publish(RmqRoutingKeys.MATCH_QUEUED, { mode });
      matchEnqueueTotal.inc({ mode });
      return { status: 'queued' };
    }

    try {
      const pair = await this.createMatchRoom(
        { ...peer, mode },
        { sessionHash, nickname: input.nickname, mode },
      );
      matchEnqueueTotal.inc({ mode });
      matchPairedTotal.inc({ mode });
      return { status: 'paired', pair };
    } catch (err) {
      // Put the waiter back as they were: entry, meta, no claim.
      await this.redis.lpush(q, peerRaw);
      await this.redis.set(
        `${META_PREFIX}${peer.sessionHash}`,
        JSON.stringify({ nickname: peer.nickname, mode } satisfies QueueMeta),
        'EX',
        MATCH_QUEUE_TTL_SECONDS,
      );
      await this.redis.del(`${PAIRING_PREFIX}${peer.sessionHash}`);
      this.logger.warn(`createMatchRoom failed: ${(err as Error).message}`);
      throw err;
    }
  }

  async cancel(sessionToken: string): Promise<{ ok: boolean }> {
    await this.requireValidSession(sessionToken);
    return this.cancelByHash(hashToken(sessionToken));
  }

  /** Take this session's entries out of every queue (no cancel event). */
  private async removeQueueEntries(sessionHash: string): Promise<void> {
    for (const mode of MATCH_MODES) {
      const items = await this.redis.lrange(queueKey(mode), 0, -1);
      for (const raw of items) {
        try {
          const entry = JSON.parse(raw) as QueueEntry;
          if (entry.sessionHash === sessionHash) {
            await this.redis.lrem(queueKey(mode), 1, raw);
          }
        } catch {
          /* ignore bad entry */
        }
      }
    }
  }

  private async cancelByHash(sessionHash: string): Promise<{ ok: boolean }> {
    for (const mode of MATCH_MODES) {
      const items = await this.redis.lrange(queueKey(mode), 0, -1);
      for (const raw of items) {
        try {
          const entry = JSON.parse(raw) as QueueEntry;
          if (entry.sessionHash === sessionHash) {
            await this.redis.lrem(queueKey(mode), 1, raw);
          }
        } catch {
          /* ignore bad entry */
        }
      }
    }
    await this.redis.del(
      `${META_PREFIX}${sessionHash}`,
      `${RESULT_PREFIX}${sessionHash}`,
      `${ALIVE_PREFIX}${sessionHash}`,
    );
    await this.publish(RmqRoutingKeys.MATCH_CANCELLED, {});
    matchCancelTotal.inc();
    return { ok: true };
  }

  private async createMatchRoom(
    a: QueueEntry,
    b: { sessionHash: string; nickname: string; mode: MatchMode },
  ): Promise<MatchPairView> {
    const mode = b.mode;
    const created = await firstValueFrom(
      this.core
        .send<{ room: RoomView; inviteCode: string }>(
          RmqPatterns.CREATE_MATCH_ROOM,
          withRpcSecret(
            {
              members: [
                { sessionHash: a.sessionHash, nickname: a.nickname },
                { sessionHash: b.sessionHash, nickname: b.nickname },
              ],
              mode,
              expiresInSeconds: MATCH_ROOM_TTL_SECONDS,
            },
            this.rpcSecret(),
          ),
        )
        .pipe(timeout(10_000)),
    );

    const pairForA: MatchPairView = {
      roomId: created.room.id,
      inviteCode: created.inviteCode,
      peerNickname: b.nickname,
      mode,
    };
    const pairForB: MatchPairView = {
      roomId: created.room.id,
      inviteCode: created.inviteCode,
      peerNickname: a.nickname,
      mode,
    };

    // Only the waiting peer needs a RESULT key (they discover via status poll).
    // The enqueuer gets pairForB synchronously — storing RESULT for them made
    // Match "Next" re-open the old room from a stale status read.
    await this.redis.set(`${RESULT_PREFIX}${a.sessionHash}`, JSON.stringify(pairForA), 'EX', 120);
    await this.redis.del(
      `${META_PREFIX}${a.sessionHash}`,
      `${META_PREFIX}${b.sessionHash}`,
      `${PAIRING_PREFIX}${a.sessionHash}`,
      `${ALIVE_PREFIX}${a.sessionHash}`,
      `${ALIVE_PREFIX}${b.sessionHash}`,
    );

    const busKey = this.config.getOrThrow<string>('MESSAGE_ENCRYPTION_KEY');
    await this.publish(RmqRoutingKeys.MATCH_PAIRED, {
      roomId: created.room.id,
      envelope: encryptBusPayload({ roomId: created.room.id, mode }, busKey),
    });

    return pairForB;
  }

  async status(
    sessionToken: string,
  ): Promise<{ status: 'idle' | 'queued' | 'paired'; pair?: MatchPairView; mode?: MatchMode }> {
    await this.requireValidSession(sessionToken);
    const sessionHash = hashToken(sessionToken);
    const result = await this.redis.get(`${RESULT_PREFIX}${sessionHash}`);
    if (result) {
      await this.redis.del(`${RESULT_PREFIX}${sessionHash}`);
      const pair = JSON.parse(result) as MatchPairView;
      if (!pair.mode) pair.mode = 'text';
      return { status: 'paired', pair, mode: pair.mode };
    }
    // Being paired right now: the room is being created, the result follows.
    if ((await this.redis.exists(`${PAIRING_PREFIX}${sessionHash}`)) === 1) {
      return { status: 'queued' };
    }
    const metaRaw = await this.redis.get(`${META_PREFIX}${sessionHash}`);
    if (metaRaw) {
      // Polling is what keeps a waiter "alive" for pairing.
      await this.redis.set(`${ALIVE_PREFIX}${sessionHash}`, '1', 'EX', ALIVE_TTL_SECONDS);
      try {
        const meta = JSON.parse(metaRaw) as QueueMeta;
        return { status: 'queued', mode: parseMode(meta.mode) };
      } catch {
        return { status: 'queued', mode: 'text' };
      }
    }
    // Read-only: no cancel here. Entries without meta are dropped by the next
    // pairing scan; cancelling from a status read raced with Requeue.
    return { status: 'idle' };
  }

  /** Events are best-effort (see BusPublisher). */
  private publish(routingKey: string, payload: unknown): Promise<void> {
    return this.bus.publish(routingKey, payload);
  }
}
