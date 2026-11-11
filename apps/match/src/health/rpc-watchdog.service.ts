import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { RpcWatchdog } from '@anonyma/nest-common';

/** match calls core: restart when that link is stuck (see RpcWatchdog). */
@Injectable()
export class RmqWatchdogService extends RpcWatchdog {
  constructor(
    @Inject('CORE_SERVICE') private readonly core: ClientProxy,
    config: ConfigService,
  ) {
    super(config);
  }

  protected clients(): ClientProxy[] {
    return [this.core];
  }
}
