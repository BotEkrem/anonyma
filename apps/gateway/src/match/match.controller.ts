import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsOptional, IsString } from 'class-validator';
import { EnqueueMatchDto, RmqPatterns, hashToken } from '@anonyma/shared';
import { clientIp } from '../common/client-ip';
import { GatewayRpc } from '../common/gateway-rpc.service';
import { SessionToken } from '../common/session.decorator';
import { assertMediaMode } from '../media/call-identity';
import { LiveKitService } from '../media/livekit.service';
import { RateLimitService } from '../security/rate-limit.service';

class EnqueueMatchBodyDto extends EnqueueMatchDto {
  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

/** The random-match queue (served by the match service). */
@Controller('api')
export class MatchController {
  constructor(
    private readonly rpc: GatewayRpc,
    private readonly rateLimit: RateLimitService,
    private readonly livekit: LiveKitService,
  ) {}

  @Post('match')
  async enqueueMatch(
    @SessionToken() token: string,
    @Body() body: EnqueueMatchBodyDto,
    @Req() req: Request,
  ) {
    const ip = clientIp(req);
    // Match queue / requeue / next: session + rate-limit only (no mid-search Turnstile).
    await this.rateLimit.limitMatch(hashToken(token).slice(0, 16), ip);
    await assertMediaMode(this.livekit, body.mode);
    return this.rpc.match(
      RmqPatterns.ENQUEUE_MATCH,
      {
        sessionToken: token,
        nickname: body.nickname,
        mode: body.mode,
        next: body.next,
      },
      15_000,
    );
  }

  @Post('match/cancel')
  async cancelMatch(@SessionToken() token: string) {
    return this.rpc.match(RmqPatterns.CANCEL_MATCH, { sessionToken: token });
  }

  @Get('match/status')
  async matchStatus(@SessionToken() token: string) {
    return this.rpc.match(RmqPatterns.MATCH_STATUS, { sessionToken: token });
  }
}
