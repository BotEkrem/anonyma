import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { isMonitoringSection, MonitoringService, type SectionSnapshot } from './monitoring.service';

/** The numbers behind the site's /monitoring pages (aggregates only). */
@Controller('api')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('monitoring')
  overview(@Res({ passthrough: true }) res: Response): Promise<SectionSnapshot> {
    return this.answer('overview', res);
  }

  @Get('monitoring/:section')
  section(
    @Param('section') section: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SectionSnapshot> {
    return this.answer(section, res);
  }

  private answer(section: string, res: Response): Promise<SectionSnapshot> {
    if (!isMonitoringSection(section)) throw new NotFoundException();
    res.setHeader('Cache-Control', 'public, max-age=15');
    return this.monitoring.snapshot(section);
  }
}
