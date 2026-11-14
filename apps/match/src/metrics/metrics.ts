import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'anonyma_match_' });

export const matchEnqueueTotal = new Counter({
  name: 'match_enqueue_total',
  help: 'Match queue enqueues',
  labelNames: ['mode'] as const,
  registers: [registry],
});

export const matchPairedTotal = new Counter({
  name: 'match_paired_total',
  help: 'Successful match pairs',
  labelNames: ['mode'] as const,
  registers: [registry],
});

export const matchCancelTotal = new Counter({
  name: 'match_cancel_total',
  help: 'Match queue cancels',
  registers: [registry],
});

export const matchQueueDepth = new Gauge({
  name: 'match_queue_depth',
  help: 'Current match queue depth by mode',
  labelNames: ['mode'] as const,
  registers: [registry],
});

// Every mode exists from startup at 0: Prometheus' increase() cannot count
// the first event of a series that appears mid-window.
for (const mode of ['text', 'voice', 'video'] as const) {
  matchEnqueueTotal.inc({ mode }, 0);
  matchPairedTotal.inc({ mode }, 0);
}

/** Bus events that could not be published (the request itself still succeeded). */
export const busPublishFailuresTotal = new Counter({
  name: 'bus_publish_failures_total',
  help: 'Events not published to RabbitMQ, by routing key',
  labelNames: ['routing_key'] as const,
  registers: [registry],
});
