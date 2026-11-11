import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CORE_RPC_QUEUE, rmqConnectionOptions, envValidator } from '@anonyma/shared';
import { RedisModule } from '@anonyma/nest-common';
import { MatchService } from './match/match.service';
import { MatchRpcController } from './match/match.rpc.controller';
import { HealthController } from './health/health.controller';
import { RmqWatchdogService } from './health/rpc-watchdog.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      // The keys this service is given (deploy/k8s/apps.yaml) and its numbers.
      validate: envValidator({
        requiredInProduction: [
          'MESSAGE_ENCRYPTION_KEY',
          'INTERNAL_RPC_SECRET',
          'REDIS_URL',
          'RABBITMQ_URL',
        ],
        positiveInts: ['MATCH_PORT'],
      }),
    }),
    RedisModule,
    ClientsModule.registerAsync([
      {
        name: 'CORE_SERVICE',
        useFactory: () => {
          const { url, socketOptions } = rmqConnectionOptions();
          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              queue: CORE_RPC_QUEUE,
              queueOptions: { durable: true },
              socketOptions,
            },
          };
        },
      },
    ]),
  ],
  controllers: [MatchRpcController, HealthController],
  providers: [MatchService, RmqWatchdogService],
})
export class AppModule {}
