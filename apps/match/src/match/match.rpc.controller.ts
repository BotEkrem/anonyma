import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { RmqPatterns } from '@anonyma/shared';
import { MatchService } from './match.service';
import { requireRpcSecret } from '@anonyma/nest-common';

@Controller()
export class MatchRpcController {
  constructor(private readonly match: MatchService) {}

  @MessagePattern(RmqPatterns.PING)
  ping(@Payload() data: { rpcSecret?: string }) {
    requireRpcSecret(data);
    return { ok: true, service: 'match' };
  }

  @MessagePattern(RmqPatterns.ENQUEUE_MATCH)
  enqueue(
    @Payload()
    data: {
      sessionToken: string;
      nickname: string;
      mode?: 'text' | 'voice' | 'video';
      next?: boolean;
      rpcSecret?: string;
    },
  ) {
    requireRpcSecret(data);
    return this.match.enqueue(data);
  }

  @MessagePattern(RmqPatterns.CANCEL_MATCH)
  cancel(@Payload() data: { sessionToken: string; rpcSecret?: string }) {
    requireRpcSecret(data);
    return this.match.cancel(data.sessionToken);
  }

  @MessagePattern(RmqPatterns.MATCH_STATUS)
  status(@Payload() data: { sessionToken: string; rpcSecret?: string }) {
    requireRpcSecret(data);
    return this.match.status(data.sessionToken);
  }
}
