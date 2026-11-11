import type { MatchMode } from '../api/client';

export interface RoomSessionMeta {
  inviteCode?: string;
  peerNickname?: string;
  nickname?: string;
  mode?: MatchMode;
  roomType?: 'public' | 'private' | 'match';
}

function key(roomId: string): string {
  return `anonyma-room:${roomId}`;
}

export function saveRoomSession(roomId: string, meta: RoomSessionMeta): void {
  try {
    const prev = readRoomSession(roomId) ?? {};
    sessionStorage.setItem(key(roomId), JSON.stringify({ ...prev, ...meta }));
  } catch {
    // ignore quota / private mode
  }
}

export function readRoomSession(roomId: string): RoomSessionMeta | null {
  try {
    const raw = sessionStorage.getItem(key(roomId));
    if (!raw) return null;
    return JSON.parse(raw) as RoomSessionMeta;
  } catch {
    return null;
  }
}

export function clearRoomSession(roomId: string): void {
  try {
    sessionStorage.removeItem(key(roomId));
  } catch {
    // ignore
  }
}
