import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'anonyma_core_' });

export const rpcHandledTotal = new Counter({
  name: 'rpc_handled_total',
  help: 'Core RPC handlers',
  labelNames: ['pattern', 'result'] as const,
  registers: [registry],
});

export const rpcDuration = new Histogram({
  name: 'rpc_duration_seconds',
  help: 'Core RPC handler duration',
  labelNames: ['pattern'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const messagesWrittenTotal = new Counter({
  name: 'messages_written_total',
  help: 'Message mutations',
  labelNames: ['op'] as const,
  registers: [registry],
});

export const roomsCreatedTotal = new Counter({
  name: 'rooms_created_total',
  help: 'Rooms created',
  labelNames: ['type'] as const,
  registers: [registry],
});

// Every known label value exists from startup at 0: Prometheus' increase()
// cannot count the first event of a series that appears mid-window, so a
// series born at 1 left the 24h totals one short.
for (const op of ['send', 'edit', 'delete', 'react'] as const) messagesWrittenTotal.inc({ op }, 0);
for (const type of ['public', 'private', 'match'] as const) roomsCreatedTotal.inc({ type }, 0);

export async function withRpcMetrics<T>(pattern: string, fn: () => Promise<T>): Promise<T> {
  const end = rpcDuration.startTimer({ pattern });
  try {
    const out = await fn();
    rpcHandledTotal.inc({ pattern, result: 'ok' });
    return out;
  } catch (err) {
    rpcHandledTotal.inc({ pattern, result: 'error' });
    throw err;
  } finally {
    end();
  }
}

/** Bus events that could not be published (the request itself still succeeded). */
export const busPublishFailuresTotal = new Counter({
  name: 'bus_publish_failures_total',
  help: 'Events not published to RabbitMQ, by routing key',
  labelNames: ['routing_key'] as const,
  registers: [registry],
});
