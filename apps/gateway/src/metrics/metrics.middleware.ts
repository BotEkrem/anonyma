import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration, httpRequestsTotal, normalizeHttpRoute } from './metrics';

export function metricsHttpMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/metrics') {
    next();
    return;
  }
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    // The matched route pattern (`/api/rooms/:roomId`), never the raw path: raw
    // paths let anyone mint a new metric series per request (memory growth, and
    // chosen text on the public /monitoring page). Unmatched requests share one.
    const pattern = req.route?.path as string | undefined;
    const route = pattern ? normalizeHttpRoute(`${req.baseUrl || ''}${pattern}`) : 'unmatched';
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe(labels, elapsed);
  });
  next();
}
