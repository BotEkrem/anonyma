import { envValidator } from '@anonyma/shared';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { DatabaseModule } from './db/database.module';
import { MongoModule } from './mongo/mongo.module';
import { RedisModule } from '@anonyma/nest-common';
import { CryptoService } from './crypto/crypto.service';
import { RmqPublisherService } from './rmq/rmq-publisher.service';
import { SessionService } from './session/session.service';
import { RoomService } from './room/room.service';
import { MessageService } from './message/message.service';
import { CoreRpcController } from './rpc/core.rpc.controller';
import { HealthController } from './health/health.controller';
import { PurgeService } from './db/purge.service';
import { RpcMetricsInterceptor } from './rpc/rpc-metrics.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      // The keys this service is given (deploy/k8s/apps.yaml) and its numbers.
      validate: envValidator({
        requiredInProduction: [
          'DATABASE_URL',
          'MONGO_URI',
          'MESSAGE_ENCRYPTION_KEY',
          'INTERNAL_RPC_SECRET',
          'WS_TICKET_SECRET',
          'REDIS_URL',
          'RABBITMQ_URL',
        ],
        positiveInts: [
          'CORE_PORT',
          'MESSAGE_TTL_SECONDS',
          'SESSION_TTL_SECONDS',
          'EMPTY_ROOM_GRACE_SECONDS',
        ],
      }),
    }),
    DatabaseModule,
    MongoModule,
    RedisModule,
  ],
  controllers: [CoreRpcController, HealthController],
  providers: [
    CryptoService,
    RmqPublisherService,
    SessionService,
    RoomService,
    MessageService,
    PurgeService,
    Reflector,
    { provide: APP_INTERCEPTOR, useClass: RpcMetricsInterceptor },
  ],
})
export class AppModule {}
