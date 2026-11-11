import { BadRequestException } from '@nestjs/common';
import { ErrorCodes, livekitIdentity } from '@anonyma/shared';
import { identityPepper } from '../common/identity-pepper';
import type { LiveKitService } from './livekit.service';

/** A session's room-scoped LiveKit identity (joining and removal must agree). */
export function callIdentity(sessionId: string, roomId: string): string {
  return livekitIdentity(sessionId, roomId, identityPepper());
}

/** Voice and video need LiveKit up; text never does. */
export async function assertMediaMode(livekit: LiveKitService, mode?: string): Promise<void> {
  if ((mode === 'voice' || mode === 'video') && !(await livekit.isAvailable())) {
    throw new BadRequestException({
      statusCode: 400,
      message: 'Live media is not available right now. Pick text.',
      code: ErrorCodes.MEDIA_UNAVAILABLE,
    });
  }
}
