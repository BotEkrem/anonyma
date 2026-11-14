import { ErrorCodes } from '@anonyma/shared';
import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/** Cookie-only session — no header bypass of HttpOnly. */
export const SessionToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const cookieName = process.env.SESSION_COOKIE_NAME ?? 'anonyma_sid';
    const token = req.cookies?.[cookieName] as string | undefined;
    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Session required',
        code: ErrorCodes.SESSION_REQUIRED,
      });
    }
    return token;
  },
);
