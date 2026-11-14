import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { mapRpc, rpc } from './rpc.util';

/** RPC to core and match: the shared secret added, a deadline, errors as HTTP. */
@Injectable()
export class GatewayRpc {
  constructor(
    @Inject('CORE_SERVICE') private readonly coreClient: ClientProxy,
    @Inject('MATCH_SERVICE') private readonly matchClient: ClientProxy,
    private readonly config: ConfigService,
  ) {}

  core<T = unknown>(pattern: string, payload: Record<string, unknown>, ms = 10_000): Promise<T> {
    return this.call<T>(this.coreClient, pattern, payload, ms);
  }

  match<T = unknown>(pattern: string, payload: Record<string, unknown>, ms = 10_000): Promise<T> {
    return this.call<T>(this.matchClient, pattern, payload, ms);
  }

  private call<T>(
    client: ClientProxy,
    pattern: string,
    payload: Record<string, unknown>,
    ms: number,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>(pattern, rpc(this.config, payload)).pipe(timeout(ms), mapRpc()),
    );
  }
}
