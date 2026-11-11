import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import {
  EMPTY_ROOM_GRACE_SECONDS,
  encryptBusPayload,
  generateInviteCode,
  MATCH_ROOM_TTL_SECONDS,
  MESSAGE_TTL_SECONDS,
  RmqRoutingKeys,
  safeEqualHex,
  type MatchMode,
  type RoomView,
  type RoomMemberView,
  ErrorCodes,
  type ErrorCode,
} from '@anonyma/shared';
import { CryptoService } from '../crypto/crypto.service';
import { DRIZZLE, type DrizzleDb } from '../db/database.module';
import { isUniqueViolation } from '../db/pg-errors';
import { roomMembers, rooms } from '../db/schema';
import { REDIS } from '@anonyma/nest-common';
import { RmqPublisherService } from '../rmq/rmq-publisher.service';
import { SessionService } from '../session/session.service';
import { roomsCreatedTotal } from '../metrics/metrics';
import { nextExpiry, toMemberViews } from './members';

function rpcError(statusCode: number, message: string, code: ErrorCode): never {
  throw new RpcException({ statusCode, message, code });
}

function slugify(): string {
  return generateInviteCode(10).toLowerCase();
}

@Injectable()
export class RoomService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionService,
    private readonly rmq: RmqPublisherService,
    private readonly config: ConfigService,
  ) {}

  private messageTtlMs(): number {
    return Number(this.config.get('MESSAGE_TTL_SECONDS') ?? MESSAGE_TTL_SECONDS) * 1000;
  }

  private messageTtlSeconds(): number {
    return Number(this.config.get('MESSAGE_TTL_SECONDS') ?? MESSAGE_TTL_SECONDS);
  }

  private emptyRoomGraceMs(): number {
    return Number(this.config.get('EMPTY_ROOM_GRACE_SECONDS') ?? EMPTY_ROOM_GRACE_SECONDS) * 1000;
  }

  private busKey(): string {
    return this.config.getOrThrow<string>('MESSAGE_ENCRYPTION_KEY');
  }

  private inviteRedisKey(roomId: string): string {
    return `room:invite:${roomId}`;
  }

  private async storeInvite(roomId: string, inviteCode: string, ttlSeconds: number): Promise<void> {
    const sealed = this.crypto.sealInvite(inviteCode, roomId);
    await this.redis.set(
      this.inviteRedisKey(roomId),
      sealed,
      'EX',
      Math.max(60, Math.ceil(ttlSeconds)),
    );
  }

  private async clearInvite(roomId: string): Promise<void> {
    await this.redis.del(this.inviteRedisKey(roomId));
  }

  private async publishLifecycle(
    routingKey: typeof RmqRoutingKeys.ROOM_JOINED | typeof RmqRoutingKeys.ROOM_LEFT,
    roomId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Never put plaintext invite codes on the bus — members fetch via HTTP.
    const { inviteCode: _omit, ...safe } = payload;
    await this.rmq.publish(routingKey, {
      roomId,
      envelope: encryptBusPayload({ ...safe, roomId }, this.busKey()),
    });
  }

  /** Keep rooms alive while members are active (chat, WS, or voice). */
  async touchEphemeralExpiry(roomId: string): Promise<void> {
    const [room] = await this.db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (!room) {
      return;
    }
    const ttlMs = this.messageTtlMs();
    // Never shorten: match rooms start with a longer life than the message TTL.
    const expiresAt = nextExpiry(room.expiresAt, Date.now(), ttlMs);
    await this.db.update(rooms).set({ expiresAt }).where(eq(rooms.id, roomId));
    const inviteTtl = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
    const sealed = await this.redis.get(this.inviteRedisKey(roomId));
    if (sealed) {
      await this.redis.expire(this.inviteRedisKey(roomId), Math.max(60, inviteTtl));
    }
  }

  async createRoom(input: {
    sessionToken: string;
    type: 'public' | 'private' | 'match';
    mode?: MatchMode;
    nickname: string;
    expiresInSeconds?: number;
  }): Promise<{ room: RoomView; inviteCode?: string }> {
    const session = await this.sessions.requireSession(input.sessionToken);
    return this.createRoomForSession({
      sessionHash: session.sessionHash,
      sessionId: session.id,
      type: input.type,
      mode: input.mode ?? 'text',
      nickname: input.nickname,
      expiresInSeconds: input.expiresInSeconds,
    });
  }

  /** Privileged path for match service — no raw session tokens required. */
  async createMatchRoom(input: {
    members: Array<{ sessionHash: string; nickname: string }>;
    mode?: MatchMode;
    expiresInSeconds?: number;
  }): Promise<{ room: RoomView; inviteCode: string }> {
    if (input.members.length !== 2) {
      rpcError(400, 'Match rooms require exactly two members', ErrorCodes.BAD_REQUEST);
    }
    const inviteCode = this.crypto.createInviteCode();
    const inviteHash = this.crypto.hashInvite(inviteCode);
    const expiresInSeconds = input.expiresInSeconds ?? MATCH_ROOM_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const mode = input.mode ?? 'text';

    const [room] = await this.db
      .insert(rooms)
      .values({
        slug: slugify(),
        type: 'match',
        mode,
        inviteHash,
        expiresAt,
      })
      .returning();

    for (const member of input.members) {
      await this.db.insert(roomMembers).values({
        roomId: room!.id,
        sessionHash: member.sessionHash,
        nickname: this.crypto.sealNickname(member.nickname.trim(), room!.id),
      });
    }

    await this.storeInvite(room!.id, inviteCode, expiresInSeconds);
    const view = await this.toRoomView(room!.id, inviteCode);
    await this.rmq.publish(RmqRoutingKeys.ROOM_CREATED, {
      roomId: room!.id,
      type: 'match',
      mode,
    });
    roomsCreatedTotal.inc({ type: 'match' });
    return { room: view, inviteCode };
  }

  private async createRoomForSession(input: {
    sessionHash: string;
    sessionId: string;
    type: 'public' | 'private' | 'match';
    mode: MatchMode;
    nickname: string;
    expiresInSeconds?: number;
  }): Promise<{ room: RoomView; inviteCode?: string }> {
    const inviteCode = input.type === 'public' ? undefined : this.crypto.createInviteCode();
    const inviteHash = inviteCode ? this.crypto.hashInvite(inviteCode) : null;
    const ttlSeconds =
      input.expiresInSeconds ??
      (input.type === 'match' ? MATCH_ROOM_TTL_SECONDS : this.messageTtlSeconds());
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const [room] = await this.db
      .insert(rooms)
      .values({
        slug: slugify(),
        type: input.type,
        mode: input.mode,
        inviteHash,
        expiresAt,
      })
      .returning();

    await this.db.insert(roomMembers).values({
      roomId: room!.id,
      sessionHash: input.sessionHash,
      nickname: this.crypto.sealNickname(input.nickname.trim(), room!.id),
    });

    if (inviteCode) {
      await this.storeInvite(room!.id, inviteCode, ttlSeconds);
    }

    const view = await this.toRoomView(room!.id, inviteCode);
    await this.rmq.publish(RmqRoutingKeys.ROOM_CREATED, {
      roomId: room!.id,
      type: room!.type,
      sessionId: input.sessionId,
    });
    await this.publishLifecycle(RmqRoutingKeys.ROOM_JOINED, room!.id, {
      roomId: room!.id,
      sessionId: this.crypto.pseudonym(room!.id, input.sessionHash),
      nickname: input.nickname.trim(),
    });

    roomsCreatedTotal.inc({ type: input.type });
    return { room: view, inviteCode };
  }

  async joinRoom(input: {
    sessionToken: string;
    nickname: string;
    roomId?: string;
    inviteCode?: string;
    slug?: string;
  }): Promise<RoomView> {
    const session = await this.sessions.requireSession(input.sessionToken);
    if (!input.roomId && !input.inviteCode && !input.slug) {
      rpcError(400, 'roomId, inviteCode, or slug required', ErrorCodes.BAD_REQUEST);
    }

    let roomRow;
    if (input.roomId) {
      [roomRow] = await this.db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1);
    } else if (input.slug) {
      [roomRow] = await this.db.select().from(rooms).where(eq(rooms.slug, input.slug)).limit(1);
    } else if (input.inviteCode) {
      const inviteHash = this.crypto.hashInvite(input.inviteCode);
      [roomRow] = await this.db
        .select()
        .from(rooms)
        .where(eq(rooms.inviteHash, inviteHash))
        .limit(1);
    }

    if (!roomRow) {
      rpcError(404, 'Room not found', ErrorCodes.ROOM_NOT_FOUND);
    }
    if (roomRow.expiresAt && roomRow.expiresAt.getTime() < Date.now()) {
      rpcError(404, 'Room expired', ErrorCodes.ROOM_EXPIRED);
    }

    // Private + match always require a valid invite code (timing-safe hash compare).
    if (roomRow.type === 'private' || roomRow.type === 'match') {
      if (!input.inviteCode || !roomRow.inviteHash) {
        rpcError(403, 'Invite required', ErrorCodes.INVITE_REQUIRED);
      }
      const provided = this.crypto.hashInvite(input.inviteCode);
      if (!safeEqualHex(provided, roomRow.inviteHash)) {
        rpcError(403, 'Invalid invite', ErrorCodes.INVITE_INVALID);
      }
    }

    const existing = await this.db
      .select()
      .from(roomMembers)
      .where(
        and(eq(roomMembers.roomId, roomRow.id), eq(roomMembers.sessionHash, session.sessionHash)),
      )
      .limit(1);

    const nick = input.nickname.trim();
    if (existing.length === 0) {
      // Rows of sessions that no longer exist (ended, expired) are ghosts: drop them
      // before counting, so a rejoin with a new session is not "full". Members are
      // never removed by nickname — the default nickname is shared by many people,
      // and that removed the room's creator when an invitee joined.
      await this.db.execute(sql`
        DELETE FROM room_members AS m
        WHERE m.room_id = ${roomRow.id}
          AND NOT EXISTS (
            SELECT 1 FROM anonymous_sessions AS s
            WHERE s.session_hash = m.session_hash AND s.expires_at > now()
          )
      `);
      if (roomRow.type === 'match') {
        const [memberCountRow] = await this.db
          .select({ value: count() })
          .from(roomMembers)
          .where(eq(roomMembers.roomId, roomRow.id));
        if (Number(memberCountRow?.value ?? 0) >= 2) {
          rpcError(403, 'Match room is full', ErrorCodes.ROOM_FULL);
        }
      }

      try {
        await this.db.insert(roomMembers).values({
          roomId: roomRow.id,
          sessionHash: session.sessionHash,
          nickname: this.crypto.sealNickname(nick, roomRow.id),
        });
      } catch (err) {
        // Unique (room_id, session_hash) race: treat as rejoin update. Any other
        // failure is a real error, not a rejoin.
        if (!isUniqueViolation(err, 'room_members_room_session_uidx')) throw err;
        await this.db
          .update(roomMembers)
          .set({ nickname: this.crypto.sealNickname(nick, roomRow.id) })
          .where(
            and(
              eq(roomMembers.roomId, roomRow.id),
              eq(roomMembers.sessionHash, session.sessionHash),
            ),
          );
      }
      await this.publishLifecycle(RmqRoutingKeys.ROOM_JOINED, roomRow.id, {
        roomId: roomRow.id,
        sessionId: this.crypto.pseudonym(roomRow.id, session.sessionHash),
        nickname: nick,
      });
    } else {
      await this.db
        .update(roomMembers)
        .set({ nickname: this.crypto.sealNickname(nick, roomRow.id) })
        .where(eq(roomMembers.id, existing[0]!.id));
    }

    // Rejoining after a leave (or during empty grace) restores normal TTL.
    // Momentary WS drops never remove membership — only explicit leave does.
    await this.touchEphemeralExpiry(roomRow.id);

    // Members who joined with an invite can refresh the current code later via API.
    if (input.inviteCode && (roomRow.type === 'private' || roomRow.type === 'match')) {
      const remainingTtl = roomRow.expiresAt
        ? Math.max(60, Math.ceil((roomRow.expiresAt.getTime() - Date.now()) / 1000))
        : this.messageTtlSeconds();
      await this.storeInvite(roomRow.id, input.inviteCode, remainingTtl);
    }

    return this.toRoomView(roomRow.id);
  }

  /** Returns whether the session was a member (and so actually left) and its id. */
  async leaveRoom(
    sessionToken: string,
    roomId: string,
  ): Promise<{ left: boolean; sessionId: string }> {
    const session = await this.sessions.requireSession(sessionToken);
    const removed = await this.db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.sessionHash, session.sessionHash)))
      .returning({ id: roomMembers.id });
    // Not a member: nothing to do. Before, anyone with the room id could rotate the
    // invite and tell the members their peer had left.
    if (removed.length === 0) {
      return { left: false, sessionId: session.id };
    }

    const [room] = await this.db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    // Rotate invite so a departed peer's code cannot re-enter private/match rooms.
    // Remaining members pull the fresh code via GET invite (never via WS).
    if (room && (room.type === 'private' || room.type === 'match') && room.inviteHash) {
      const nextInvite = this.crypto.createInviteCode();
      await this.db
        .update(rooms)
        .set({ inviteHash: this.crypto.hashInvite(nextInvite) })
        .where(eq(rooms.id, roomId));
      const ttlSeconds = room.expiresAt
        ? Math.max(60, Math.ceil((room.expiresAt.getTime() - Date.now()) / 1000))
        : this.messageTtlSeconds();
      await this.storeInvite(roomId, nextInvite, ttlSeconds);
    }

    const [memberCountRow] = await this.db
      .select({ value: count() })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId));
    const remaining = Number(memberCountRow?.value ?? 0);
    // Last member left: hide from lobby immediately (list filters count>0), keep row
    // briefly so a fast re-join / dual-tab race is not a hard miss.
    if (remaining === 0 && room) {
      await this.db
        .update(rooms)
        .set({ expiresAt: new Date(Date.now() + this.emptyRoomGraceMs()) })
        .where(eq(rooms.id, roomId));
      await this.clearInvite(roomId);
    }

    await this.publishLifecycle(RmqRoutingKeys.ROOM_LEFT, roomId, {
      roomId,
      sessionId: this.crypto.pseudonym(roomId, session.sessionHash),
      // Sealed for realtime only (it cuts this session's live feed and strips the
      // field before anything reaches a client).
      sessionHash: session.sessionHash,
      memberCount: remaining,
      roomType: room?.type,
    });
    return { left: true, sessionId: session.id };
  }

  /** Ending a session leaves its rooms first, so no ghost member stays behind. */
  async leaveAllRooms(
    sessionToken: string,
  ): Promise<{ sessionId: string | null; roomIds: string[] }> {
    if (!sessionToken) return { sessionId: null, roomIds: [] };
    let session;
    try {
      session = await this.sessions.requireSession(sessionToken);
    } catch {
      return { sessionId: null, roomIds: [] };
    }
    const memberships = await this.db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(eq(roomMembers.sessionHash, session.sessionHash));
    const roomIds: string[] = [];
    for (const { roomId } of memberships) {
      const { left } = await this.leaveRoom(sessionToken, roomId);
      if (left) roomIds.push(roomId);
    }
    return { sessionId: session.id, roomIds };
  }

  async getRoom(roomId: string): Promise<RoomView> {
    return this.toRoomView(roomId);
  }

  async getRoomForMember(sessionToken: string, roomId: string): Promise<RoomView> {
    const member = await this.assertMembership(sessionToken, roomId);
    const view = await this.toRoomView(roomId);
    // How this session appears to others here: lets the page tell its own
    // messages, reactions and reads apart without the session's lasting id.
    return { ...view, selfId: this.crypto.pseudonym(roomId, member.sessionHash) };
  }

  async getInviteForMember(sessionToken: string, roomId: string): Promise<{ inviteCode: string }> {
    await this.assertMembership(sessionToken, roomId);
    const sealed = await this.redis.get(this.inviteRedisKey(roomId));
    if (!sealed) {
      rpcError(404, 'Invite not available', ErrorCodes.INVITE_UNAVAILABLE);
    }
    const inviteCode = this.crypto.openInvite(sealed, roomId);
    if (!inviteCode || inviteCode === sealed) {
      rpcError(404, 'Invite not available', ErrorCodes.INVITE_UNAVAILABLE);
    }
    return { inviteCode };
  }

  async listPublicRooms(limit = 20): Promise<RoomView[]> {
    // Empty rooms stay out of the lobby. Membership is not tied to WS presence, so a
    // brief disconnect does not zero the count or drop the room from this list.
    // One query with the counts (it used to cost two more queries per room), and a
    // hard cap whatever the caller asks for.
    const capped = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 50);
    const memberCount = sql<number>`count(${roomMembers.id})`.mapWith(Number);
    const rows = await this.db
      .select({
        id: rooms.id,
        slug: rooms.slug,
        type: rooms.type,
        mode: rooms.mode,
        createdAt: rooms.createdAt,
        expiresAt: rooms.expiresAt,
        memberCount,
      })
      .from(rooms)
      .leftJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .where(
        and(eq(rooms.type, 'public'), or(isNull(rooms.expiresAt), gt(rooms.expiresAt, new Date()))),
      )
      .groupBy(rooms.id)
      .having(sql`count(${roomMembers.id}) > 0`)
      .orderBy(desc(rooms.createdAt))
      .limit(capped);

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      type: r.type,
      mode: r.mode ?? 'text',
      memberCount: r.memberCount,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
    }));
  }

  async listMembers(roomId: string, viewerHash?: string): Promise<RoomMemberView[]> {
    const rows = await this.db.select().from(roomMembers).where(eq(roomMembers.roomId, roomId));
    return toMemberViews(
      rows.map((m) => ({
        sessionHash: m.sessionHash,
        nickname: this.crypto.openNickname(m.nickname, roomId),
        joinedAt: m.joinedAt,
      })),
      viewerHash,
      (hash) => this.crypto.pseudonym(roomId, hash),
    );
  }

  async assertMembership(
    sessionToken: string,
    roomId: string,
  ): Promise<{
    sessionHash: string;
    sessionId: string;
    nickname: string;
  }> {
    const session = await this.sessions.requireSession(sessionToken);
    const [member] = await this.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.sessionHash, session.sessionHash)))
      .limit(1);
    if (!member) {
      rpcError(403, 'Not a room member', ErrorCodes.NOT_ROOM_MEMBER);
    }
    return {
      sessionHash: session.sessionHash,
      sessionId: session.id,
      nickname: this.crypto.openNickname(member.nickname, roomId),
    };
  }

  private async toRoomView(roomId: string, inviteCode?: string): Promise<RoomView> {
    const [room] = await this.db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (!room) {
      rpcError(404, 'Room not found', ErrorCodes.ROOM_NOT_FOUND);
    }
    const [memberCountRow] = await this.db
      .select({ value: count() })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId));

    return {
      id: room.id,
      slug: room.slug,
      type: room.type,
      mode: room.mode ?? 'text',
      inviteCode,
      memberCount: Number(memberCountRow?.value ?? 0),
      createdAt: room.createdAt.toISOString(),
      expiresAt: room.expiresAt?.toISOString() ?? null,
    };
  }
}
