import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ClientProxy } from '@nestjs/microservices';
import { RmqPatterns, withRpcSecret } from '@anonyma/shared';
import { firstValueFrom, timeout } from 'rxjs';

/**
 * After core/match RabbitMQ consumers bounce, a Nest ClientProxy can stay stuck
 * on a dead reply channel. Ping the services this one calls every 10 s and exit
 * after three failures in a row (once it has worked), so the pod restarts with
 * a fresh client. Subclasses inject their clients and list them in clients().
 */
export abstract class RpcWatchdog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RpcWatchdog');
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private warmed = false;
  private readonly startedAt = Date.now();

  protected constructor(private readonly config: ConfigService) {}

  protected abstract clients(): ClientProxy[];

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, 10_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    // Grace period while the stack comes up.
    if (Date.now() - this.startedAt < 45_000) return;
    const secret = this.config.getOrThrow<string>('INTERNAL_RPC_SECRET');
    try {
      for (const client of this.clients()) {
        await firstValueFrom(
          client.send(RmqPatterns.PING, withRpcSecret({}, secret)).pipe(timeout(3_000)),
        );
      }
      this.failures = 0;
      this.warmed = true;
    } catch (err) {
      this.failures += 1;
      this.logger.warn(
        `RPC watchdog failure ${this.failures}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (this.warmed && this.failures >= 3) {
        this.logger.error('RPC stuck after a dependency bounce — exiting for a restart');
        process.exit(1);
      }
    }
  }
}
