import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import {
  DeleteMessageDto,
  EditMessageDto,
  ListMessagesDto,
  MAX_MESSAGE_LENGTH,
  REACTION_EMOJIS,
  RmqPatterns,
  SendMessageDto,
  hashToken,
  type ReactionEmoji,
} from '@anonyma/shared';
import { clientIp } from '../common/client-ip';
import { GatewayRpc } from '../common/gateway-rpc.service';
import { MessageIdPipe } from '../common/id-pipes';
import { SessionToken } from '../common/session.decorator';
import { RateLimitService } from '../security/rate-limit.service';

/** A class, so ValidationPipe checks it (a plain `{ content: string }` type is skipped). */
class EditMessageBodyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_LENGTH)
  content!: string;
}

class ReactBodyDto {
  @IsIn([...REACTION_EMOJIS])
  emoji!: ReactionEmoji;
}

/** Messages: send, list, edit, delete, react. */
@Controller('api')
export class MessagesController {
  constructor(
    private readonly rpc: GatewayRpc,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('messages')
  @HttpCode(201)
  async sendMessage(
    @SessionToken() token: string,
    @Body() body: SendMessageDto,
    @Req() req: Request,
  ) {
    await this.rateLimit.limitMessage(hashToken(token).slice(0, 16), clientIp(req));
    return this.rpc.core(RmqPatterns.SEND_MESSAGE, {
      sessionToken: token,
      roomId: body.roomId,
      content: body.content,
      replyToId: body.replyToId,
    });
  }

  @Get('messages')
  async listMessages(@SessionToken() token: string, @Query() query: ListMessagesDto) {
    return this.rpc.core(RmqPatterns.LIST_MESSAGES, {
      sessionToken: token,
      roomId: query.roomId,
      limit: query.limit,
      before: query.before,
    });
  }

  @Patch('messages/:messageId')
  async editMessage(
    @SessionToken() token: string,
    @Param('messageId', MessageIdPipe) messageId: string,
    @Body() body: EditMessageBodyDto,
    @Req() req: Request,
  ) {
    await this.rateLimit.limitMessage(hashToken(token).slice(0, 16), clientIp(req));
    const dto: EditMessageDto = { messageId, content: body.content };
    return this.rpc.core(RmqPatterns.EDIT_MESSAGE, {
      sessionToken: token,
      messageId: dto.messageId,
      content: dto.content,
    });
  }

  @Delete('messages/:messageId')
  async deleteMessage(
    @SessionToken() token: string,
    @Param('messageId', MessageIdPipe) messageId: string,
    @Req() req: Request,
  ) {
    await this.rateLimit.limitMessage(hashToken(token).slice(0, 16), clientIp(req));
    const dto: DeleteMessageDto = { messageId };
    return this.rpc.core(RmqPatterns.DELETE_MESSAGE, {
      sessionToken: token,
      messageId: dto.messageId,
    });
  }

  @Post('messages/:messageId/reactions')
  async reactMessage(
    @SessionToken() token: string,
    @Param('messageId', MessageIdPipe) messageId: string,
    @Body() body: ReactBodyDto,
    @Req() req: Request,
  ) {
    await this.rateLimit.limitMessage(hashToken(token).slice(0, 16), clientIp(req));
    return this.rpc.core(RmqPatterns.REACT_MESSAGE, {
      sessionToken: token,
      messageId,
      emoji: body.emoji,
    });
  }
}
