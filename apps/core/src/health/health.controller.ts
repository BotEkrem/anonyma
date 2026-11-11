import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { registry } from '../metrics/metrics';

@Controller()
export class HealthController {
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  }

  @Get('healthz')
  healthz() {
    return { status: 'ok', service: 'core' };
  }

  @Get('readyz')
  readyz() {
    return { status: 'ready', service: 'core' };
  }
}
