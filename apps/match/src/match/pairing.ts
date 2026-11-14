/** What to do with a waiter popped from the head of a match queue. */
export type CandidateVerdict = 'take' | 'self' | 'stale' | 'gone';

export interface Candidate {
  sessionHash: string;
  enqueuedAt: number;
}

/**
 * - self: the searcher's own old entry; drop it and keep scanning (stopping there
 *   used to requeue the searcher behind a peer who was waiting).
 * - stale: waited past the queue lifetime.
 * - gone: stopped polling (tab closed or reloaded); pairing with them put people
 *   in rooms with nobody.
 */
export function judgeCandidate(
  candidate: Candidate,
  ctx: { selfHash: string; now: number; ttlMs: number; alive: boolean },
): CandidateVerdict {
  if (candidate.sessionHash === ctx.selfHash) return 'self';
  if (ctx.now - (candidate.enqueuedAt || 0) > ctx.ttlMs) return 'stale';
  if (!ctx.alive) return 'gone';
  return 'take';
}
