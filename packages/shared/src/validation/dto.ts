import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_MESSAGE_LENGTH, MAX_NICKNAME_LENGTH, MIN_NICKNAME_LENGTH } from '../model/constants';
import { MATCH_MODES, type RoomType } from '../model/types';

export class CreateSessionDto {
  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

export class CreateRoomDto {
  @IsIn(['public', 'private'])
  type!: Exclude<RoomType, 'match'>;

  @IsIn([...MATCH_MODES])
  mode!: (typeof MATCH_MODES)[number];

  @IsString()
  @MinLength(MIN_NICKNAME_LENGTH)
  @MaxLength(MAX_NICKNAME_LENGTH)
  nickname!: string;

  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

export class JoinRoomDto {
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(24)
  inviteCode?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  slug?: string;

  @IsString()
  @MinLength(MIN_NICKNAME_LENGTH)
  @MaxLength(MAX_NICKNAME_LENGTH)
  nickname!: string;
}

export class LeaveRoomDto {
  @IsUUID()
  roomId!: string;
}

export class SendMessageDto {
  @IsUUID()
  roomId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_LENGTH)
  content!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  replyToId?: string;
}

export class EditMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  messageId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_LENGTH)
  content!: string;
}

export class DeleteMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  messageId!: string;
}

export class ReadReceiptDto {
  @IsUUID()
  roomId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  messageId!: string;
}

export class ListMessagesDto {
  @IsUUID()
  roomId!: string;

  /** Query strings arrive as strings — coerce before @IsInt. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** ObjectId cursor — return messages older than this id. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  before?: string;
}

export class EnqueueMatchDto {
  @IsString()
  @MinLength(MIN_NICKNAME_LENGTH)
  @MaxLength(MAX_NICKNAME_LENGTH)
  nickname!: string;

  @IsIn([...MATCH_MODES])
  mode!: (typeof MATCH_MODES)[number];

  @IsOptional()
  @IsBoolean()
  next?: boolean;
}
