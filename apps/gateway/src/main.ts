import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { identityPepper } from './common/identity-pepper';

async function bootstrap(): Promise<void> {
  // Fail at boot, not on the first request, when production lacks the pepper.
  identityPepper();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const origin = process.env.PUBLIC_WEB_ORIGIN ?? 'http://localhost:5173';

  // Needed so Turnstile/rate-limit see the real client IP behind CF/ingress.
  app.set('trust proxy', 1);
  // disable() alone is not enough under Nest/Express — strip on every response.
  app.disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.removeHeader('X-Powered-By');
    next();
  });
  app.use(cookieParser());
  const { metricsHttpMiddleware } = await import('./metrics/metrics.middleware');
  app.use(metricsHttpMiddleware);
  app.enableCors({
    origin,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(process.env.GATEWAY_PORT ?? 3000);
  await app.listen(port);

  console.log(`gateway listening on :${port}`);
}

bootstrap();
