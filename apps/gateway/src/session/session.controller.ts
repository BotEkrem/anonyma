import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CreateSessionDto, RmqPatterns } from '@anonyma/shared';
import { clientIp } from '../common/client-ip';
import { GatewayRpc } from '../common/gateway-rpc.service';
import { SessionToken } from '../common/session.decorator';
import { callIdentity } from '../media/call-identity';
import { LiveKitService } from '../media/livekit.service';
import { sessionsCreatedTotal } from '../metrics/metrics';
import { RateLimitService } from '../security/rate-limit.service';
import { TurnstileService } from '../security/turnstile.service';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

/** The anonymous session (its cookie) and the page's public config. */
@Controller('api')
export class SessionController {
  constructor(
    private readonly rpc: GatewayRpc,
    private readonly turnstile: TurnstileService,
    private readonly rateLimit: RateLimitService,
    private readonly livekit: LiveKitService,
    private readonly config: ConfigService,
  ) {}

  @Post('session')
  @HttpCode(201)
  async createSession(
    @Body() body: CreateSessionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req);
    await this.rateLimit.limitSession(ip);
    await this.turnstile.verify(body.turnstileToken, ip);
    const result = await this.rpc.core<{ token: string; view: unknown }>(
      RmqPatterns.CREATE_SESSION,
      {},
    );
    setSessionCookie(this.config, res, result.token);
    sessionsCreatedTotal.inc();
    return { session: result.view };
  }

  @Get('session')
  async getSession(@SessionToken() token: string, @Res({ passthrough: true }) res: Response) {
    try {
      return await this.rpc.core(RmqPatterns.GET_SESSION, { sessionToken: token });
    } catch (err) {
      // Drop stale/invalid cookie so the client can mint a fresh session (FN-09).
      if (err instanceof HttpException && err.getStatus() === 401) {
        clearSessionCookie(this.config, res);
      }
      throw err;
    }
  }

  /**
   * GET /session for a page that only wants to know: "no session" is an
   * answer here (200 { session: null }), not a 401 every browser prints as an
   * error. Same view, same stale-cookie clearing as GET /session.
   */
  @Get('session/current')
  async currentSession(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookieName = this.config.get<string>('SESSION_COOKIE_NAME') ?? 'anonyma_sid';
    const token = req.cookies?.[cookieName] as string | undefined;
    if (!token) {
      return { session: null };
    }
    try {
      const session = await this.rpc.core(RmqPatterns.GET_SESSION, { sessionToken: token });
      return { session };
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 401) {
        clearSessionCookie(this.config, res);
        return { session: null };
      }
      throw err;
    }
  }

  @Delete('session')
  @HttpCode(204)
  async deleteSession(@SessionToken() token: string, @Res({ passthrough: true }) res: Response) {
    // Out of the match queue before the session goes (core leaves the rooms).
    try {
      await this.rpc.match(RmqPatterns.CANCEL_MATCH, { sessionToken: token }, 5_000);
    } catch {
      /* not queued, or match is down: ending the session still goes ahead */
    }
    const out = await this.rpc.core<{ ok: boolean; sessionId?: string | null; roomIds?: string[] }>(
      RmqPatterns.DELETE_SESSION,
      { sessionToken: token },
    );
    // Core left the rooms; take the session out of their calls too.
    if (out.sessionId) {
      for (const roomId of out.roomIds ?? []) {
        await this.livekit.removeParticipant(roomId, callIdentity(out.sessionId, roomId));
      }
    }
    clearSessionCookie(this.config, res);
  }

  @Get('config')
  async publicConfig() {
    const skip = this.config.get<string>('TURNSTILE_SKIP') === 'true';
    const production = (this.config.get<string>('NODE_ENV') ?? 'development') === 'production';
    const voiceConfigured = this.livekit.isConfigured();
    const voiceEnabled = voiceConfigured ? await this.livekit.isAvailable() : false;
    return {
      turnstileSiteKey: this.config.get<string>('TURNSTILE_SITE_KEY') ?? '',
      turnstileRequired: production ? true : !skip,
      wsUrl: this.config.get<string>('PUBLIC_WS_URL') ?? 'ws://localhost:3003/ws',
      messageTtlSeconds: Number(this.config.get('MESSAGE_TTL_SECONDS') ?? 600),
      voiceConfigured,
      voiceEnabled,
    };
  }
}
