import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'anonyma_gateway_' });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const rateLimitRejectionsTotal = new Counter({
  name: 'rate_limit_rejections_total',
  help: 'Rate limit rejections by bucket family',
  labelNames: ['bucket'] as const,
  registers: [registry],
});

export const sessionsCreatedTotal = new Counter({
  name: 'sessions_created_total',
  help: 'Anonymous sessions created',
  registers: [registry],
});

export const voiceTokensIssuedTotal = new Counter({
  name: 'voice_tokens_issued_total',
  help: 'LiveKit voice tokens issued',
  registers: [registry],
});

export const turnstileRejectsTotal = new Counter({
  name: 'turnstile_rejects_total',
  help: 'Turnstile verification failures',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** Low-cardinality route template for Prometheus labels. */
export function normalizeHttpRoute(path: string): string {
  const q = path.split('?')[0] || '/';
  return (
    q
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
      .replace(/\/[0-9a-f]{24}\b/gi, '/:id')
      .replace(/\/{2,}/g, '/') || '/'
  );
}

export function rateLimitBucketFromKey(key: string): string {
  const head = key.split(':')[0] || 'unknown';
  if (head.endsWith('ip')) return head.slice(0, -2) || head;
  return head;
}
