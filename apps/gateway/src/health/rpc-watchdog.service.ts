import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { RpcWatchdog } from '@anonyma/nest-common';

/** gateway calls core and match: restart when a link is stuck (see RpcWatchdog). */
@Injectable()
export class RmqWatchdogService extends RpcWatchdog {
  constructor(
    @Inject('CORE_SERVICE') private readonly core: ClientProxy,
    @Inject('MATCH_SERVICE') private readonly match: ClientProxy,
    config: ConfigService,
  ) {
    super(config);
  }

  protected clients(): ClientProxy[] {
    return [this.core, this.match];
  }
}
