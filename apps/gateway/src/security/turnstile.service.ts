import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCodes } from '@anonyma/shared';
import { turnstileRejectsTotal } from '../metrics/metrics';

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(private readonly config: ConfigService) {}

  private reject(reason: string, message: string): never {
    turnstileRejectsTotal.inc({ reason });
    throw new ForbiddenException({
      statusCode: 403,
      message,
      code: ErrorCodes.VERIFICATION_FAILED,
    });
  }

  async verify(token: string | undefined, _ip?: string): Promise<void> {
    const skip = this.config.get<string>('TURNSTILE_SKIP') === 'true';
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? 'development';
    if (skip) {
      if (nodeEnv === 'production') {
        this.logger.error('TURNSTILE_SKIP=true is forbidden when NODE_ENV=production');
        this.reject('misconfigured', 'Turnstile misconfigured');
      }
      return;
    }

    const secret = this.config.get<string>('TURNSTILE_SECRET_KEY');
    if (!secret) {
      this.logger.warn('TURNSTILE_SECRET_KEY missing; rejecting request');
      this.reject('not_configured', 'Turnstile not configured');
    }
    if (!token) {
      this.reject('missing_token', 'Turnstile token required');
    }

    const body = new URLSearchParams();
    body.set('secret', secret);
    body.set('response', token);
    // Do not forward client IP to Cloudflare (anonymity); token check is enough.

    // Prefer internal allowlisted proxy (gateway stays off edge). Direct URL is for local/dev only.
    const verifyUrl =
      this.config.get<string>('TURNSTILE_VERIFY_URL') ||
      'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    if (
      verifyUrl !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify' &&
      !verifyUrl.startsWith('http://turnstile-proxy:')
    ) {
      this.logger.warn('Refusing non-allowlisted TURNSTILE_VERIFY_URL');
      this.reject('not_configured', 'Turnstile not configured');
    }

    let data: { success?: boolean; hostname?: string };
    try {
      const res = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      data = (await res.json()) as { success?: boolean; hostname?: string };
    } catch (err) {
      this.logger.error(
        `Turnstile siteverify unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.reject('unreachable', 'Turnstile verification unavailable');
    }
    if (!data.success) {
      this.reject('failed', 'Turnstile verification failed');
    }
    // A token solved on another site that uses the same widget key must not count.
    // (Production only: Cloudflare's test keys report a placeholder hostname.)
    const expected =
      this.config.get<string>('NODE_ENV') === 'production' ? this.expectedHostname() : null;
    if (expected && data.hostname && data.hostname !== expected) {
      this.logger.warn('Turnstile token issued for another hostname');
      this.reject('failed', 'Turnstile verification failed');
    }
  }

  /** Host of the public web origin; Turnstile reports where the token was solved. */
  private expectedHostname(): string | null {
    const origin = this.config.get<string>('PUBLIC_WEB_ORIGIN');
    if (!origin) return null;
    try {
      return new URL(origin).hostname;
    } catch {
      return null;
    }
  }
}
