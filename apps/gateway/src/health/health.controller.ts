import { Controller, Get, Header, Inject, Res, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { RmqPatterns, withRpcSecret } from '@anonyma/shared';
import type { Response } from 'express';
import { firstValueFrom, timeout } from 'rxjs';
import { registry } from '../metrics/metrics';

@Controller()
export class HealthController {
  constructor(
    @Inject('CORE_SERVICE') private readonly core: ClientProxy,
    @Inject('MATCH_SERVICE') private readonly match: ClientProxy,
    private readonly config: ConfigService,
  ) {}

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  }

  @Get('healthz')
  healthz() {
    return { status: 'ok', service: 'gateway' };
  }

  /** Last readiness answer: /readyz is public, and each check costs two RPCs. */
  private ready: { ok: boolean; at: number; inFlight?: Promise<boolean> } = { ok: false, at: 0 };

  private async checkRpc(): Promise<boolean> {
    const secret = this.config.getOrThrow<string>('INTERNAL_RPC_SECRET');
    try {
      await firstValueFrom(
        this.core.send(RmqPatterns.PING, withRpcSecret({}, secret)).pipe(timeout(3_000)),
      );
      await firstValueFrom(
        this.match.send(RmqPatterns.PING, withRpcSecret({}, secret)).pipe(timeout(3_000)),
      );
      return true;
    } catch {
      return false;
    }
  }

  @Get('readyz')
  async readyz() {
    const now = Date.now();
    if (now - this.ready.at > 5_000) {
      // One check at a time; callers in between share its answer.
      this.ready.inFlight ??= this.checkRpc().then((ok) => {
        this.ready = { ok, at: Date.now() };
        return ok;
      });
      await this.ready.inFlight;
    }
    if (!this.ready.ok) {
      throw new ServiceUnavailableException('RPC not ready');
    }
    return { status: 'ready', service: 'gateway' };
  }
}
