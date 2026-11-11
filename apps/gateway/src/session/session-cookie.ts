import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

function cookieOptions(config: ConfigService) {
  return {
    name: config.get<string>('SESSION_COOKIE_NAME') ?? 'anonyma_sid',
    secure: config.get<string>('COOKIE_SECURE') === 'true',
    domain: config.get<string>('COOKIE_DOMAIN') || undefined,
  };
}

export function setSessionCookie(config: ConfigService, res: Response, token: string): void {
  const { name, secure, domain } = cookieOptions(config);
  const maxAge = Number(config.get('SESSION_TTL_SECONDS') ?? 86_400) * 1000;
  res.cookie(name, token, { httpOnly: true, secure, sameSite: 'lax', maxAge, domain, path: '/' });
}

export function clearSessionCookie(config: ConfigService, res: Response): void {
  const { name, secure, domain } = cookieOptions(config);
  res.clearCookie(name, { httpOnly: true, secure, sameSite: 'lax', domain, path: '/' });
}
