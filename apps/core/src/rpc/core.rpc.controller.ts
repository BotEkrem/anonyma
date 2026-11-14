import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type Redis from 'ioredis';
import { issueWsTicket, RmqPatterns, verifyWsTicket, wsTicketRedisKey } from '@anonyma/shared';
import { SessionService } from '../session/session.service';
import { RoomService } from '../room/room.service';
import { MessageService } from '../message/message.service';
import { requireRpcSecret } from '@anonyma/nest-common';
import { REDIS } from '@anonyma/nest-common';

@Controller()
export class CoreRpcController {
  constructor(
    private readonly sessions: SessionService,
    private readonly rooms: RoomService,
    private readonly messages: MessageService,
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @MessagePattern(RmqPatterns.PING)
  ping(@Payload() data: { rpcSecret?: string }) {
    requireRpcSecret(data);
    return { ok: true, service: 'core' };
  }

  @MessagePattern(RmqPatterns.CREATE_SESSION)
  async createSession(@Payload() data: { rpcSecret?: string }) {
    requireRpcSecret(data);
    return this.sessions.createSession();
  }

  @MessagePattern(RmqPatterns.GET_SESSION)
  async getSession(@Payload() data: { sessionToken: string; rpcSecret?: string }) {
    requireRpcSecret(data);
    return this.sessions.getSessionView(data.sessionToken);
  }

  @MessagePattern(RmqPatterns.DELETE_SESSION)
  async deleteSession(@Payload() data: { sessionToken: string; rpcSecret?: string }) {
    requireRpcSecret(data);
    // Leave rooms (room.left to the peers) before the session disappears; after it,
    // the page's own leave call gets 401 and the member row stayed as a ghost.
    const { sessionId, roomIds } = await this.rooms.leaveAllRooms(data.sessionToken);
    await this.sessions.deleteSession(data.sessionToken);
    return { ok: true, sessionId, roomIds };
  }

  @MessagePattern(RmqPatterns.CREATE_ROOM)
  async createRoom(
    @Payload()
    data: {
      sessionToken: string;
      type: 'public' | 'private' | 'match';
      mode?: 'text' | 'voice' | 'video';
      nickname: string;
      expiresInSeconds?: number;
      rpcSecret?: string;
    },
  ) {
    requireRpcSecret(data);
    return this.rooms.createRoom(data);
  }

  @MessagePattern(RmqPatterns.CREATE_MATCH_ROOM)
  async createMatchRoom(
    @Payload()
    data: {
      members: Array<{ sessionHash: string; nickname: string }>;
      mode?: 'text' | 'voice' | 'video';
      expiresInSeconds?: number;
      rpcSecret?: string;
    },
  ) {
    requireRpcSecret(data);
    return this.rooms.createMatchRoom(data);
  }

  @MessagePattern(RmqPatterns.JOIN_ROOM)
  async joinRoom(
    @Payload()
    data: {
      sessionToken: string;
      nickname: string;
      roomId?: string;
      inviteCode?: string;
      slug?: string;
      rpcSecret?: string;
    },
  ) {
    requireRpcSecret(data);
    return this.rooms.joinRoom(data);
  }

  @MessagePattern(RmqPatterns.LEAVE_ROOM)
  async leaveRoom(@Payload() data: { sessionToken: string; roomId: string; rpcSecret?: string }) {
    requireRpcSecret(data);
    // The gateway uses this to take the person out of the room's call as well.
    const { left, sessionId } = await this.rooms.leaveRoom(data.sessionToken, data.roomId);
    return { ok: true, left, sessionId };
  }

  @MessagePattern(RmqPatterns.GET_ROOM)
  async getRoom(@Payload() data: { roomId: string; sessionToken: string; rpcSecret?: string }) {
    requireRpcSecret(data);
    return this.rooms.getRoomForMember(data.sessionToken, data.roomId);
  }

  @MessagePattern(RmqPatterns.GET_ROOM_INVITE)
  async getRoomInvite(
    @Payload() data: { roomId: string; sessionToken: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    return this.rooms.getInviteForMember(data.sessionToken, data.roomId);
  }

  @MessagePattern(RmqPatterns.TOUCH_ROOM)
  async touchRoom(@Payload() data: { roomId: string; sessionToken: string; rpcSecret?: string }) {
    requireRpcSecret(data);
    await this.rooms.assertMembership(data.sessionToken, data.roomId);
    await this.rooms.touchEphemeralExpiry(data.roomId);
    return { ok: true };
  }

  @MessagePattern(RmqPatterns.LIST_PUBLIC_ROOMS)
  async listPublicRooms(@Payload() data: { limit?: number; rpcSecret?: string }) {
    requireRpcSecret(data);
    return this.rooms.listPublicRooms(data?.limit ?? 20);
  }

  @MessagePattern(RmqPatterns.LIST_ROOM_MEMBERS)
  async listRoomMembers(
    @Payload() data: { sessionToken: string; roomId: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    const viewer = await this.rooms.assertMembership(data.sessionToken, data.roomId);
    return this.rooms.listMembers(data.roomId, viewer.sessionHash);
  }

  @MessagePattern(RmqPatterns.SEND_MESSAGE)
  async sendMessage(
    @Payload()
    data: {
      sessionToken: string;
      roomId: string;
      content: string;
      replyToId?: string;
      rpcSecret?: string;
    },
  ) {
    requireRpcSecret(data);
    return this.messages.send(data);
  }

  @MessagePattern(RmqPatterns.LIST_MESSAGES)
  async listMessages(
    @Payload()
    data: {
      sessionToken: string;
      roomId: string;
      limit?: number;
      before?: string;
      rpcSecret?: string;
    },
  ) {
    requireRpcSecret(data);
    return this.messages.list(data.sessionToken, data.roomId, data.limit, data.before);
  }

  @MessagePattern(RmqPatterns.EDIT_MESSAGE)
  async editMessage(
    @Payload()
    data: { sessionToken: string; messageId: string; content: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    return this.messages.edit(data);
  }

  @MessagePattern(RmqPatterns.DELETE_MESSAGE)
  async deleteMessage(
    @Payload() data: { sessionToken: string; messageId: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    return this.messages.remove(data);
  }

  @MessagePattern(RmqPatterns.REACT_MESSAGE)
  async reactMessage(
    @Payload()
    data: { sessionToken: string; messageId: string; emoji: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    return this.messages.react(data);
  }

  @MessagePattern(RmqPatterns.MARK_READ)
  async markRead(
    @Payload()
    data: { sessionToken: string; roomId: string; messageId: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    return this.messages.markRead(data);
  }

  @MessagePattern(RmqPatterns.LIST_READS)
  async listReads(
    @Payload() data: { sessionToken: string; roomId: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    return this.messages.listReadsForMember(data.sessionToken, data.roomId);
  }

  @MessagePattern(RmqPatterns.ASSERT_MEMBERSHIP)
  async assertMembership(
    @Payload() data: { sessionToken: string; roomId: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    const member = await this.rooms.assertMembership(data.sessionToken, data.roomId);
    await this.rooms.touchEphemeralExpiry(data.roomId);
    const room = await this.rooms.getRoom(data.roomId);
    return { ...member, roomMode: room.mode };
  }

  @MessagePattern(RmqPatterns.ISSUE_WS_TICKET)
  async issueTicket(
    @Payload() data: { sessionToken: string; roomId: string; rpcSecret?: string },
  ) {
    requireRpcSecret(data);
    const member = await this.rooms.assertMembership(data.sessionToken, data.roomId);
    await this.rooms.touchEphemeralExpiry(data.roomId);
    const secret = this.config.getOrThrow<string>('WS_TICKET_SECRET');
    const ttlSeconds = 60;
    const ticket = issueWsTicket(
      { sessionHash: member.sessionHash, roomId: data.roomId, ttlSeconds },
      secret,
    );
    const claims = verifyWsTicket(ticket, secret);
    await this.redis.set(
      wsTicketRedisKey(claims.jti),
      JSON.stringify({ sessionHash: claims.sessionHash, roomId: claims.roomId }),
      'EX',
      ttlSeconds,
    );
    return { ticket, expiresIn: ttlSeconds };
  }
}
