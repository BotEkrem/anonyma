import type { Request } from 'express';

/** The visitor's IP: ingress's X-Real-IP (from CF-Connecting-IP) before spoofable XFF. */
export function clientIp(req: Request): string {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim().split(',')[0]!.trim();
  }
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) {
    return cf.trim().split(',')[0]!.trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}
