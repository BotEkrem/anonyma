import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { CORE_RPC_QUEUE, rmqConnectionOptions } from '@anonyma/shared';
import { AppModule } from './app.module';
import { runMigrations } from './db/migrations';
import { purgeRpcQueue } from '@anonyma/nest-common';

async function bootstrap(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    // drizzle/ is the schema's only source; a failure stops the pod here.
    await runMigrations(databaseUrl);
  }

  const { url: rmqUrl, socketOptions } = rmqConnectionOptions();
  // Request/response RPC: auto-ack. Purge stale deliveries left by prior crashes.
  await purgeRpcQueue(rmqUrl, CORE_RPC_QUEUE, socketOptions);

  const port = Number(process.env.CORE_PORT ?? 3001);
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: CORE_RPC_QUEUE,
        queueOptions: { durable: true },
        noAck: true,
        prefetchCount: 16,
        socketOptions,
      },
    },
    // The RPC handlers share the app's global enhancers: without this the
    // RpcMetricsInterceptor (APP_INTERCEPTOR) never ran for them, and the
    // rpc_* metrics stayed empty.
    { inheritAppConfig: true },
  );

  await app.startAllMicroservices();
  await app.listen(port);
   
  console.log(`core listening on :${port}, RMQ queue ${CORE_RPC_QUEUE}`);
}

bootstrap();
