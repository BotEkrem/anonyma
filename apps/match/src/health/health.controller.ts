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
    return { status: 'ok', service: 'match' };
  }

  @Get('readyz')
  async readyz() {
    try {
      await firstValueFrom(
        this.core
          .send(
            RmqPatterns.PING,
            withRpcSecret({}, this.config.getOrThrow<string>('INTERNAL_RPC_SECRET')),
          )
          .pipe(timeout(3_000)),
      );
    } catch {
      throw new ServiceUnavailableException('Core RPC not ready');
    }
    return { status: 'ready', service: 'match' };
  }
}
