import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  CORE_RPC_QUEUE,
  MATCH_RPC_QUEUE,
  rmqConnectionOptions,
  envValidator,
} from '@anonyma/shared';
import { RedisModule } from '@anonyma/nest-common';
import { TurnstileService } from './security/turnstile.service';
import { RateLimitService } from './security/rate-limit.service';
import { LiveKitService } from './media/livekit.service';
import { GatewayRpc } from './common/gateway-rpc.service';
import { MatchController } from './match/match.controller';
import { VoiceController } from './media/voice.controller';
import { MessagesController } from './messages/messages.controller';
import { RoomsController } from './rooms/rooms.controller';
import { SessionController } from './session/session.controller';
import { HealthController } from './health/health.controller';
import { RmqWatchdogService } from './health/rpc-watchdog.service';
import { MonitoringController } from './monitoring/monitoring.controller';
import { MonitoringService } from './monitoring/monitoring.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      // The keys this service is given (deploy/k8s/apps.yaml) and its numbers.
      validate: envValidator({
        requiredInProduction: [
          'INTERNAL_RPC_SECRET',
          'WS_TICKET_SECRET',
          'REDIS_URL',
          'RABBITMQ_URL',
        ],
        positiveInts: ['GATEWAY_PORT', 'MESSAGE_TTL_SECONDS', 'SESSION_TTL_SECONDS'],
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
      {
        name: 'MATCH_SERVICE',
        useFactory: () => {
          const { url, socketOptions } = rmqConnectionOptions();
          return {
            transport: Transport.RMQ,
            options: {
              urls: [url],
              queue: MATCH_RPC_QUEUE,
              queueOptions: { durable: true },
              socketOptions,
            },
          };
        },
      },
    ]),
  ],
  controllers: [
    SessionController,
    RoomsController,
    MessagesController,
    MatchController,
    VoiceController,
    HealthController,
    MonitoringController,
  ],
  providers: [
    GatewayRpc,
    TurnstileService,
    RateLimitService,
    LiveKitService,
    RmqWatchdogService,
    MonitoringService,
  ],
})
export class AppModule {}
