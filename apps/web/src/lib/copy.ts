import type { MatchMode } from '../api/client';

/**
 * One wording for the three modes on Lobby and Match (they described the same
 * modes differently), with the configured message lifetime.
 */
export const MODE_BLURBS: Record<MatchMode, (minutes: number) => string> = {
  text: (minutes) => `Messages that disappear after ${minutes} minutes.`,
  voice: () => 'Talk live, with text chat beside you.',
  video: () => 'Camera on, with text chat beside you.',
};
