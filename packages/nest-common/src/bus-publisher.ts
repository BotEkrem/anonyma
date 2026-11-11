import { Logger } from '@nestjs/common';
import amqp, { type AmqpConnectionManager, type ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { BUS_PUBLISH_TIMEOUT_MS, rmqConnectionOptions } from '@anonyma/shared';

/**
 * Publishes events to the topic exchange. Events go out after the change is
 * stored, so a failed publish must not fail the request (a retry would act
 * twice): the wait is bounded (the channel buffers while RabbitMQ is away and
 * would otherwise hang the request), and a failure is logged and reported to
 * onFailure (each service counts it in bus_publish_failures_total). Realtime
 * asks open pages to resync when its own link comes back.
 */
export class BusPublisher {
  private readonly logger = new Logger('BusPublisher');
  private connection: AmqpConnectionManager | null = null;
  private channel: ChannelWrapper | null = null;

  constructor(
    private readonly exchange: string,
    private readonly onFailure: (routingKey: string) => void = () => undefined,
  ) {}

  connect(): void {
    const { url, socketOptions } = rmqConnectionOptions();
    this.connection = amqp.connect([url], socketOptions);
    this.channel = this.connection.createChannel({
      // `json: true` stringifies the content: pass objects, never a Buffer
      // (realtime would get {"type":"Buffer",...} and drop the event).
      json: true,
      setup: async (ch: ConfirmChannel) => {
        await ch.assertExchange(this.exchange, 'topic', { durable: true });
      },
    });
    this.connection.on('connect', () => this.logger.log('Connected to RabbitMQ'));
    this.connection.on('disconnect', (err) =>
      this.logger.warn(`RabbitMQ disconnected: ${err?.err?.message ?? 'unknown'}`),
    );
  }

  async publish(routingKey: string, payload: unknown): Promise<void> {
    try {
      if (!this.channel) throw new Error('publisher not connected');
      await this.channel.publish(this.exchange, routingKey, payload, {
        contentType: 'application/json',
        persistent: false,
        timeout: BUS_PUBLISH_TIMEOUT_MS,
      });
    } catch (err) {
      this.onFailure(routingKey);
      this.logger.error(`Failed to publish ${routingKey}: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
