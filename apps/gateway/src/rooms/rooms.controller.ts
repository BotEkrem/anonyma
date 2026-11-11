import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsMongoId, IsOptional, IsString, IsUUID } from 'class-validator';
import {
  CreateRoomDto,
  JoinRoomDto,
  LeaveRoomDto,
  ReadReceiptDto,
  RmqPatterns,
  hashToken,
} from '@anonyma/shared';
import { clientIp } from '../common/client-ip';
import { GatewayRpc } from '../common/gateway-rpc.service';
import { RoomIdPipe } from '../common/id-pipes';
import { SessionToken } from '../common/session.decorator';
import { assertMediaMode, callIdentity } from '../media/call-identity';
import { LiveKitService } from '../media/livekit.service';
import { RateLimitService } from '../security/rate-limit.service';
import { TurnstileService } from '../security/turnstile.service';

class JoinRoomBodyDto extends JoinRoomDto {
  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

class ReadBodyDto {
  @IsMongoId()
  messageId!: string;
}

class WsTicketDto {
  @IsUUID()
  roomId!: string;
}

/** Rooms: listing, creating, joining and leaving, members, invites, read marks, socket tickets. */
@Controller('api')
export class RoomsController {
  constructor(
    private readonly rpc: GatewayRpc,
    private readonly turnstile: TurnstileService,
    private readonly rateLimit: RateLimitService,
    private readonly livekit: LiveKitService,
  ) {}

  @Get('rooms')
  async listRooms(@SessionToken() _token: string, @Query('limit') limit?: string) {
    // Session required so public room IDs are not enumerable anonymously (FN-08).
    // Bounded here as well as in core: a bare number from the query string.
    return this.rpc.core(RmqPatterns.LIST_PUBLIC_ROOMS, {
      limit: Math.min(Math.max(Number.parseInt(limit ?? '', 10) || 20, 1), 50),
    });
  }

  @Post('rooms')
  @HttpCode(201)
  async createRoom(
    @SessionToken() token: string,
    @Body() body: CreateRoomDto,
    @Req() req: Request,
  ) {
    const ip = clientIp(req);
    // Cheap refusals first: a rate limit or an unavailable call mode must not use
    // up the person's one-time verification token.
    await this.rateLimit.limitRoom(hashToken(token).slice(0, 16), ip);
    await assertMediaMode(this.livekit, body.mode);
    await this.turnstile.verify(body.turnstileToken, ip);
    return this.rpc.core(RmqPatterns.CREATE_ROOM, {
      sessionToken: token,
      type: body.type,
      mode: body.mode,
      nickname: body.nickname,
    });
  }

  @Post('rooms/join')
  async joinRoom(
    @SessionToken() token: string,
    @Body() body: JoinRoomBodyDto,
    @Req() req: Request,
  ) {
    const ip = clientIp(req);
    // Creator / already-member re-open: skip Turnstile. First-time join still verifies.
    let alreadyMember = false;
    if (body.roomId) {
      try {
        await this.rpc.core(
          RmqPatterns.ASSERT_MEMBERSHIP,
          { roomId: body.roomId, sessionToken: token },
          5_000,
        );
        alreadyMember = true;
      } catch {
        alreadyMember = false;
      }
    }
    await this.rateLimit.limitJoin(hashToken(token).slice(0, 16), ip);
    if (!alreadyMember) {
      await this.turnstile.verify(body.turnstileToken, ip);
    }
    return this.rpc.core(RmqPatterns.JOIN_ROOM, {
      sessionToken: token,
      nickname: body.nickname,
      roomId: body.roomId,
      inviteCode: body.inviteCode,
      slug: body.slug,
    });
  }

  @Post('rooms/leave')
  async leaveRoom(@SessionToken() token: string, @Body() body: LeaveRoomDto) {
    const out = await this.rpc.core<{ ok: boolean; left?: boolean; sessionId?: string }>(
      RmqPatterns.LEAVE_ROOM,
      { sessionToken: token, roomId: body.roomId },
    );
    // Leaving the room ends the person's part in its call too.
    if (out.left && out.sessionId) {
      await this.livekit.removeParticipant(body.roomId, callIdentity(out.sessionId, body.roomId));
    }
    return { ok: true };
  }

  @Get('rooms/:roomId')
  async getRoom(@SessionToken() token: string, @Param('roomId', RoomIdPipe) roomId: string) {
    return this.rpc.core(RmqPatterns.GET_ROOM, { roomId, sessionToken: token });
  }

  @Get('rooms/:roomId/invite')
  async getRoomInvite(@SessionToken() token: string, @Param('roomId', RoomIdPipe) roomId: string) {
    return this.rpc.core(RmqPatterns.GET_ROOM_INVITE, { roomId, sessionToken: token });
  }

  @Get('rooms/:roomId/members')
  async listMembers(@SessionToken() token: string, @Param('roomId', RoomIdPipe) roomId: string) {
    return this.rpc.core(RmqPatterns.LIST_ROOM_MEMBERS, { roomId, sessionToken: token });
  }

  @Post('rooms/:roomId/read')
  async markRead(
    @SessionToken() token: string,
    @Param('roomId', RoomIdPipe) roomId: string,
    @Body() body: ReadBodyDto,
    @Req() req: Request,
  ) {
    await this.rateLimit.limitRead(hashToken(token).slice(0, 16), clientIp(req));
    const dto: ReadReceiptDto = { roomId, messageId: body.messageId };
    return this.rpc.core(RmqPatterns.MARK_READ, {
      sessionToken: token,
      roomId: dto.roomId,
      messageId: dto.messageId,
    });
  }

  @Get('rooms/:roomId/reads')
  async listReads(@SessionToken() token: string, @Param('roomId', RoomIdPipe) roomId: string) {
    return this.rpc.core(RmqPatterns.LIST_READS, { sessionToken: token, roomId });
  }

  @Post('ws-ticket')
  async wsTicket(@SessionToken() token: string, @Body() body: WsTicketDto, @Req() req: Request) {
    await this.rateLimit.limitWsTicket(hashToken(token).slice(0, 16), clientIp(req));
    return this.rpc.core<{ ticket: string; expiresIn: number }>(RmqPatterns.ISSUE_WS_TICKET, {
      sessionToken: token,
      roomId: body.roomId,
    });
  }
}
