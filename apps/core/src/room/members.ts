import type { RoomMemberView } from '@anonyma/shared';

export interface MemberRow {
  sessionHash: string;
  nickname: string;
  joinedAt: Date;
}

/**
 * One entry per session, oldest first. Members are never merged by nickname:
 * the default nickname is shared by many people, and merging made two people
 * one (and the wrong one "you").
 */
export function toMemberViews(
  rows: MemberRow[],
  viewerHash?: string,
  /** Public id for a session hash (the per-room pseudonym); default: hash prefix. */
  idOf: (sessionHash: string) => string = (hash) => hash.slice(0, 12),
): RoomMemberView[] {
  const bySession = new Map<string, MemberRow>();
  for (const row of rows) {
    const prev = bySession.get(row.sessionHash);
    if (!prev || row.joinedAt.getTime() >= prev.joinedAt.getTime()) {
      bySession.set(row.sessionHash, row);
    }
  }
  return [...bySession.values()]
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
    .map((row) => ({
      sessionId: idOf(row.sessionHash),
      nickname: row.nickname,
      joinedAt: row.joinedAt.toISOString(),
      isSelf: viewerHash ? row.sessionHash === viewerHash : false,
    }));
}

/** Activity may lengthen a room's life, never shorten it (match rooms start longer). */
export function nextExpiry(current: Date | null, now: number, ttlMs: number): Date {
  const proposed = now + ttlMs;
  return new Date(current ? Math.max(current.getTime(), proposed) : proposed);
}
