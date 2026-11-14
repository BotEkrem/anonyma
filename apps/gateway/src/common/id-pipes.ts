import { BadRequestException, ParseUUIDPipe, type PipeTransform } from '@nestjs/common';
import { isMongoId } from 'class-validator';
import { ErrorCodes } from '@anonyma/shared';

function invalidId(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: 'Invalid id',
    code: ErrorCodes.INVALID_ID,
  });
}

/**
 * Room ids in the URL are UUIDs. Anything else used to reach Postgres and
 * come back as a 500 (and show on the public monitoring page as an error).
 */
export const RoomIdPipe = new ParseUUIDPipe({ exceptionFactory: invalidId });

/** Message ids in the URL are MongoDB ObjectIds. */
export class MessageIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !isMongoId(value)) throw invalidId();
    return value;
  }
}
