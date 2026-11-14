import amqp from 'amqplib';
import { rmqAmqpConnectOptions, type RmqSocketOptions } from '@anonyma/shared';

/** Drop leftover RPC deliveries so a crashed noAck consumer cannot sticky-block the queue. */
export async function purgeRpcQueue(
  url: string,
  queue: string,
  socketOptions?: RmqSocketOptions,
): Promise<void> {
  const conn = await amqp.connect(url, rmqAmqpConnectOptions(socketOptions));
  try {
    const ch = await conn.createChannel();
    await ch.assertQueue(queue, { durable: true });
    const purged = await ch.purgeQueue(queue);
    if (purged.messageCount > 0) {
       
      console.warn(`purged ${purged.messageCount} stale message(s) from ${queue}`);
    }
    await ch.close();
  } finally {
    await conn.close();
  }
}
