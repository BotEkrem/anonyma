import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusPublisher } from '@anonyma/nest-common';
import { RMQ_EXCHANGE, type RmqRoutingKey } from '@anonyma/shared';
import { busPublishFailuresTotal } from '../metrics/metrics';

/** core's events (rooms, messages, sessions); the rules are BusPublisher's. */
@Injectable()
export class RmqPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly bus: BusPublisher;

  constructor(config: ConfigService) {
    this.bus = new BusPublisher(
      config.get<string>('RABBITMQ_EXCHANGE') ?? RMQ_EXCHANGE,
      (routingKey) => busPublishFailuresTotal.inc({ routing_key: routingKey }),
    );
  }

  onModuleInit(): void {
    this.bus.connect();
  }

  publish(routingKey: RmqRoutingKey, payload: unknown): Promise<void> {
    return this.bus.publish(routingKey, payload);
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.close();
  }
}
