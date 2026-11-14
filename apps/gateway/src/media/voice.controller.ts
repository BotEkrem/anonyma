import { Body, Controller, HttpException, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsOptional, IsString } from 'class-validator';
import { ErrorCodes, RmqPatterns, hashToken } from '@anonyma/shared';
import { clientIp } from '../common/client-ip';
import { GatewayRpc } from '../common/gateway-rpc.service';
import { RoomIdPipe } from '../common/id-pipes';
import { SessionToken } from '../common/session.decorator';
import { voiceTokensIssuedTotal } from '../metrics/metrics';
import { RateLimitService } from '../security/rate-limit.service';
import { callIdentity } from './call-identity';
import { LiveKitService } from './livekit.service';

class VoiceJoinBodyDto {
  @IsOptional()
  @IsString()
  nickname?: string;
}

/** Joining a room's voice or video call (a LiveKit token). */
@Controller('api')
export class VoiceController {
  constructor(
    private readonly rpc: GatewayRpc,
    private readonly rateLimit: RateLimitService,
    private readonly livekit: LiveKitService,
  ) {}

  @Post('rooms/:roomId/voice')
  async joinVoice(
    @SessionToken() token: string,
    @Param('roomId', RoomIdPipe) roomId: string,
    @Body() _body: VoiceJoinBodyDto,
    @Req() req: Request,
  ) {
    const ip = clientIp(req);
    await this.rateLimit.limitVoice(hashToken(token).slice(0, 16), ip);
    // Membership + server nickname (ignore client-supplied display name).
    const member = await this.rpc.core<{ sessionId: string; nickname: string; roomMode?: string }>(
      RmqPatterns.ASSERT_MEMBERSHIP,
      { roomId, sessionToken: token },
    );
    // Call tokens only for voice / video rooms: a text room's members got them too.
    if (member.roomMode === 'text') {
      throw new HttpException(
        { statusCode: 403, message: 'This room has no calls', code: ErrorCodes.ROOM_HAS_NO_CALLS },
        HttpStatus.FORBIDDEN,
      );
    }
    await this.rpc.core(RmqPatterns.TOUCH_ROOM, { roomId, sessionToken: token });
    const tokenOut = await this.livekit.issueJoinToken({
      roomId,
      // Room-scoped opaque id — not the durable session UUID.
      identity: callIdentity(member.sessionId, roomId),
      nickname: (member.nickname ?? 'anon').trim() || 'anon',
    });
    voiceTokensIssuedTotal.inc();
    return tokenOut;
  }
}
