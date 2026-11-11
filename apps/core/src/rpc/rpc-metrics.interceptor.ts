import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { Observable, catchError, finalize, throwError } from 'rxjs';
import { tap } from 'rxjs/operators';
import { rpcDuration, rpcHandledTotal } from '../metrics/metrics';

@Injectable()
export class RpcMetricsInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }
    const raw = this.reflector.get<string | string[]>(PATTERN_METADATA, context.getHandler());
    const pattern = Array.isArray(raw) ? String(raw[0] ?? 'unknown') : String(raw ?? 'unknown');
    const end = rpcDuration.startTimer({ pattern });
    return next.handle().pipe(
      tap(() => rpcHandledTotal.inc({ pattern, result: 'ok' })),
      catchError((err) => {
        rpcHandledTotal.inc({ pattern, result: 'error' });
        return throwError(() => err);
      }),
      finalize(() => end()),
    );
  }
}
