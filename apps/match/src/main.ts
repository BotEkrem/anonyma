import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { MATCH_RPC_QUEUE, rmqConnectionOptions } from '@anonyma/shared';
import { AppModule } from './app.module';
import { purgeRpcQueue } from '@anonyma/nest-common';

async function bootstrap(): Promise<void> {
  const { url: rmqUrl, socketOptions } = rmqConnectionOptions();
  await purgeRpcQueue(rmqUrl, MATCH_RPC_QUEUE, socketOptions);

  const port = Number(process.env.MATCH_PORT ?? 3002);
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rmqUrl],
      queue: MATCH_RPC_QUEUE,
      queueOptions: { durable: true },
      noAck: true,
      prefetchCount: 16,
      socketOptions,
    },
  });

  await app.startAllMicroservices();
  await app.listen(port);
   
  console.log(`match listening on :${port}, RMQ queue ${MATCH_RPC_QUEUE}`);
}

bootstrap();
